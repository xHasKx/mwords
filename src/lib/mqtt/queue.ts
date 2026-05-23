import { openDB, type IDBPDatabase } from 'idb';

export type PublishOpts = {
  qos: 0 | 1;
  retain: boolean;
  userProperties: Record<string, string>;
};

export type Publisher = (
  topic: string,
  data: string,
  opts: PublishOpts,
  cb: (err?: Error) => void,
) => void;

export type PublishIntent = {
  seq?: number;
  topic: string;
  payload: Record<string, unknown> | null;
  retain: boolean;
  qos: 0 | 1;
  enqueuedAt: number;
  publishedAt?: number;
};

const DB_NAME = 'mwords';
const DB_VERSION = 1;
const STORE = 'intents';
const TOPIC_INDEX = 'by_topic';
const CAP = 10_000;
const STALE_PUBLISHED_AT_SEC = 30;

type DrainWaiter = { snapshot: Set<number>; resolve: () => void };

export class PublishQueue {
  pendingCount = 0;

  private db: IDBPDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private publisher: Publisher | null = null;
  private connected = false;
  private flushing = false;
  private flushAgain = false;
  private listeners = new Set<() => void>();
  private drainWaiters: DrainWaiter[] = [];

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    this.db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, {
          keyPath: 'seq',
          autoIncrement: true,
        });
        store.createIndex(TOPIC_INDEX, 'topic', { unique: false });
      },
    });
    // Force-quits and crashes can leave a `publishedAt` marker behind
    // without ever firing the `close`/`offline` event that clears it.
    // The next flush would skip those rows forever. Wipe markers older
    // than the threshold so the next connect retries them. Anything
    // newer is presumed live (sibling tab actually mid-publish).
    const cutoff = Date.now() / 1000 - STALE_PUBLISHED_AT_SEC;
    const tx = this.db.transaction(STORE, 'readwrite');
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const row = cursor.value as PublishIntent;
      if (row.publishedAt !== undefined && row.publishedAt < cutoff) {
        const next: PublishIntent = { ...row };
        delete next.publishedAt;
        await cursor.update(next);
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    this.pendingCount = await this.db.count(STORE);
    this.notify();
  }

  setPublisher(p: Publisher | null): void {
    this.publisher = p;
  }

  async onConnect(): Promise<void> {
    this.connected = true;
    await this.init();
    void this.flush();
  }

  async onClose(): Promise<void> {
    this.connected = false;
    if (!this.db) return;
    // Clear `publishedAt` on every in-flight row so the next flush retries.
    const tx = this.db.transaction(STORE, 'readwrite');
    let cursor = await tx.store.openCursor();
    while (cursor) {
      if (cursor.value.publishedAt !== undefined) {
        const v: PublishIntent = { ...cursor.value };
        delete v.publishedAt;
        await cursor.update(v);
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  publishIntent(topic: string, payload: Record<string, unknown>): Promise<void> {
    return this.enqueue(topic, payload);
  }

  publishTombstone(topic: string): Promise<void> {
    return this.enqueue(topic, null);
  }

  private async enqueue(
    topic: string,
    payload: Record<string, unknown> | null,
  ): Promise<void> {
    await this.init();
    const db = this.db!;
    const tx = db.transaction(STORE, 'readwrite');
    const idx = tx.store.index(TOPIC_INDEX);
    let cursor = await idx.openCursor(topic);
    let replaced = false;
    while (cursor && !replaced) {
      const row = cursor.value as PublishIntent;
      if (row.publishedAt === undefined) {
        await cursor.update({
          ...row,
          payload,
          enqueuedAt: Date.now() / 1000,
        });
        replaced = true;
        break;
      }
      cursor = await cursor.continue();
    }
    if (!replaced) {
      const count = await tx.store.count();
      if (count >= CAP) {
        await tx.done;
        throw new Error(`publish queue cap reached (${CAP})`);
      }
      const row: PublishIntent = {
        topic,
        payload,
        retain: true,
        qos: 1,
        enqueuedAt: Date.now() / 1000,
      };
      await tx.store.add(row);
    }
    await tx.done;
    if (!replaced) {
      this.pendingCount += 1;
      this.notify();
    }
    if (this.connected) void this.flush();
  }

  async clear(): Promise<void> {
    await this.init();
    const tx = this.db!.transaction(STORE, 'readwrite');
    await tx.store.clear();
    await tx.done;
    this.pendingCount = 0;
    this.notify();
    // Cancel any pending drains so the connect handler doesn't hang.
    for (const w of this.drainWaiters) w.resolve();
    this.drainWaiters = [];
  }

  async drainAll(): Promise<void> {
    await this.init();
    const all = (await this.db!.getAll(STORE)) as PublishIntent[];
    const snapshot = new Set<number>();
    for (const row of all) if (row.seq !== undefined) snapshot.add(row.seq);
    if (snapshot.size === 0) return;
    return new Promise<void>((resolve) => {
      this.drainWaiters.push({ snapshot, resolve });
      void this.flush();
    });
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  private resolveDrainsForSeq(seq: number): void {
    const remaining: DrainWaiter[] = [];
    for (const w of this.drainWaiters) {
      w.snapshot.delete(seq);
      if (w.snapshot.size === 0) w.resolve();
      else remaining.push(w);
    }
    this.drainWaiters = remaining;
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        await this.flushOnce();
      } while (this.flushAgain && this.connected && this.publisher);
    } finally {
      this.flushing = false;
    }
  }

  private async flushOnce(): Promise<void> {
    if (!this.db || !this.publisher || !this.connected) return;
    const all = (await this.db.getAll(STORE)) as PublishIntent[];
    const candidates = all.filter((r) => r.publishedAt === undefined);
    for (const intent of candidates) {
      if (!this.publisher || !this.connected) break;
      if (intent.seq === undefined) continue;
      const tx = this.db.transaction(STORE, 'readwrite');
      const current = (await tx.store.get(intent.seq)) as PublishIntent | undefined;
      if (!current || current.publishedAt !== undefined) {
        await tx.done;
        continue;
      }
      current.publishedAt = Date.now() / 1000;
      await tx.store.put(current);
      await tx.done;

      const data =
        current.payload === null ? '' : JSON.stringify(current.payload);
      const tsSec =
        current.payload !== null &&
        typeof current.payload['updated'] === 'number'
          ? (current.payload['updated'] as number)
          : Date.now() / 1000;
      const seq = current.seq!;
      const publisher = this.publisher;
      try {
        publisher(
          current.topic,
          data,
          {
            qos: 1,
            retain: current.retain,
            userProperties: { timestamp: tsSec.toString() },
          },
          (err) => void this.handlePubackResult(seq, err),
        );
      } catch (err) {
        // Synchronous throw from mqtt.publish — clear publishedAt and stop
        // iterating this pass.
        await this.markForRetry(seq);
        break;
      }
    }
  }

  private async markForRetry(seq: number): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(STORE, 'readwrite');
    const cur = (await tx.store.get(seq)) as PublishIntent | undefined;
    if (cur) {
      const next: PublishIntent = { ...cur };
      delete next.publishedAt;
      await tx.store.put(next);
    }
    await tx.done;
  }

  private async handlePubackResult(seq: number, err?: Error): Promise<void> {
    if (!this.db) return;
    if (err) {
      await this.markForRetry(seq);
      if (this.connected) void this.flush();
      return;
    }
    const tx = this.db.transaction(STORE, 'readwrite');
    const cur = (await tx.store.get(seq)) as PublishIntent | undefined;
    let removed = false;
    if (cur) {
      await tx.store.delete(seq);
      removed = true;
    }
    await tx.done;
    if (removed) {
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      this.notify();
      this.resolveDrainsForSeq(seq);
    }
  }
}

export const queue = new PublishQueue();
