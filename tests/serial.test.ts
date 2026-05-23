import { describe, expect, it } from 'vitest';
import { compareWords, pick } from '../src/lib/srs/serial.ts';
import type { Word } from '../src/lib/types.ts';

function word(id: string): Word {
  return { id, text: id, translation: id, created: 0, updated: 0 };
}

describe('serial.pick', () => {
  it('empty deck returns null', () => {
    expect(pick({ words: [] })).toBe(null);
  });

  it('no previousId → returns first in compareWords order (lowest id)', () => {
    // Pass them in non-ascending order to confirm the sort kicks in.
    const words = [word('3'), word('1'), word('2')];
    expect(pick({ words })?.id).toBe('1');
  });

  it('middle previousId → returns next', () => {
    const words = [word('1'), word('2'), word('3')];
    expect(pick({ words, previousId: '2' })?.id).toBe('3');
  });

  it('last previousId → wraps to first', () => {
    const words = [word('1'), word('2'), word('3')];
    expect(pick({ words, previousId: '3' })?.id).toBe('1');
  });

  it('previousId not present → returns first', () => {
    const words = [word('1'), word('2'), word('3')];
    expect(pick({ words, previousId: '99' })?.id).toBe('1');
  });

  it('order is stable across calls with same input', () => {
    const words = [word('3'), word('1'), word('2')];
    const seq: string[] = [];
    let prev: string | undefined;
    for (let i = 0; i < 6; i++) {
      const got = pick({ words, previousId: prev });
      seq.push(got!.id);
      prev = got!.id;
    }
    expect(seq).toEqual(['1', '2', '3', '1', '2', '3']);
  });

  it('compareWords compares ids numerically (not lexicographically)', () => {
    // "10" < "2" lexicographically; numerically 10 > 2.
    const a = word('10');
    const b = word('2');
    expect(compareWords(a, b)).toBeGreaterThan(0);
    expect([b, a].sort(compareWords).map((w) => w.id)).toEqual(['2', '10']);
  });
});
