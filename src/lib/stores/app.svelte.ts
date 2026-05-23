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

type View = 'connect' | 'picker' | 'review' | 'edit' | 'settings';

class AppStore {
  connection = $state<ConnectionState>('idle');
  connectionError = $state<string | null>(null);
  publishError = $state<string | null>(null);

  groups = new SvelteMap<string, Group>();
  settings = $state<Settings>(defaultSettings());

  activeGroupId = $state<string | null>(null);
  words = new SvelteMap<string, Word>();
  srs = new SvelteMap<string, SrsState>();

  view = $state<View>('connect');
  switching = $state(false);

  private mqtt: MqttWrapper | null = null;
  private storedConn: StoredConnection | null = null;

  init(): void {
    this.storedConn = creds.read();
    this.view = 'connect';
    void queue.init();
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
    this.activeGroupId = null;
    this.settings = defaultSettings();

    this.mqtt?.disconnect();
    this.mqtt = new MqttWrapper(
      (msg) => this.handleMessage(msg.topic, msg.payload),
      (state, err) => this.handleState(state, err),
    );
    queue.setPublisher((topic, data, opts, cb) =>
      this.mqtt!.publishRaw(topic, data, opts, cb),
    );
    this.mqtt.connect(conn);
  }

  disconnect(): void {
    queue.setPublisher(null);
    void queue.onClose();
    this.mqtt?.disconnect();
    this.mqtt = null;
    this.groups.clear();
    this.words.clear();
    this.srs.clear();
    this.activeGroupId = null;
    this.settings = defaultSettings();
    this.connection = 'idle';
    this.connectionError = null;
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
      void queue.onClose();
    }
  }

  private async afterConnect(): Promise<void> {
    if (!this.mqtt || !this.storedConn) return;
    const prefix = this.storedConn.prefix;
    await this.mqtt.subscribeMany([groupsFilter(prefix), settingsTopic(prefix)]);
    setTimeout(() => this.afterPhase1(), 600);
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

  private handleMessage(topic: string, payload: Uint8Array): void {
    if (!this.storedConn) return;
    const parsed = parseTopic(this.storedConn.prefix, topic);

    if (payload.byteLength === 0) {
      if (parsed.kind === 'word') this.words.delete(parsed.id);
      else if (parsed.kind === 'srs') this.srs.delete(parsed.id);
      else if (parsed.kind === 'group') this.groups.delete(parsed.gid);
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      console.warn('mwords: bad JSON at', topic);
      return;
    }
    if (!data || typeof data !== 'object') return;

    if (parsed.kind === 'group') {
      const g = data as Group;
      if (g.id === parsed.gid && typeof g.name === 'string') {
        this.groups.set(g.id, g);
      }
    } else if (parsed.kind === 'settings') {
      const s = data as Settings;
      if (s && typeof s.srsMode === 'string') {
        this.settings = s;
      }
    } else if (parsed.kind === 'word') {
      if (this.activeGroupId !== parsed.gid) return;
      const w = data as Word;
      if (w.id === parsed.id && typeof w.text === 'string') {
        this.words.set(w.id, w);
      }
    } else if (parsed.kind === 'srs') {
      if (this.activeGroupId !== parsed.gid) return;
      const s = data as SrsState;
      if (s.id === parsed.id && typeof s.ease === 'number') {
        this.srs.set(s.id, s);
      }
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

  async selectGroup(gid: string): Promise<void> {
    if (!this.mqtt || !this.storedConn) return;
    const prefix = this.storedConn.prefix;
    this.switching = true;
    try {
      if (this.activeGroupId && this.activeGroupId !== gid) {
        await this.mqtt.unsubscribeMany([
          wordsFilter(prefix, this.activeGroupId),
          srsFilter(prefix, this.activeGroupId),
        ]);
      }
      this.words.clear();
      this.srs.clear();
      this.activeGroupId = gid;
      creds.update({ lastGroup: gid });
      await this.mqtt.subscribeMany([wordsFilter(prefix, gid), srsFilter(prefix, gid)]);
      await new Promise((r) => setTimeout(r, 400));
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
