import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { PublishQueue, type PublishOpts } from '../src/lib/mqtt/queue.ts';

// Each test gets a fresh IDBFactory — equivalent to a brand-new
// IndexedDB instance with no databases. Cheaper and more reliable than
// indexedDB.deleteDatabase between tests (which blocks on open
// connections).
async function freshQueue(): Promise<PublishQueue> {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  const q = new PublishQueue();
  await q.init();
  return q;
}

type PublishCall = {
  topic: string;
  data: string;
  opts: PublishOpts;
  cb: (err?: Error) => void;
};

function recordingPublisher() {
  const calls: PublishCall[] = [];
  const fn = (topic: string, data: string, opts: PublishOpts, cb: (err?: Error) => void) => {
    calls.push({ topic, data, opts, cb });
  };
  return { fn, calls };
}

// Yield enough macrotasks for fake-indexeddb's tx-done chains and our
// flush()/handlePubackResult microtasks to fully drain.
async function settle(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

let queue: PublishQueue;

beforeEach(async () => {
  queue = await freshQueue();
});

afterEach(() => {
  // Drop publisher so any in-flight callback doesn't fire after the test.
  queue.setPublisher(null);
});

describe('PublishQueue — enqueue & dedupe', () => {
  it('publishIntent inserts and bumps pendingCount', async () => {
    await queue.publishIntent('a/b', { id: '1', updated: 1 });
    expect(queue.pendingCount).toBe(1);
  });

  it('dedupe-replaces a not-yet-published row for the same topic', async () => {
    await queue.publishIntent('a/b', { id: '1', updated: 1 });
    await queue.publishIntent('a/b', { id: '1', updated: 2 });
    expect(queue.pendingCount).toBe(1);
  });

  it('appends a row when the existing one is in-flight', async () => {
    const { fn } = recordingPublisher();
    queue.setPublisher(fn);
    await queue.publishIntent('a/b', { id: '1', updated: 1 });
    await queue.onConnect();
    await settle();
    // Existing row now has publishedAt — second enqueue must append.
    await queue.publishIntent('a/b', { id: '1', updated: 2 });
    expect(queue.pendingCount).toBe(2);
  });

  it('publishTombstone enqueues with payload null', async () => {
    await queue.publishTombstone('a/b');
    expect(queue.pendingCount).toBe(1);
  });

  it('tombstones and content publishes dedupe each other', async () => {
    await queue.publishIntent('a/b', { id: '1', updated: 1 });
    await queue.publishTombstone('a/b');
    expect(queue.pendingCount).toBe(1);
  });
});

describe('PublishQueue — flush + PUBACK', () => {
  it('flush calls publisher for each pending row', async () => {
    const { fn, calls } = recordingPublisher();
    queue.setPublisher(fn);
    await queue.publishIntent('a/b', { id: '1', updated: 1 });
    await queue.publishIntent('c/d', { id: '2', updated: 2 });
    await queue.onConnect();
    await settle();
    expect(calls.map((c) => c.topic).sort()).toEqual(['a/b', 'c/d']);
  });

  it('PUBACK success deletes the row and decrements pendingCount', async () => {
    const { fn, calls } = recordingPublisher();
    queue.setPublisher(fn);
    await queue.publishIntent('a/b', { id: '1', updated: 1 });
    await queue.onConnect();
    await settle();
    expect(queue.pendingCount).toBe(1);
    calls[0].cb(); // PUBACK success
    await settle();
    expect(queue.pendingCount).toBe(0);
  });

  it('PUBACK error clears publishedAt and retries on next flush', async () => {
    const { fn, calls } = recordingPublisher();
    queue.setPublisher(fn);
    await queue.publishIntent('a/b', { id: '1', updated: 1 });
    await queue.onConnect();
    await settle();
    expect(calls.length).toBe(1);
    calls[0].cb(new Error('broker rejected'));
    await settle();
    expect(queue.pendingCount).toBe(1); // still there
    // Trigger another flush by publishing a different row.
    await queue.publishIntent('c/d', { id: '2', updated: 2 });
    await settle();
    // The failed row should be re-attempted alongside the new one.
    expect(calls.length).toBe(3); // 1 original + 1 retry + 1 new
  });

  it('publishes the timestamp UP from payload.updated', async () => {
    const { fn, calls } = recordingPublisher();
    queue.setPublisher(fn);
    await queue.publishIntent('a/b', { id: '1', updated: 1234.5 });
    await queue.onConnect();
    await settle();
    expect(calls[0].opts.userProperties.timestamp).toBe('1234.5');
  });
});

describe('PublishQueue — drainAll snapshot semantics', () => {
  it('resolves when the snapshot set is empty, ignoring later enqueues', async () => {
    const { fn, calls } = recordingPublisher();
    queue.setPublisher(fn);
    await queue.publishIntent('a/b', { id: '1', updated: 1 });
    queue.setPublisher(fn);

    // Capture the snapshot — at this moment one row is pending.
    let drained = false;
    const drainPromise = queue.drainAll().then(() => (drained = true));
    await queue.onConnect();
    await settle();

    // Enqueue a new row *after* drainAll captured its snapshot.
    await queue.publishIntent('c/d', { id: '2', updated: 2 });

    // The new row is NOT in the drain snapshot. drainAll must still be
    // waiting for the original row's PUBACK.
    expect(drained).toBe(false);

    // Ack the original row.
    const original = calls.find((c) => c.topic === 'a/b')!;
    original.cb();
    await drainPromise;
    expect(drained).toBe(true);
  });

  it('resolves immediately when called with an empty queue', async () => {
    const start = Date.now();
    await queue.drainAll();
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe('PublishQueue — clear & onClose', () => {
  it('clear() wipes the store and zeroes pendingCount', async () => {
    await queue.publishIntent('a/b', { id: '1', updated: 1 });
    await queue.publishIntent('c/d', { id: '2', updated: 2 });
    expect(queue.pendingCount).toBe(2);
    await queue.clear();
    expect(queue.pendingCount).toBe(0);
  });

  it('onClose clears publishedAt on every row', async () => {
    const { fn } = recordingPublisher();
    queue.setPublisher(fn);
    await queue.publishIntent('a/b', { id: '1', updated: 1 });
    await queue.publishIntent('c/d', { id: '2', updated: 2 });
    await queue.onConnect();
    await settle();
    // Both rows now have publishedAt set.
    await queue.onClose();
    // Second enqueue path: append-only because the existing rows would
    // be considered in-flight, but onClose just cleared them. So a
    // dedupe-replace for the same topic should succeed.
    await queue.publishIntent('a/b', { id: '1', updated: 3 });
    expect(queue.pendingCount).toBe(2); // dedupe-replace, no growth
  });
});

describe('PublishQueue — onChange', () => {
  it('fires on count changes and dispose unsubscribes', async () => {
    let count = 0;
    const off = queue.onChange(() => count++);
    await queue.publishIntent('a/b', { id: '1', updated: 1 });
    expect(count).toBeGreaterThan(0);
    const after = count;
    off();
    await queue.publishIntent('c/d', { id: '2', updated: 2 });
    expect(count).toBe(after);
  });
});
