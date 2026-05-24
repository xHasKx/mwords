import type { ReviewScope } from '../types.ts';

export type StoredConnection = {
  url: string;
  username: string;
  password: string;
  prefix: string;
  lastGroup?: string;
  // Single id, NOT per-group. On boot we sanity-check it resolves to a
  // deck inside `lastGroup` and drop it if not. Cleared when the user
  // switches groups.
  lastDeck?: string;
  // Restored alongside lastDeck. `deckIds` is filtered against the
  // active group's decks on restore; an empty filtered list falls back
  // to `{ kind: 'active-deck' }`.
  lastReviewScope?: ReviewScope;
  autoconnect?: boolean;
};

const KEY = 'mwords:connection';

function isReviewScope(v: unknown): v is ReviewScope {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'active-deck' || o.kind === 'group') return true;
  if (o.kind === 'decks') {
    return Array.isArray(o.deckIds) && o.deckIds.every((d) => typeof d === 'string');
  }
  return false;
}

export function read(): StoredConnection | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredConnection>;
    if (
      typeof v.url !== 'string' ||
      typeof v.username !== 'string' ||
      typeof v.password !== 'string' ||
      typeof v.prefix !== 'string'
    )
      return null;
    return {
      url: v.url,
      username: v.username,
      password: v.password,
      prefix: v.prefix,
      ...(typeof v.lastGroup === 'string' ? { lastGroup: v.lastGroup } : {}),
      ...(typeof v.lastDeck === 'string' ? { lastDeck: v.lastDeck } : {}),
      ...(isReviewScope(v.lastReviewScope) ? { lastReviewScope: v.lastReviewScope } : {}),
      ...(typeof v.autoconnect === 'boolean' ? { autoconnect: v.autoconnect } : {}),
    };
  } catch {
    return null;
  }
}

export function write(conn: StoredConnection): void {
  localStorage.setItem(KEY, JSON.stringify(conn));
}

export function update(patch: Partial<StoredConnection>): void {
  const cur = read();
  if (!cur) return;
  write({ ...cur, ...patch });
}

export function clearLastGroup(): void {
  const cur = read();
  if (!cur) return;
  // Clears lastGroup AND the dependent lastDeck/lastReviewScope in one
  // write — those fields belong to whichever group `lastGroup` named.
  const { lastGroup: _g, lastDeck: _d, lastReviewScope: _s, ...rest } = cur;
  void _g;
  void _d;
  void _s;
  write(rest);
}

export function clearLastDeck(): void {
  const cur = read();
  if (!cur) return;
  const { lastDeck: _d, lastReviewScope: _s, ...rest } = cur;
  void _d;
  void _s;
  write(rest);
}

export function forget(): void {
  localStorage.removeItem(KEY);
}
