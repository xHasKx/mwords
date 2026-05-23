import type { Word } from '../types.ts';

export const compareWords = (a: Word, b: Word): number => Number(a.id) - Number(b.id);

export function pick(args: { words: Word[]; previousId?: string }): Word | null {
  if (args.words.length === 0) return null;
  const ordered = [...args.words].sort(compareWords);
  if (args.previousId === undefined) return ordered[0];
  const i = ordered.findIndex((w) => w.id === args.previousId);
  if (i === -1) return ordered[0];
  return ordered[(i + 1) % ordered.length];
}
