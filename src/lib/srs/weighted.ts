import type { Grade, SrsState, Word } from '../types.ts';
import { defaultSrs } from '../types.ts';

const WEIGHTS: Record<Exclude<Grade, never> | 'null', number> = {
  null: 1.0,
  again: 4.0,
  hard: 2.0,
  good: 1.0,
  easy: 0.3,
};

function weight(st: SrsState): number {
  const key = (st.lastGrade ?? 'null') as keyof typeof WEIGHTS;
  return WEIGHTS[key];
}

export function pick(args: {
  words: Word[];
  srs: Map<string, SrsState>;
  previousId?: string;
  rng?: () => number;
}): Word | null {
  if (args.words.length === 0) return null;
  const rng = args.rng ?? Math.random;
  const weights = args.words.map((w) =>
    weight(args.srs.get(w.id) ?? defaultSrs(w.id)),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return args.words[0];

  for (let attempt = 0; attempt < 5; attempt++) {
    let r = rng() * total;
    let i = 0;
    for (; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) break;
    }
    const picked = args.words[Math.min(i, args.words.length - 1)];
    if (picked.id !== args.previousId || args.words.length === 1) {
      return picked;
    }
  }
  return args.words[0];
}
