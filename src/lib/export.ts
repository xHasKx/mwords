import type { StoredConnection } from './storage/credentials.ts';
import { parseTopic } from './mqtt/topics.ts';
import { isDeck, isGroup, isWord } from './validators.ts';

// Quiet-period that signals retained-replay drained. Mirrors the
// 500 ms SUBACK debounce the live AppStore uses for "synced".
const DRAIN_QUIET_MS = 500;
// Hard cap on the whole export, in case the broker streams forever
// or the connection wedges. 30 s is generous for typical mwords
// content sizes; surface a clear timeout error past that.
const TOTAL_TIMEOUT_MS = 30_000;

export type ExportWord = { text: string; translation: string };
export type ExportDeck = { name: string; words: ExportWord[] };
export type ExportGroup = { name: string; decks: ExportDeck[] };
export type ExportPayload = { version: 2; groups: ExportGroup[] };

type CaptureDeck = { name: string | null; words: Map<string, ExportWord> };
type CaptureGroup = { name: string | null; decks: Map<string, CaptureDeck> };

export async function exportAll(conn: StoredConnection): Promise<ExportPayload> {
  const mqtt = (await import('mqtt')).default;
  const client = mqtt.connect(conn.url, {
    username: conn.username || undefined,
    password: conn.password || undefined,
    protocolVersion: 5,
    clean: true,
    resubscribe: false,
    // No auto-reconnect for the export client — it's a one-shot
    // probe. If we drop, surface the error and let the user retry.
    reconnectPeriod: 0,
    connectTimeout: 10_000,
    keepalive: 30,
  });

  const capture = new Map<string, CaptureGroup>();
  let done = false;

  return new Promise<ExportPayload>((resolve, reject) => {
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    const overallTimeout = setTimeout(
      () => finish(new Error('Export timed out')),
      TOTAL_TIMEOUT_MS,
    );

    function finish(err: Error | null): void {
      if (done) return;
      done = true;
      if (drainTimer !== null) clearTimeout(drainTimer);
      clearTimeout(overallTimeout);
      client.end(true);
      if (err) {
        reject(err);
        return;
      }
      const out: ExportPayload = { version: 2, groups: [] };
      for (const g of capture.values()) {
        // A group whose marker we never saw (or saw as a tombstone)
        // is dropped — without a name, we have no way to label it
        // in the export.
        if (g.name === null) continue;
        const decks: ExportDeck[] = [];
        for (const d of g.decks.values()) {
          // Same drop logic for decks; also skip decks with no words
          // since the file is for seeding *content*.
          if (d.name === null) continue;
          if (d.words.size === 0) continue;
          decks.push({ name: d.name, words: Array.from(d.words.values()) });
        }
        if (decks.length === 0) continue;
        out.groups.push({ name: g.name, decks });
      }
      resolve(out);
    }

    function kickDrain(): void {
      if (done) return;
      if (drainTimer !== null) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => finish(null), DRAIN_QUIET_MS);
    }

    function ensureGroup(gid: string): CaptureGroup {
      let cur = capture.get(gid);
      if (!cur) {
        cur = { name: null, decks: new Map() };
        capture.set(gid, cur);
      }
      return cur;
    }

    function ensureDeck(gid: string, did: string): CaptureDeck {
      const g = ensureGroup(gid);
      let cur = g.decks.get(did);
      if (!cur) {
        cur = { name: null, words: new Map() };
        g.decks.set(did, cur);
      }
      return cur;
    }

    client.on('error', (err) => finish(new Error(`Broker error: ${err.message}`)));

    client.on('close', () => {
      if (!done) finish(new Error('Connection closed during export'));
    });

    client.on('message', (topic, payload) => {
      const parsed = parseTopic(conn.prefix, topic);
      if (parsed.kind === 'group') {
        if (payload.byteLength === 0) {
          // Tombstone on the group marker — drop the whole group
          // (its decks / words subtree is implicitly meaningless
          // without the marker).
          capture.delete(parsed.gid);
        } else {
          try {
            const data = JSON.parse(new TextDecoder().decode(payload));
            if (isGroup(data, parsed.gid)) {
              ensureGroup(parsed.gid).name = data.name;
            }
          } catch {
            // Malformed payload — ignore, like the live handler.
          }
        }
      } else if (parsed.kind === 'deck') {
        if (payload.byteLength === 0) {
          // Deck tombstone — drop just this deck (its words subtree
          // is meaningless without the marker).
          ensureGroup(parsed.gid).decks.delete(parsed.did);
        } else {
          try {
            const data = JSON.parse(new TextDecoder().decode(payload));
            if (isDeck(data, parsed.did)) {
              ensureDeck(parsed.gid, parsed.did).name = data.name;
            }
          } catch {
            // ignore
          }
        }
      } else if (parsed.kind === 'word') {
        const d = ensureDeck(parsed.gid, parsed.did);
        if (payload.byteLength === 0) {
          d.words.delete(parsed.id);
        } else {
          try {
            const data = JSON.parse(new TextDecoder().decode(payload));
            if (isWord(data, parsed.id)) {
              d.words.set(parsed.id, { text: data.text, translation: data.translation });
            }
          } catch {
            // ignore
          }
        }
      }
      // parsed.kind === 'srs' | 'settings' | 'unknown': ignored.
      kickDrain();
    });

    client.on('connect', () => {
      client.subscribe(`${conn.prefix}/g/#`, { qos: 1 }, (err) => {
        if (err) {
          finish(new Error(`Subscribe failed: ${err.message}`));
          return;
        }
        // Start the drain timer right after SUBACK so an empty broker
        // (nothing retained) still finishes after DRAIN_QUIET_MS
        // instead of hanging until TOTAL_TIMEOUT_MS.
        kickDrain();
      });
    });
  });
}

export function exportFilename(now: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `mwords-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.json`
  );
}

export function triggerDownload(filename: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
