import { SvelteMap } from 'svelte/reactivity';
import { MqttWrapper } from '../mqtt/client.ts';
import type { ConnectionState } from '../mqtt/types.ts';
import {
  parseTopic,
  groupsFilter,
  settingsTopic,
  groupTopic,
  wordsFilter,
  srsFilter,
  wordTopic,
  srsTopic,
} from '../mqtt/topics.ts';
import type { Group, Settings, SrsState, Word, Grade } from '../types.ts';
import { defaultSettings, defaultSrs } from '../types.ts';
import { applyGrade } from '../srs/picker.ts';
import * as creds from '../storage/credentials.ts';
import type { StoredConnection } from '../storage/credentials.ts';
import { queue } from '../mqtt/queue.ts';
import { isGroup, isWord, isSrsState, isSettings } from '../validators.ts';
import { decodeShare, encodeShare, type SharePayload } from '../share.ts';
import { exportAll as exportAllOverNewClient, exportFilename, triggerDownload } from '../export.ts';
import { parseImportFile } from '../import.ts';
import {
  type Intent,
  type ModalState,
  type PickerReturn,
  type View,
  readIntent,
  reconcileOnPop,
  STATE_KEY as HISTORY_STATE_KEY,
} from '../history.ts';

const SHARE_HASH_PREFIX = '#share=';

const SYNC_DEBOUNCE_MS = 500;

function parseUP(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

class AppStore {
  connection = $state<ConnectionState>('idle');
  connectionError = $state<string | null>(null);
  publishError = $state<string | null>(null);
  nextAttemptAt = $state<number | null>(null);

  groups = new SvelteMap<string, Group>();
  settings = $state<Settings>(defaultSettings());

  activeGroupId = $state<string | null>(null);
  words = new SvelteMap<string, Word>();
  srs = new SvelteMap<string, SrsState>();

  view = $state<View>('connect');
  switching = $state(false);
  // When the picker is opened via the nav-bar "switch group" affordance,
  // record where to return to on cancel. Null when the picker is
  // reached as the natural post-connect landing (no group to go back
  // to), so the Back button stays hidden.
  pickerReturn = $state<PickerReturn | null>(null);
  // Hoisted modal state (word editor, group rename). Components read this
  // to decide what to render; entering/leaving a modal always goes through
  // pushIntent / goBack so back-button and ✖ share a path.
  modal = $state<ModalState | null>(null);
  // Set by init() if the page was opened with a `#share=` hash. Carries
  // the imported broker URL / username / password / prefix the form
  // should pre-fill from. Cleared after the user submits (so the next
  // mount of the form falls back to localStorage).
  shareImport = $state<SharePayload | null>(null);

  private mqtt: MqttWrapper | null = null;
  private storedConn: StoredConnection | null = null;
  private historyListenerInstalled = false;

  // Tombstone watermarks. Map<id, lastTombstoneTimestampSec>. In-memory
  // only — survives reconnects within a session, lost on reload. Stops
  // a peer's stale content publish from resurrecting a tombstoned id
  // while we're still online. See design.md → Application lifecycle
  // step 9, "Tombstone watermark".
  private wordWatermark = new Map<string, number>();
  private srsWatermark = new Map<string, number>();

  private syncResolve: (() => void) | null = null;
  private syncTimer: number | null = null;

  init(): void {
    this.storedConn = creds.read();
    void queue.init();
    // Share-link arrival: pre-fill the form from the URL hash and skip
    // autoconnect so the user can review the incoming creds before
    // committing. Hash is scrubbed so it doesn't sit in the address
    // bar / browser history.
    const shared = this.consumeShareHash();
    if (shared) {
      this.shareImport = shared;
    }
    // Seed history with the initial intent. Either the boot enters via the
    // connect form (default) or, if autoconnect fires below, the post-
    // connect transition will pushIntent on top of this seed — so back
    // from a connected view returns to the connect form.
    this.replaceIntent({ view: 'connect' });
    this.installHistoryListener();
    if (shared) return;
    if (this.storedConn?.autoconnect) {
      this.connect(this.storedConn);
    }
  }

  // History-state mutators. Components and store internals route every
  // navigation through these; never assign view / modal / pickerReturn
  // directly outside of applyIntent.
  pushIntent(next: Intent): void {
    this.applyIntent(next);
    if (typeof window === 'undefined') return;
    window.history.pushState({ [HISTORY_STATE_KEY]: next }, '');
  }

  replaceIntent(next: Intent): void {
    this.applyIntent(next);
    if (typeof window === 'undefined') return;
    window.history.replaceState({ [HISTORY_STATE_KEY]: next }, '');
  }

  // Navigate one step back; popstate does the actual store mutation.
  goBack(): void {
    if (typeof window === 'undefined') return;
    window.history.back();
  }

  // Apply an intent to the store's runes. No history side effects.
  private applyIntent(next: Intent): void {
    this.view = next.view;
    this.modal = next.modal ?? null;
    this.pickerReturn = next.view === 'picker' ? (next.pickerReturn ?? null) : null;
  }

  private installHistoryListener(): void {
    if (typeof window === 'undefined') return;
    if (this.historyListenerInstalled) return;
    this.historyListenerInstalled = true;
    window.history.scrollRestoration = 'manual';
    window.addEventListener('popstate', (e) => this.handlePopstate(e));
  }

  private handlePopstate(e: PopStateEvent): void {
    const popped = readIntent(e.state);
    if (!popped) {
      // No mwords intent on this entry — pretend we're back at the seed.
      this.replaceIntent({ view: 'connect' });
      return;
    }
    const r = reconcileOnPop(popped, {
      connected: this.connection === 'connected',
      hasActiveGroup: this.activeGroupId !== null,
    });
    if (r.action === 'reset-to-connect') {
      this.replaceIntent({ view: 'connect' });
      return;
    }
    this.applyIntent(r.intent);
  }

  // Convenience helpers used by views/components. Each one is a single
  // pushIntent call, but giving them names keeps call sites self-documenting.
  navTo(v: 'review' | 'edit' | 'settings'): void {
    if (this.view === v && this.modal === null) return;
    this.pushIntent({ view: v });
  }

  openWordEditor(wordId?: string): void {
    this.pushIntent({ view: 'edit', modal: { kind: 'word-editor', wordId } });
  }

  openRenameGroup(groupId: string): void {
    this.pushIntent({
      view: 'picker',
      modal: { kind: 'rename-group', groupId },
      pickerReturn: this.pickerReturn ?? undefined,
    });
  }

  private consumeShareHash(): SharePayload | null {
    if (typeof window === 'undefined') return null;
    const h = window.location.hash;
    if (!h.startsWith(SHARE_HASH_PREFIX)) return null;
    const decoded = decodeShare(h.slice(SHARE_HASH_PREFIX.length));
    // Always scrub the hash, even on decode failure — a malformed share
    // shouldn't stick around.
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return decoded;
  }

  buildShareUrl(): string | null {
    const conn = this.storedConn;
    if (!conn) return null;
    const encoded = encodeShare({
      url: conn.url,
      username: conn.username,
      password: conn.password,
      prefix: conn.prefix,
    });
    if (typeof window === 'undefined') return null;
    const { origin, pathname } = window.location;
    return `${origin}${pathname}${SHARE_HASH_PREFIX}${encoded}`;
  }

  connect(conn: StoredConnection): void {
    this.shareImport = null;
    const existing = creds.read();
    const preserveLast =
      existing &&
      existing.prefix === conn.prefix &&
      existing.url === conn.url &&
      existing.username === conn.username &&
      existing.lastGroup;
    const merged: StoredConnection = preserveLast
      ? { ...conn, lastGroup: existing.lastGroup }
      : conn;
    creds.write(merged);
    this.storedConn = merged;
    this.connectionError = null;
    this.groups.clear();
    this.words.clear();
    this.srs.clear();
    this.wordWatermark.clear();
    this.srsWatermark.clear();
    this.activeGroupId = null;
    this.settings = defaultSettings();

    this.mqtt?.disconnect();
    this.mqtt = new MqttWrapper(
      (msg) => this.handleMessage(msg.topic, msg.payload, msg.timestampUP),
      (state, err) => this.handleState(state, err),
      (nextAttemptAt) => (this.nextAttemptAt = nextAttemptAt),
    );
    queue.setPublisher((topic, data, opts, cb) => this.mqtt!.publishRaw(topic, data, opts, cb));
    this.mqtt.connect(conn);
  }

  disconnect(): void {
    this.cancelSync();
    queue.setPublisher(null);
    void queue.onClose();
    this.mqtt?.disconnect();
    this.mqtt = null;
    this.groups.clear();
    this.words.clear();
    this.srs.clear();
    this.wordWatermark.clear();
    this.srsWatermark.clear();
    this.activeGroupId = null;
    this.settings = defaultSettings();
    this.connection = 'idle';
    this.connectionError = null;
    this.nextAttemptAt = null;
    if (this.storedConn?.autoconnect) {
      this.storedConn = { ...this.storedConn, autoconnect: false };
      creds.update({ autoconnect: false });
    }
    this.replaceIntent({ view: 'connect' });
  }

  async disconnectAndForget(): Promise<void> {
    this.disconnect();
    await queue.clear();
    creds.forget();
    this.storedConn = null;
  }

  private handleState(state: ConnectionState, err?: Error): void {
    this.connection = state;
    if (state === 'error' && err) this.connectionError = err.message;
    if (state === 'connected') {
      this.connectionError = null;
      void queue.onConnect();
      void this.afterConnect();
    } else if (state === 'reconnecting') {
      this.cancelSync();
      void queue.onClose();
    }
  }

  private async afterConnect(): Promise<void> {
    if (!this.mqtt || !this.storedConn) return;
    const prefix = this.storedConn.prefix;
    // Drain pending intents before subscribing. Guarantees the broker
    // holds our latest values by the time retained replay reaches us.
    await queue.drainAll();
    if (!this.mqtt) return;
    await this.subscribeAndSync([groupsFilter(prefix), settingsTopic(prefix)]);
    if (!this.mqtt) return;

    if (this.view === 'connect' || this.view === 'picker') {
      this.afterPhase1();
      return;
    }
    // Reconnect path — we were already in a group view. Re-subscribe
    // phase-2 for the active group (also handles the offline-create
    // case where phase-2 was deferred until first connect).
    if (this.activeGroupId) {
      await this.subscribeAndSync([
        wordsFilter(prefix, this.activeGroupId),
        srsFilter(prefix, this.activeGroupId),
      ]);
    }
  }

  private afterPhase1(): void {
    if (!this.storedConn) return;
    if (this.view !== 'connect' && this.view !== 'picker') return;
    const last = this.storedConn.lastGroup;
    if (last && this.groups.has(last)) {
      void this.selectGroup(last);
    } else {
      if (last && !this.groups.has(last)) creds.clearLastGroup();
      // Connect → picker is a forward step in the back stack.
      this.pushIntent({ view: 'picker' });
    }
  }

  private async subscribeAndSync(filters: string[]): Promise<void> {
    if (!this.mqtt) return;
    await this.mqtt.subscribeMany(filters);
    await new Promise<void>((resolve) => {
      this.syncResolve = resolve;
      this.kickSyncDebounce();
    });
  }

  private kickSyncDebounce(): void {
    if (this.syncResolve === null) return;
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      const r = this.syncResolve;
      this.syncResolve = null;
      r?.();
    }, SYNC_DEBOUNCE_MS);
  }

  private cancelSync(): void {
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.syncResolve) {
      const r = this.syncResolve;
      this.syncResolve = null;
      r();
    }
  }

  // LWW gate per design step 9.
  // Returns true if the incoming message should be applied, given:
  //   - localUpdated: undefined / 0-sentinel / positive number from the
  //     local record (or settings.updated for the singleton).
  //   - watermarkAt: the tombstone watermark for this id (Map.get
  //     yields undefined if absent). Only consulted when the local
  //     record is missing/sentinel.
  //   - incomingUP: number parsed from the timestamp User Property, or
  //     null if absent / unusable.
  private acceptByGate(
    localUpdated: number | undefined,
    watermarkAt: number | undefined,
    incomingUP: number | null,
  ): boolean {
    if (incomingUP === null) return true;
    if (localUpdated !== undefined && localUpdated > 0) {
      return incomingUP >= localUpdated;
    }
    // No local record (or sentinel 0). Consult the watermark.
    if (watermarkAt !== undefined) {
      return incomingUP > watermarkAt;
    }
    return true;
  }

  private handleMessage(topic: string, payload: Uint8Array, timestampUP?: string): void {
    if (!this.storedConn) return;
    const parsed = parseTopic(this.storedConn.prefix, topic);
    const up = parseUP(timestampUP);

    this.kickSyncDebounce();

    // Tombstone path — zero-byte short-circuit. The LWW gate runs on
    // the raw UP; no JSON.parse, no type guard.
    if (payload.byteLength === 0) {
      if (parsed.kind === 'word') {
        const local = this.words.get(parsed.id);
        if (!this.acceptByGate(local?.updated, this.wordWatermark.get(parsed.id), up)) return;
        this.words.delete(parsed.id);
        if (up !== null) this.wordWatermark.set(parsed.id, up);
      } else if (parsed.kind === 'srs') {
        const local = this.srs.get(parsed.id);
        if (!this.acceptByGate(local?.updated, this.srsWatermark.get(parsed.id), up)) return;
        this.srs.delete(parsed.id);
        if (up !== null) this.srsWatermark.set(parsed.id, up);
      } else if (parsed.kind === 'group') {
        const local = this.groups.get(parsed.gid);
        if (!this.acceptByGate(local?.updated, undefined, up)) return;
        this.groups.delete(parsed.gid);
      }
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      console.warn('mwords: bad JSON at', topic);
      return;
    }

    if (parsed.kind === 'group') {
      if (!isGroup(data, parsed.gid)) {
        console.warn('mwords: invalid Group at', topic);
        return;
      }
      const local = this.groups.get(data.id);
      if (!this.acceptByGate(local?.updated, undefined, up)) return;
      this.groups.set(data.id, data);
    } else if (parsed.kind === 'settings') {
      if (!isSettings(data)) {
        console.warn('mwords: invalid Settings at', topic);
        return;
      }
      if (!this.acceptByGate(this.settings.updated, undefined, up)) return;
      this.settings = data;
    } else if (parsed.kind === 'word') {
      if (this.activeGroupId !== parsed.gid) return;
      if (!isWord(data, parsed.id)) {
        console.warn('mwords: invalid Word at', topic);
        return;
      }
      const local = this.words.get(data.id);
      if (!this.acceptByGate(local?.updated, this.wordWatermark.get(data.id), up)) return;
      this.words.set(data.id, data);
      // Content accepted → drop watermark (the local record's own
      // `updated` is now the comparison point).
      this.wordWatermark.delete(data.id);
    } else if (parsed.kind === 'srs') {
      if (this.activeGroupId !== parsed.gid) return;
      if (!isSrsState(data, parsed.id)) {
        console.warn('mwords: invalid SrsState at', topic);
        return;
      }
      const local = this.srs.get(data.id);
      if (!this.acceptByGate(local?.updated, this.srsWatermark.get(data.id), up)) return;
      this.srs.set(data.id, data);
      this.srsWatermark.delete(data.id);
    }
  }

  async createGroup(name: string): Promise<void> {
    if (!this.storedConn) throw new Error('not connected');
    const trimmed = name.trim();
    if (!trimmed) throw new Error('name required');
    const tmNow = Date.now();
    const id = tmNow.toString();
    const ts = tmNow / 1000;
    const group: Group = { id, name: trimmed, created: ts, updated: ts };
    this.groups.set(id, group);
    try {
      await queue.publishIntent(groupTopic(this.storedConn.prefix, id), group);
    } catch (err) {
      this.groups.delete(id);
      this.publishError = (err as Error).message;
      throw err;
    }
    await this.selectGroup(id);
  }

  async renameGroup(id: string, name: string): Promise<void> {
    if (!this.storedConn) throw new Error('not connected');
    const existing = this.groups.get(id);
    if (!existing) throw new Error('group missing');
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 256) {
      throw new Error('name must be 1-256 chars');
    }
    if (trimmed === existing.name) return;
    const next: Group = {
      ...existing,
      name: trimmed,
      updated: Date.now() / 1000,
    };
    this.groups.set(id, next);
    try {
      await queue.publishIntent(groupTopic(this.storedConn.prefix, id), next);
    } catch (err) {
      this.groups.set(id, existing);
      this.publishError = (err as Error).message;
      throw err;
    }
  }

  async deleteGroup(id: string): Promise<void> {
    if (!this.storedConn) throw new Error('not connected');
    const existing = this.groups.get(id);
    if (!existing) return;
    const prefix = this.storedConn.prefix;

    // Optimistic local cleanup. We don't try to restore on publish
    // failure: the user intent was to delete, and the tombstones live
    // in the durable queue (they'll flush on the next connect).
    const wasActive = this.activeGroupId === id;
    this.groups.delete(id);
    if (wasActive) {
      if (this.mqtt?.isConnected() === true) {
        await this.mqtt.unsubscribeMany([wordsFilter(prefix, id), srsFilter(prefix, id)]);
      }
      this.words.clear();
      this.srs.clear();
      this.activeGroupId = null;
      creds.clearLastGroup();
      // The "return to previous view" handle is dead — that view referenced
      // the now-deleted group. Replace the current picker entry to drop it
      // along with any stale modal flag.
      this.replaceIntent({ view: 'picker' });
    } else if (this.storedConn.lastGroup === id) {
      creds.clearLastGroup();
    }

    // Two tombstones:
    //   1. `<P>/g/<G>/#` — broker-specific subtree wipe. flespi
    //      treats a retained empty publish to a wildcard topic as
    //      "clear all retained under this prefix" (non-standard MQTT
    //      extension). On brokers without this behavior the publish
    //      may be rejected or stored as a literal "#" topic; words
    //      and srs retained messages are then orphaned. Acceptable
    //      for v1 — documented in design.md.
    //   2. `<P>/g/<G>` — the group marker itself.
    try {
      await queue.publishTombstone(`${prefix}/g/${id}/#`);
      await queue.publishTombstone(groupTopic(prefix, id));
    } catch (err) {
      this.publishError = (err as Error).message;
      throw err;
    }
  }

  async exportAll(): Promise<{ filename: string; groupCount: number; wordCount: number }> {
    if (!this.storedConn) throw new Error('not connected');
    // Note: the *execution* gate is the fresh-client connect inside
    // exportAllOverNewClient. The UI gates on `connection` separately
    // so the button is visibly disabled when offline; this throw
    // covers the race where the user clicks just as the live link
    // drops.
    if (this.connection !== 'connected') {
      throw new Error('Connect to the broker before exporting.');
    }
    const payload = await exportAllOverNewClient(this.storedConn);
    const filename = exportFilename();
    triggerDownload(filename, JSON.stringify(payload));
    let wordCount = 0;
    for (const g of payload.groups) wordCount += g.words.length;
    return { filename, groupCount: payload.groups.length, wordCount };
  }

  async importAll(fileText: string): Promise<{ groupCount: number; wordCount: number }> {
    if (!this.storedConn) throw new Error('not connected');
    if (this.connection !== 'connected') {
      throw new Error('Connect to the broker before importing.');
    }
    const parsed = parseImportFile(fileText);
    if (!parsed.ok) throw new Error(parsed.error);
    const prefix = this.storedConn.prefix;

    // Build a "name → existing gid" lookup so duplicate-name groups
    // from the file land in the existing local row instead of
    // creating yet another. Existing local words are preserved
    // (no dedup by text/translation — design.md "Import").
    const groupsByName = new Map<string, string>();
    for (const [gid, g] of this.groups) {
      const n = g.name.trim();
      if (!groupsByName.has(n)) groupsByName.set(n, gid);
    }

    // Single monotonic counter so every group / word created during
    // this import gets a unique id, even if the loop body runs in
    // the same millisecond.
    const baseTs = Date.now();
    let counter = 0;
    const nextId = (): { id: string; ts: number } => {
      counter += 1;
      const t = baseTs + counter;
      return { id: t.toString(), ts: t / 1000 };
    };

    let groupCount = 0;
    let wordCount = 0;

    for (const ig of parsed.file.groups) {
      const name = ig.name.trim();
      let targetGid = groupsByName.get(name);
      if (!targetGid) {
        const { id: gid, ts } = nextId();
        const group: Group = { id: gid, name, created: ts, updated: ts };
        this.groups.set(gid, group);
        groupsByName.set(name, gid);
        try {
          await queue.publishIntent(groupTopic(prefix, gid), group);
        } catch (err) {
          this.groups.delete(gid);
          throw err;
        }
        targetGid = gid;
        groupCount += 1;
      }
      for (const iw of ig.words) {
        const { id: wid, ts } = nextId();
        const word: Word = {
          id: wid,
          text: iw.text,
          translation: iw.translation,
          created: ts,
          updated: ts,
        };
        if (this.activeGroupId === targetGid) {
          this.words.set(wid, word);
        }
        try {
          await queue.publishIntent(wordTopic(prefix, targetGid, wid), word);
        } catch (err) {
          if (this.activeGroupId === targetGid) this.words.delete(wid);
          throw err;
        }
        wordCount += 1;
      }
    }
    return { groupCount, wordCount };
  }

  async selectGroup(gid: string): Promise<void> {
    if (!this.storedConn) return;
    const prefix = this.storedConn.prefix;
    this.switching = true;
    try {
      const connected = this.mqtt?.isConnected() === true;
      if (connected && this.activeGroupId && this.activeGroupId !== gid) {
        await this.mqtt!.unsubscribeMany([
          wordsFilter(prefix, this.activeGroupId),
          srsFilter(prefix, this.activeGroupId),
        ]);
      }
      this.words.clear();
      this.srs.clear();
      this.activeGroupId = gid;
      creds.update({ lastGroup: gid });
      if (connected) {
        await this.subscribeAndSync([wordsFilter(prefix, gid), srsFilter(prefix, gid)]);
      }
      // Else: offline — defer the subscribe. afterConnect on the next
      // successful connect will subscribe phase-2 for activeGroupId.
      //
      // From the picker (initial pick or switch-group), replace — the
      // picker entry served its purpose, and back from review should
      // walk past it. From the connect form (autoconnect with a
      // resolved lastGroup), push — so back from review returns to
      // the connect form per the design's "connect form poppable" rule.
      if (this.view === 'connect') {
        this.pushIntent({ view: 'review' });
      } else {
        this.replaceIntent({ view: 'review' });
      }
    } finally {
      this.switching = false;
    }
  }

  switchGroup(): void {
    const from = this.view;
    if (from !== 'review' && from !== 'edit' && from !== 'settings') return;
    this.pushIntent({ view: 'picker', pickerReturn: from });
  }

  cancelSwitchGroup(): void {
    if (this.pickerReturn === null) return;
    // popstate does the actual state change.
    this.goBack();
  }

  async addWord(text: string, translation: string): Promise<void> {
    if (!this.storedConn || !this.activeGroupId) return;
    const t = text.trim();
    const tr = translation.trim();
    if (!t || !tr) throw new Error('both fields required');
    const tmNow = Date.now();
    const id = tmNow.toString();
    const ts = tmNow / 1000;
    const word: Word = { id, text: t, translation: tr, created: ts, updated: ts };
    this.words.set(id, word);
    try {
      await queue.publishIntent(wordTopic(this.storedConn.prefix, this.activeGroupId, id), word);
    } catch (err) {
      this.words.delete(id);
      this.publishError = (err as Error).message;
      throw err;
    }
  }

  async updateWord(id: string, text: string, translation: string): Promise<void> {
    if (!this.storedConn || !this.activeGroupId) return;
    const existing = this.words.get(id);
    if (!existing) return;
    const t = text.trim();
    const tr = translation.trim();
    if (!t || !tr) throw new Error('both fields required');
    const word: Word = {
      ...existing,
      text: t,
      translation: tr,
      updated: Date.now() / 1000,
    };
    this.words.set(id, word);
    try {
      await queue.publishIntent(wordTopic(this.storedConn.prefix, this.activeGroupId, id), word);
    } catch (err) {
      this.words.set(id, existing);
      this.publishError = (err as Error).message;
      throw err;
    }
  }

  async deleteWord(id: string): Promise<void> {
    if (!this.storedConn || !this.activeGroupId) return;
    const prevWord = this.words.get(id);
    const prevSrs = this.srs.get(id);
    this.words.delete(id);
    this.srs.delete(id);
    // Seed the watermark so a peer's queued-while-offline content for
    // this id can't resurrect it before our tombstone publish lands.
    // The flush-time UP on the tombstone will overwrite this value if
    // it's larger (the gate uses `>` against the watermark).
    const seed = Date.now() / 1000;
    this.wordWatermark.set(id, seed);
    this.srsWatermark.set(id, seed);
    try {
      await queue.publishTombstone(wordTopic(this.storedConn.prefix, this.activeGroupId, id));
      await queue.publishTombstone(srsTopic(this.storedConn.prefix, this.activeGroupId, id));
    } catch (err) {
      if (prevWord) this.words.set(id, prevWord);
      if (prevSrs) this.srs.set(id, prevSrs);
      this.wordWatermark.delete(id);
      this.srsWatermark.delete(id);
      this.publishError = (err as Error).message;
      throw err;
    }
  }

  grade(wordId: string, g: Grade): void {
    if (!this.storedConn || !this.activeGroupId) return;
    const cur = this.srs.get(wordId) ?? defaultSrs(wordId);
    const next = applyGrade(cur, g, Date.now() / 1000);
    this.srs.set(wordId, next);
    void queue
      .publishIntent(srsTopic(this.storedConn.prefix, this.activeGroupId, wordId), next)
      .catch((e) => console.warn('mwords: srs publish failed', e));
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    if (!this.storedConn) return;
    const previous = this.settings;
    const next: Settings = { ...this.settings, ...patch, updated: Date.now() / 1000 };
    this.settings = next;
    try {
      await queue.publishIntent(settingsTopic(this.storedConn.prefix), next);
    } catch (err) {
      this.settings = previous;
      this.publishError = (err as Error).message;
      throw err;
    }
  }

  storedConnection(): StoredConnection | null {
    return this.storedConn;
  }
}

export const app = new AppStore();
