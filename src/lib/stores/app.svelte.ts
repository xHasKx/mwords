import { SvelteMap } from 'svelte/reactivity';
import { MqttWrapper } from '../mqtt/client.ts';
import type { ConnectionState } from '../mqtt/types.ts';
import {
  parseTopic,
  groupsFilter,
  settingsTopic,
  groupTopic,
  decksFilter,
  deckTopic,
  wordsFilter,
  srsFilter,
  wordTopic,
  srsTopic,
} from '../mqtt/topics.ts';
import type { Deck, Group, ReviewScope, Settings, SrsState, Word, Grade } from '../types.ts';
import { DEFAULT_REPEAT_HOURS, defaultSettings, defaultSrs } from '../types.ts';
import { applyGrade } from '../srs/picker.ts';
import * as creds from '../storage/credentials.ts';
import type { StoredConnection } from '../storage/credentials.ts';
import { queue } from '../mqtt/queue.ts';
import { isDeck, isGroup, isWord, isSrsState, isSettings } from '../validators.ts';
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
  activeDeckId = $state<string | null>(null);
  reviewScope = $state<ReviewScope>({ kind: 'active-deck' });

  // Active-group scoped. Words and srs are stored flat (keyed by wordId);
  // the per-word deck is tracked in wordDeck so publishes know which
  // <P>/g/<G>/d/<D>/... topic to target. wordDeck is non-reactive on
  // purpose — every mutation is paired with a words.set/.delete that
  // already drives reactivity, and reading wordDeck during a derived
  // computation should not register an extra dependency.
  decks = new SvelteMap<string, Deck>();
  words = new SvelteMap<string, Word>();
  srs = new SvelteMap<string, SrsState>();
  private wordDeck = new Map<string, string>();

  // Scope-filtered view of the active group's words. Review feeds this
  // to the picker; Edit shows only the active deck. Both are $derived
  // off reactive state (reviewScope, activeDeckId, words). wordDeck is
  // read untracked, but every mutation to it is paired with a
  // this.words.set/.delete, so words drives the re-derivation.
  scopedWords = $derived.by((): Word[] => this.computeScopedWords());
  activeDeckWords = $derived.by((): Word[] => this.computeActiveDeckWords());

  private computeScopedWords(): Word[] {
    const scope = this.reviewScope;
    // Strict discovery: a word is only in scope if its parent deck has
    // a published marker (live in `this.decks`). Words whose deck marker
    // hasn't arrived yet (or was tombstoned by a peer) are filtered.
    const allowed: Set<string> | null =
      scope.kind === 'group'
        ? null
        : scope.kind === 'active-deck'
          ? this.activeDeckId
            ? new Set([this.activeDeckId])
            : new Set()
          : new Set(scope.deckIds);
    const out: Word[] = [];
    for (const w of this.words.values()) {
      const did = this.wordDeck.get(w.id);
      if (did === undefined || !this.decks.has(did)) continue;
      if (allowed !== null && !allowed.has(did)) continue;
      out.push(w);
    }
    return out;
  }

  private computeActiveDeckWords(): Word[] {
    const did = this.activeDeckId;
    if (!did || !this.decks.has(did)) return [];
    const out: Word[] = [];
    for (const w of this.words.values()) {
      if (this.wordDeck.get(w.id) === did) out.push(w);
    }
    return out;
  }

  // Reactive-friendly per-deck word count. Iterates the live `words`
  // SvelteMap so a derived caller re-runs on additions / deletions.
  wordCountInDeck(deckId: string): number {
    let n = 0;
    for (const w of this.words.values()) {
      if (this.wordDeck.get(w.id) === deckId) n += 1;
    }
    return n;
  }

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
  private deckWatermark = new Map<string, number>();

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
    // pickerReturn carries through both legs of the picker chain
    // (group picker → deck picker → final destination).
    this.pickerReturn =
      next.view === 'picker' || next.view === 'deck-picker' ? (next.pickerReturn ?? null) : null;
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
      hasActiveDeck: this.activeDeckId !== null,
    });
    // Landing on the connect form from any non-idle state must tear
    // the session down — otherwise the form re-mounts with
    // `connection !== 'idle'` (Cancel + spinner) and a stale
    // autoconnect=true on the stored creds. disconnect() resets both
    // and re-seeds the history entry via replaceIntent.
    if (r.intent.view === 'connect' && this.connection !== 'idle') {
      this.disconnect();
      return;
    }
    if (r.action === 'fallback') {
      this.replaceIntent(r.intent);
      return;
    }
    this.applyIntent(r.intent);
  }

  // Convenience helpers used by views/components. Each one is a single
  // pushIntent call, but giving them names keeps call sites self-documenting.
  //
  // navTo intercepts the Edit tab when no deck is active — the user has
  // to pick one before the editor can target a topic. Settings is
  // global and works without an active deck; Review degrades gracefully
  // when scope is broad.
  navTo(v: 'review' | 'edit' | 'settings'): void {
    if (this.view === v && this.modal === null) return;
    if (v === 'edit' && this.activeDeckId === null) {
      this.pushIntent({ view: 'deck-picker', pickerReturn: 'edit' });
      return;
    }
    // Entering Edit with a broader review scope narrows back to active-deck
    // silently (Edit always operates on one deck).
    if (v === 'edit' && this.reviewScope.kind !== 'active-deck') {
      this.reviewScope = { kind: 'active-deck' };
      creds.update({ lastReviewScope: { kind: 'active-deck' } });
    }
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

  openRenameDeck(deckId: string): void {
    this.pushIntent({
      view: 'deck-picker',
      modal: { kind: 'rename-deck', deckId },
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
    this.decks.clear();
    this.words.clear();
    this.srs.clear();
    this.wordDeck.clear();
    this.wordWatermark.clear();
    this.srsWatermark.clear();
    this.deckWatermark.clear();
    this.activeGroupId = null;
    this.activeDeckId = null;
    this.reviewScope = { kind: 'active-deck' };
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
    this.decks.clear();
    this.words.clear();
    this.srs.clear();
    this.wordDeck.clear();
    this.wordWatermark.clear();
    this.srsWatermark.clear();
    this.deckWatermark.clear();
    this.activeGroupId = null;
    this.activeDeckId = null;
    this.reviewScope = { kind: 'active-deck' };
    this.settings = defaultSettings();
    this.connection = 'idle';
    this.connectionError = null;
    this.nextAttemptAt = null;
    // Keep the stored autoconnect preference as-is — the checkbox
    // reflects "what should happen on the next page load", not "should
    // we reconnect right now". Within this session, nothing else reads
    // the flag, so leaving it true here doesn't trigger a reconnect.
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
        decksFilter(prefix, this.activeGroupId),
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
        if (this.activeGroupId !== parsed.gid) return;
        const local = this.words.get(parsed.id);
        if (!this.acceptByGate(local?.updated, this.wordWatermark.get(parsed.id), up)) return;
        this.wordDeck.delete(parsed.id);
        this.words.delete(parsed.id);
        if (up !== null) this.wordWatermark.set(parsed.id, up);
      } else if (parsed.kind === 'srs') {
        if (this.activeGroupId !== parsed.gid) return;
        const local = this.srs.get(parsed.id);
        if (!this.acceptByGate(local?.updated, this.srsWatermark.get(parsed.id), up)) return;
        this.srs.delete(parsed.id);
        if (up !== null) this.srsWatermark.set(parsed.id, up);
      } else if (parsed.kind === 'deck') {
        if (this.activeGroupId !== parsed.gid) return;
        const local = this.decks.get(parsed.did);
        if (!this.acceptByGate(local?.updated, this.deckWatermark.get(parsed.did), up)) return;
        this.decks.delete(parsed.did);
        if (up !== null) this.deckWatermark.set(parsed.did, up);
        // Prune child words/srs locally and seed watermarks so a peer's
        // queued-while-offline content publish for one of these ids can't
        // slip past the LWW gate (no local record + no watermark = the
        // gate accepts the resurrection). The flespi-style subtree
        // tombstone may already be wiping these at the broker too, but
        // we don't rely on it.
        const seed = up ?? Date.now() / 1000;
        for (const [wid, did] of this.wordDeck) {
          if (did !== parsed.did) continue;
          this.wordDeck.delete(wid);
          this.words.delete(wid);
          this.srs.delete(wid);
          this.wordWatermark.set(wid, seed);
          this.srsWatermark.set(wid, seed);
        }
        if (this.activeDeckId === parsed.did) {
          this.activeDeckId = null;
          this.reviewScope = { kind: 'active-deck' };
          creds.clearLastDeck();
        }
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
    } else if (parsed.kind === 'deck') {
      if (this.activeGroupId !== parsed.gid) return;
      if (!isDeck(data, parsed.did)) {
        console.warn('mwords: invalid Deck at', topic);
        return;
      }
      const local = this.decks.get(data.id);
      if (!this.acceptByGate(local?.updated, this.deckWatermark.get(data.id), up)) return;
      this.decks.set(data.id, data);
      this.deckWatermark.delete(data.id);
    } else if (parsed.kind === 'word') {
      if (this.activeGroupId !== parsed.gid) return;
      if (!isWord(data, parsed.id)) {
        console.warn('mwords: invalid Word at', topic);
        return;
      }
      const local = this.words.get(data.id);
      if (!this.acceptByGate(local?.updated, this.wordWatermark.get(data.id), up)) return;
      // Update the reverse index BEFORE the reactive words map so any
      // derived that reads both sees a consistent snapshot.
      this.wordDeck.set(data.id, parsed.did);
      this.words.set(data.id, data);
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

  async createDeck(name: string): Promise<string> {
    if (!this.storedConn || !this.activeGroupId) throw new Error('no active group');
    const trimmed = name.trim();
    if (!trimmed) throw new Error('name required');
    const tmNow = Date.now();
    const id = tmNow.toString();
    const ts = tmNow / 1000;
    const deck: Deck = { id, name: trimmed, created: ts, updated: ts };
    this.decks.set(id, deck);
    try {
      await queue.publishIntent(deckTopic(this.storedConn.prefix, this.activeGroupId, id), deck);
    } catch (err) {
      this.decks.delete(id);
      this.publishError = (err as Error).message;
      throw err;
    }
    return id;
  }

  async renameDeck(id: string, name: string): Promise<void> {
    if (!this.storedConn || !this.activeGroupId) throw new Error('no active group');
    const existing = this.decks.get(id);
    if (!existing) throw new Error('deck missing');
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 256) {
      throw new Error('name must be 1-256 chars');
    }
    if (trimmed === existing.name) return;
    const next: Deck = { ...existing, name: trimmed, updated: Date.now() / 1000 };
    this.decks.set(id, next);
    try {
      await queue.publishIntent(deckTopic(this.storedConn.prefix, this.activeGroupId, id), next);
    } catch (err) {
      this.decks.set(id, existing);
      this.publishError = (err as Error).message;
      throw err;
    }
  }

  async deleteDeck(id: string): Promise<void> {
    if (!this.storedConn || !this.activeGroupId) throw new Error('no active group');
    const existing = this.decks.get(id);
    if (!existing) return;
    const prefix = this.storedConn.prefix;
    const gid = this.activeGroupId;

    // Optimistic local cleanup. Mirror Group deletion: subtree wipe via
    // the broker-specific `#`-tombstone, then the marker.
    this.decks.delete(id);
    // Prune words/srs that lived under this deck from the local store
    // and seed per-id watermarks. Without seeds, a peer's queued-while-
    // offline content publish for one of these ids could slip past the
    // gate (no local record + no watermark = accept) before our subtree
    // tombstone publishes lands.
    const seed = Date.now() / 1000;
    for (const [wid, did] of this.wordDeck) {
      if (did !== id) continue;
      this.wordDeck.delete(wid);
      this.words.delete(wid);
      this.srs.delete(wid);
      this.wordWatermark.set(wid, seed);
      this.srsWatermark.set(wid, seed);
    }
    if (this.activeDeckId === id) {
      this.activeDeckId = null;
      this.reviewScope = { kind: 'active-deck' };
      creds.clearLastDeck();
    } else if (this.reviewScope.kind === 'decks') {
      const filtered = this.reviewScope.deckIds.filter((d) => d !== id);
      this.reviewScope =
        filtered.length > 0 ? { kind: 'decks', deckIds: filtered } : { kind: 'active-deck' };
      creds.update({ lastReviewScope: this.reviewScope });
    }

    try {
      await queue.publishTombstone(`${prefix}/g/${gid}/d/${id}/#`);
      await queue.publishTombstone(deckTopic(prefix, gid, id));
    } catch (err) {
      this.publishError = (err as Error).message;
      throw err;
    }
  }

  // Called from the deck picker when the user taps a deck row. Sets
  // active deck, narrows scope, persists, and advances to `pickerReturn`
  // (or Review by default). Replace rather than push so back from the
  // destination view walks past the picker.
  selectDeck(id: string): void {
    if (!this.decks.has(id)) return;
    this.activeDeckId = id;
    this.reviewScope = { kind: 'active-deck' };
    creds.update({ lastDeck: id, lastReviewScope: { kind: 'active-deck' } });
    const onward = this.pickerReturn ?? 'review';
    this.replaceIntent({ view: onward });
  }

  // Called from the deck picker's "All decks" row and its
  // "Review selected (N)" multi-select CTA. Both target Review
  // regardless of pickerReturn (Edit isn't meaningful for a broad
  // scope; Settings is reachable directly from the nav bar).
  selectScopeAndReview(scope: ReviewScope): void {
    this.setReviewScope(scope);
    this.replaceIntent({ view: 'review' });
  }

  setReviewScope(scope: ReviewScope): void {
    // Multi-deck scopes are filtered against the live decks store so
    // stale ids don't survive a peer-side delete.
    if (scope.kind === 'decks') {
      const filtered = scope.deckIds.filter((d) => this.decks.has(d));
      scope = filtered.length > 0 ? { kind: 'decks', deckIds: filtered } : { kind: 'active-deck' };
    }
    this.reviewScope = scope;
    creds.update({ lastReviewScope: scope });
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
        await this.mqtt.unsubscribeMany([
          decksFilter(prefix, id),
          wordsFilter(prefix, id),
          srsFilter(prefix, id),
        ]);
      }
      this.decks.clear();
      this.words.clear();
      this.srs.clear();
      this.wordDeck.clear();
      this.activeGroupId = null;
      this.activeDeckId = null;
      this.reviewScope = { kind: 'active-deck' };
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
    for (const g of payload.groups) {
      for (const d of g.decks) wordCount += d.words.length;
    }
    return { filename, groupCount: payload.groups.length, wordCount };
  }

  async importAll(
    fileText: string,
  ): Promise<{ groupCount: number; deckCount: number; wordCount: number }> {
    if (!this.storedConn) throw new Error('not connected');
    if (this.connection !== 'connected') {
      throw new Error('Connect to the broker before importing.');
    }
    const parsed = parseImportFile(fileText);
    if (!parsed.ok) throw new Error(parsed.error);
    const prefix = this.storedConn.prefix;

    // Group dedup: every group name in the local store maps to its gid.
    // Phase-1 subscribe keeps groups discovered across all the broker,
    // so this lookup is authoritative.
    const groupsByName = new Map<string, string>();
    for (const [gid, g] of this.groups) {
      const n = g.name.trim();
      if (!groupsByName.has(n)) groupsByName.set(n, gid);
    }

    // Deck dedup: only the **active group**'s decks are loaded
    // in-memory (phase-2 subscription scope), so dedup-by-name can
    // only happen there. For imports into other groups, every imported
    // deck is created fresh — re-importing the same file into a
    // non-active group will produce duplicate decks. Acceptable v1
    // limitation; the user can review and clean up if needed.
    const activeDecksByName = new Map<string, string>();
    if (this.activeGroupId) {
      for (const [did, d] of this.decks) {
        const n = d.name.trim();
        if (!activeDecksByName.has(n)) activeDecksByName.set(n, did);
      }
    }

    // Single monotonic counter so every group / deck / word created
    // during this import gets a unique id, even if the loop body runs
    // in the same millisecond.
    const baseTs = Date.now();
    let counter = 0;
    const nextId = (): { id: string; ts: number } => {
      counter += 1;
      const t = baseTs + counter;
      return { id: t.toString(), ts: t / 1000 };
    };

    let groupCount = 0;
    let deckCount = 0;
    let wordCount = 0;

    for (const ig of parsed.file.groups) {
      const gName = ig.name.trim();
      let targetGid = groupsByName.get(gName);
      if (!targetGid) {
        const { id: gid, ts } = nextId();
        const group: Group = { id: gid, name: gName, created: ts, updated: ts };
        this.groups.set(gid, group);
        groupsByName.set(gName, gid);
        try {
          await queue.publishIntent(groupTopic(prefix, gid), group);
        } catch (err) {
          this.groups.delete(gid);
          throw err;
        }
        targetGid = gid;
        groupCount += 1;
      }

      for (const id of ig.decks) {
        const dName = id.name.trim();
        // Reuse an existing deck only when the target group is the
        // active one (its decks are loaded in-memory). Otherwise
        // always create fresh.
        const reuse = this.activeGroupId === targetGid ? activeDecksByName.get(dName) : undefined;
        let targetDid: string;
        if (reuse) {
          targetDid = reuse;
        } else {
          const { id: did, ts } = nextId();
          const deck: Deck = { id: did, name: dName, created: ts, updated: ts };
          if (this.activeGroupId === targetGid) {
            this.decks.set(did, deck);
            activeDecksByName.set(dName, did);
          }
          try {
            await queue.publishIntent(deckTopic(prefix, targetGid, did), deck);
          } catch (err) {
            if (this.activeGroupId === targetGid) {
              this.decks.delete(did);
              activeDecksByName.delete(dName);
            }
            throw err;
          }
          targetDid = did;
          deckCount += 1;
        }

        for (const iw of id.words) {
          const { id: wid, ts } = nextId();
          const word: Word = {
            id: wid,
            text: iw.text,
            translation: iw.translation,
            created: ts,
            updated: ts,
          };
          if (this.activeGroupId === targetGid) {
            this.wordDeck.set(wid, targetDid);
            this.words.set(wid, word);
          }
          try {
            await queue.publishIntent(wordTopic(prefix, targetGid, targetDid, wid), word);
          } catch (err) {
            if (this.activeGroupId === targetGid) {
              this.words.delete(wid);
              this.wordDeck.delete(wid);
            }
            throw err;
          }
          wordCount += 1;
        }
      }
    }
    return { groupCount, deckCount, wordCount };
  }

  async selectGroup(gid: string): Promise<void> {
    if (!this.storedConn) return;
    const prefix = this.storedConn.prefix;
    // Snapshot view at entry — a popstate during the subscribe await
    // could otherwise flip view to 'connect' (or another) and route the
    // transition through the wrong intent shape (push vs replace).
    const entryView = this.view;
    const previousGid = this.activeGroupId;
    const isSwitch = previousGid !== null && previousGid !== gid;
    this.switching = true;
    try {
      const connected = this.mqtt?.isConnected() === true;
      if (connected && isSwitch) {
        await this.mqtt!.unsubscribeMany([
          decksFilter(prefix, previousGid!),
          wordsFilter(prefix, previousGid!),
          srsFilter(prefix, previousGid!),
        ]);
      }
      this.decks.clear();
      this.words.clear();
      this.srs.clear();
      this.wordDeck.clear();
      this.activeGroupId = gid;
      if (isSwitch) {
        // Switching groups invalidates the previous group's lastDeck /
        // lastReviewScope. Clear them in storage explicitly (the
        // separate clearLastDeck() also strips lastReviewScope), then
        // write the new lastGroup. This avoids relying on JSON.stringify
        // to drop `undefined` props from a combined `creds.update`.
        this.activeDeckId = null;
        this.reviewScope = { kind: 'active-deck' };
        creds.clearLastDeck();
      }
      creds.update({ lastGroup: gid });
      if (connected) {
        await this.subscribeAndSync([
          decksFilter(prefix, gid),
          wordsFilter(prefix, gid),
          srsFilter(prefix, gid),
        ]);
      }
      // Restore lastDeck / lastReviewScope if they survive the new group.
      // For a switch we just cleared them above; for the initial select
      // (called from afterPhase1 with a resolved lastGroup), the stored
      // values may belong to *this* group.
      if (!isSwitch) this.restoreActiveDeck();
      // Else: offline — defer the subscribe. afterConnect on the next
      // successful connect will subscribe phase-2 for activeGroupId.
      //
      // Mid-await popstate guard. If a back/forward press fired while
      // we were awaiting unsubscribe/subscribe, `this.view` has moved
      // off the entry view. The store mutations above (activeGroupId,
      // subscriptions) already happened — we accept that drift — but
      // we must NOT force the destination intent on top of whatever
      // the user navigated to. Skip the push/replace; the user lands
      // wherever they back-pressed to and can re-enter normally.
      if (this.view !== entryView) return;

      // Pick a destination view:
      //   - With an active deck, head to the caller's `pickerReturn` if
      //     one was set (the user came via switch-deck → up-arrow →
      //     pick-group), otherwise Review.
      //   - Without an active deck, fall to the deck picker. Carry
      //     `pickerReturn` forward so the user lands where they meant
      //     to once they pick a deck.
      //   - From the connect form (autoconnect with a resolved
      //     lastGroup), push instead of replace so back returns to the
      //     connect form per the "connect form poppable" rule.
      const onward = this.pickerReturn;
      const dest: Intent =
        this.activeDeckId !== null
          ? { view: onward ?? 'review' }
          : { view: 'deck-picker', pickerReturn: onward ?? undefined };
      if (entryView === 'connect') {
        this.pushIntent(dest);
      } else {
        this.replaceIntent(dest);
      }
    } finally {
      this.switching = false;
    }
  }

  // Tapping the up-arrow in the deck picker pushes the group picker.
  // pickerReturn is preserved so picking a group → that group's deck
  // picker → pick-or-broaden → final destination stays the chain.
  openGroupPickerFromDeckPicker(): void {
    this.replaceIntent({ view: 'picker', pickerReturn: this.pickerReturn ?? undefined });
  }

  // After SUBACK + debounce, the decks store reflects retained replay.
  // Try to restore the persisted active deck and review scope.
  private restoreActiveDeck(): void {
    const stored = creds.read();
    if (!stored) return;
    const lastDeck = stored.lastDeck;
    if (lastDeck && this.decks.has(lastDeck)) {
      this.activeDeckId = lastDeck;
    } else if (lastDeck) {
      // Stale lastDeck (deck deleted on another device, or new prefix).
      creds.clearLastDeck();
    }
    // Filter persisted multi-deck selections to those still present.
    const scope = stored.lastReviewScope;
    if (scope?.kind === 'decks') {
      const filtered = scope.deckIds.filter((d) => this.decks.has(d));
      this.reviewScope =
        filtered.length > 0 ? { kind: 'decks', deckIds: filtered } : { kind: 'active-deck' };
    } else if (scope) {
      this.reviewScope = scope;
    }
  }

  // Nav-bar "Switch deck" entry point. The deck picker is the primary
  // step; users reach the group picker from there via the up-arrow.
  switchDeck(): void {
    const from = this.view;
    if (from !== 'review' && from !== 'edit' && from !== 'settings') return;
    this.pushIntent({ view: 'deck-picker', pickerReturn: from });
  }

  async addWord(text: string, translation: string): Promise<void> {
    if (!this.storedConn || !this.activeGroupId || !this.activeDeckId) {
      throw new Error('no active deck');
    }
    const t = text.trim();
    const tr = translation.trim();
    if (!t || !tr) throw new Error('both fields required');
    const tmNow = Date.now();
    const id = tmNow.toString();
    const ts = tmNow / 1000;
    // Snapshot gid/did at entry. A group switch mid-await would
    // otherwise let queue.publishIntent target the new group's topic
    // and pollute that group's retained state.
    const gid = this.activeGroupId;
    const did = this.activeDeckId;
    const word: Word = { id, text: t, translation: tr, created: ts, updated: ts };
    this.wordDeck.set(id, did);
    this.words.set(id, word);
    try {
      await queue.publishIntent(wordTopic(this.storedConn.prefix, gid, did, id), word);
    } catch (err) {
      this.words.delete(id);
      this.wordDeck.delete(id);
      this.publishError = (err as Error).message;
      throw err;
    }
  }

  async updateWord(id: string, text: string, translation: string): Promise<void> {
    if (!this.storedConn || !this.activeGroupId) return;
    const existing = this.words.get(id);
    if (!existing) return;
    const did = this.wordDeck.get(id);
    if (!did) return;
    const gid = this.activeGroupId;
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
      await queue.publishIntent(wordTopic(this.storedConn.prefix, gid, did, id), word);
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
    const did = this.wordDeck.get(id);
    if (!did) return;
    const gid = this.activeGroupId;
    this.wordDeck.delete(id);
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
      await queue.publishTombstone(wordTopic(this.storedConn.prefix, gid, did, id));
      await queue.publishTombstone(srsTopic(this.storedConn.prefix, gid, did, id));
    } catch (err) {
      if (prevWord) {
        this.wordDeck.set(id, did);
        this.words.set(id, prevWord);
      }
      if (prevSrs) this.srs.set(id, prevSrs);
      this.wordWatermark.delete(id);
      this.srsWatermark.delete(id);
      this.publishError = (err as Error).message;
      throw err;
    }
  }

  grade(wordId: string, g: Grade): void {
    if (!this.storedConn || !this.activeGroupId) return;
    const did = this.wordDeck.get(wordId);
    if (!did) return;
    const gid = this.activeGroupId;
    const cur = this.srs.get(wordId) ?? defaultSrs(wordId);
    const intervalSeconds = (this.settings.repeatHours ?? DEFAULT_REPEAT_HOURS) * 3600;
    const next = applyGrade(cur, g, Date.now() / 1000, intervalSeconds);
    this.srs.set(wordId, next);
    void queue
      .publishIntent(srsTopic(this.storedConn.prefix, gid, did, wordId), next)
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
