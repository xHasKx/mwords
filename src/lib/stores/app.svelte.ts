import { SvelteMap } from 'svelte/reactivity';
import { MqttWrapper } from '../mqtt/client.ts';
import type { ConnectionState } from '../mqtt/types.ts';
import { parseTopic, groupsFilter, settingsTopic, groupTopic, wordsFilter, srsFilter, wordTopic, srsTopic } from '../mqtt/topics.ts';
import type { Group, Settings, SrsState, Word, Grade } from '../types.ts';
import { defaultSettings, defaultSrs } from '../types.ts';
import { applyGrade } from '../srs/picker.ts';
import * as creds from '../storage/credentials.ts';
import type { StoredConnection } from '../storage/credentials.ts';
import { queue } from '../mqtt/queue.ts';
import { isGroup, isWord, isSrsState, isSettings } from '../validators.ts';

type View = 'connect' | 'picker' | 'review' | 'edit' | 'settings';

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

  private mqtt: MqttWrapper | null = null;
  private storedConn: StoredConnection | null = null;

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
    this.view = 'connect';
    void queue.init();
    if (this.storedConn?.autoconnect) {
      this.connect(this.storedConn);
    }
  }

  connect(conn: StoredConnection): void {
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
    queue.setPublisher((topic, data, opts, cb) =>
      this.mqtt!.publishRaw(topic, data, opts, cb),
    );
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
    this.view = 'connect';
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
      this.view = 'picker';
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
      this.view = 'review';
    } finally {
      this.switching = false;
    }
  }

  switchGroup(): void {
    this.view = 'picker';
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
      await queue.publishIntent(
        wordTopic(this.storedConn.prefix, this.activeGroupId, id),
        word,
      );
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
      await queue.publishIntent(
        wordTopic(this.storedConn.prefix, this.activeGroupId, id),
        word,
      );
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
      await queue.publishTombstone(
        wordTopic(this.storedConn.prefix, this.activeGroupId, id),
      );
      await queue.publishTombstone(
        srsTopic(this.storedConn.prefix, this.activeGroupId, id),
      );
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
