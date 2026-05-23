import { describe, expect, it } from 'vitest';
import { transition, nextIntervalDaysFor } from '../src/lib/srs/sm2.ts';
import { defaultSrs, type SrsState } from '../src/lib/types.ts';

const NOW = 1_000_000;

function fresh(): SrsState {
  return defaultSrs('w1');
}

describe('sm2.transition', () => {
  it('new card graded good → interval=1, reps=1', () => {
    const next = transition(fresh(), 'good', NOW);
    expect(next.intervalDays).toBe(1);
    expect(next.reps).toBe(1);
    expect(next.lapses).toBe(0);
    expect(next.lastGrade).toBe('good');
  });

  it('second good → interval=6, reps=2', () => {
    const s1 = transition(fresh(), 'good', NOW);
    const s2 = transition(s1, 'good', NOW);
    expect(s2.intervalDays).toBe(6);
    expect(s2.reps).toBe(2);
  });

  it('third good → interval = round(6 * ease) with previous ease', () => {
    const s1 = transition(fresh(), 'good', NOW);
    const s2 = transition(s1, 'good', NOW);
    const easeBeforeThird = s2.ease; // good leaves ease unchanged
    const s3 = transition(s2, 'good', NOW);
    expect(s3.intervalDays).toBe(Math.round(6 * easeBeforeThird));
    expect(s3.reps).toBe(3);
  });

  it('good leaves ease unchanged', () => {
    const s1 = transition(fresh(), 'good', NOW);
    expect(s1.ease).toBeCloseTo(2.5);
  });

  it('easy grows ease by 0.1', () => {
    const s1 = transition(fresh(), 'easy', NOW);
    expect(s1.ease).toBeCloseTo(2.6);
  });

  it('hard shrinks ease by ~0.14', () => {
    const s1 = transition(fresh(), 'hard', NOW);
    expect(s1.ease).toBeCloseTo(2.36);
  });

  it('again resets reps to 0, lapses += 1, ease drops by 0.8', () => {
    const s = transition(fresh(), 'again', NOW);
    expect(s.reps).toBe(0);
    expect(s.lapses).toBe(1);
    expect(s.intervalDays).toBe(0);
    // 2.5 + (0.1 - 5 * (0.08 + 5 * 0.02)) = 2.5 - 0.8 = 1.7. Floor is 1.3,
    // so a single Again from default ease lands at 1.7, not 1.3.
    expect(s.ease).toBeCloseTo(1.7, 5);
    expect(s.ease).toBeGreaterThanOrEqual(1.3);
  });

  it('repeated again clamps ease to 1.3 floor', () => {
    let s = fresh();
    for (let i = 0; i < 10; i++) s = transition(s, 'again', NOW);
    expect(s.ease).toBe(1.3);
    expect(s.lapses).toBe(10);
  });

  it('due advances by exactly intervalDays * 86400 from now', () => {
    const s1 = transition(fresh(), 'good', NOW);
    expect(s1.due).toBe(NOW + 1 * 86_400);
    const s2 = transition(s1, 'good', NOW + 100);
    expect(s2.due).toBe(NOW + 100 + 6 * 86_400);
  });

  it('reviewCount increments', () => {
    const s1 = transition(fresh(), 'good', NOW);
    const s2 = transition(s1, 'again', NOW);
    expect(s2.reviewCount).toBe(2);
  });

  it('updated equals the passed now', () => {
    const s = transition(fresh(), 'good', NOW);
    expect(s.updated).toBe(NOW);
  });
});

describe('sm2.transition: ease floor on single Again', () => {
  it('first Again drops ease by 0.8 (from 2.5 to 1.7), not to 1.3', () => {
    const s = transition(fresh(), 'again', NOW);
    expect(s.ease).toBeCloseTo(1.7, 5);
  });

  it('Again from ease=2.0 clamps at 1.3 floor', () => {
    // 2.0 - 0.8 = 1.2 in math; clamp to 1.3.
    const seed: SrsState = { ...defaultSrs('w1'), ease: 2.0 };
    const s = transition(seed, 'again', NOW);
    expect(s.ease).toBe(1.3);
  });
});

describe('nextIntervalDaysFor (preview helper)', () => {
  it('matches transition for good on a fresh card', () => {
    const fresh1 = fresh();
    const previewed = nextIntervalDaysFor(fresh1, 'good');
    const applied = transition(fresh1, 'good', NOW);
    expect(previewed).toBe(applied.intervalDays);
  });

  it('again previews 0', () => {
    expect(nextIntervalDaysFor(fresh(), 'again')).toBe(0);
  });
});
