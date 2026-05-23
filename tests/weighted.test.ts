import { describe, expect, it } from 'vitest';
import { pick } from '../src/lib/srs/weighted.ts';
import { defaultSrs, type SrsState, type Word } from '../src/lib/types.ts';

function word(id: string): Word {
  return { id, text: id, translation: id, created: 0, updated: 0 };
}

function srsWith(id: string, lastGrade: SrsState['lastGrade']): SrsState {
  return { ...defaultSrs(id), lastGrade };
}

function seededRng(seed = 1): () => number {
  // Mulberry32 — deterministic, decent distribution for the test.
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('weighted.pick — weight values per srs.md spec', () => {
  it('null lastGrade has weight 1.0 (probability across grades)', () => {
    // Two cards: one with lastGrade=null (weight 1), one with easy (weight 0.3).
    // Expect ~77% null, ~23% easy.
    const words = [word('a'), word('b')];
    const srs = new Map<string, SrsState>([
      ['a', srsWith('a', null)],
      ['b', srsWith('b', 'easy')],
    ]);
    let aCount = 0;
    const rng = seededRng(42);
    for (let i = 0; i < 5_000; i++) {
      const picked = pick({ words, srs, rng });
      if (picked?.id === 'a') aCount++;
    }
    const ratio = aCount / 5_000;
    // Expected ~ 1.0 / (1.0 + 0.3) ≈ 0.769
    expect(ratio).toBeGreaterThan(0.73);
    expect(ratio).toBeLessThan(0.81);
  });

  it('again-heavy is picked more often than good-only', () => {
    // Weights: again=4.0, good=1.0. Expected ~80% again.
    const words = [word('a'), word('g')];
    const srs = new Map<string, SrsState>([
      ['a', srsWith('a', 'again')],
      ['g', srsWith('g', 'good')],
    ]);
    let aCount = 0;
    const rng = seededRng(7);
    for (let i = 0; i < 5_000; i++) {
      const picked = pick({ words, srs, rng });
      if (picked?.id === 'a') aCount++;
    }
    const ratio = aCount / 5_000;
    // Expected ~ 4 / (4 + 1) = 0.8
    expect(ratio).toBeGreaterThan(0.76);
    expect(ratio).toBeLessThan(0.84);
  });

  it('words without SrsState are treated as default (weight 1.0)', () => {
    const words = [word('absent'), word('present')];
    const srs = new Map<string, SrsState>([['present', srsWith('present', 'easy')]]);
    // absent → null grade → weight 1.0; present → easy → 0.3. ~77% absent.
    let absentCount = 0;
    const rng = seededRng(99);
    for (let i = 0; i < 5_000; i++) {
      const picked = pick({ words, srs, rng });
      if (picked?.id === 'absent') absentCount++;
    }
    expect(absentCount / 5_000).toBeGreaterThan(0.73);
  });
});

describe('weighted.pick — immediate-repeat avoidance', () => {
  it('with deck > 1, avoids returning previousId on consecutive picks', () => {
    const words = [word('a'), word('b'), word('c')];
    const srs = new Map<string, SrsState>();
    let prev = 'a';
    let repeats = 0;
    const rng = seededRng(1);
    for (let i = 0; i < 1_000; i++) {
      const picked = pick({ words, srs, previousId: prev, rng });
      if (picked?.id === prev) repeats++;
      prev = picked?.id ?? prev;
    }
    // Should be 0 with the 5-retry budget; allow tiny slack just in case.
    expect(repeats).toBeLessThan(5);
  });

  it('with single-word deck, returns that word even if previousId matches', () => {
    const only = [word('solo')];
    const picked = pick({ words: only, srs: new Map(), previousId: 'solo' });
    expect(picked?.id).toBe('solo');
  });

  it('empty deck returns null', () => {
    expect(pick({ words: [], srs: new Map() })).toBe(null);
  });
});
