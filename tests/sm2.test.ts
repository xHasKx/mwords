import { describe, expect, it } from 'vitest';
import { transition, nextIntervalDaysFor } from '../src/lib/srs/sm2.ts';
import { defaultSrs, type SrsState } from '../src/lib/types.ts';

const NOW = 1_000_000;

function fresh(): SrsState {
  return defaultSrs('w1');
}

describe('sm2.transition', () => {
  it('new card graded good → interval=2, reps=1', () => {
    const next = transition(fresh(), 'good', NOW);
    expect(next.intervalDays).toBe(2);
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

  it('grades on a fresh card differentiate: hard=1, good=2, easy=4', () => {
    expect(transition(fresh(), 'hard', NOW).intervalDays).toBe(1);
    expect(transition(fresh(), 'good', NOW).intervalDays).toBe(2);
    expect(transition(fresh(), 'easy', NOW).intervalDays).toBe(4);
  });

  it('reps=1 grades: hard=3, good=6, easy=round(6*1.3)=8', () => {
    const s1 = transition(fresh(), 'good', NOW);
    expect(transition(s1, 'hard', NOW).intervalDays).toBe(3);
    expect(transition(s1, 'good', NOW).intervalDays).toBe(6);
    expect(transition(s1, 'easy', NOW).intervalDays).toBe(8);
  });

  it('mature hard grows by at least one unit (never stalls)', () => {
    // intervalDays=2 from reps=1: hard multiplier 1.2 → 2.4 → round 2, but
    // the +1 floor bumps it to 3 so progress isn't lost on Hard.
    const seed: SrsState = { ...defaultSrs('w1'), reps: 2, intervalDays: 2, ease: 2.5 };
    expect(nextIntervalDaysFor(seed, 'hard')).toBe(3);
  });

  it('mature easy = round(intervalDays * ease * 1.3)', () => {
    const seed: SrsState = { ...defaultSrs('w1'), reps: 5, intervalDays: 10, ease: 2.5 };
    expect(nextIntervalDaysFor(seed, 'easy')).toBe(Math.round(10 * 2.5 * 1.3));
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

  it('due advances by exactly intervalDays * 86400 from now (default)', () => {
    const s1 = transition(fresh(), 'good', NOW);
    expect(s1.due).toBe(NOW + 2 * 86_400);
    const s2 = transition(s1, 'good', NOW + 100);
    expect(s2.due).toBe(NOW + 100 + 6 * 86_400);
  });

  it('due honours a custom intervalSeconds (12 hours)', () => {
    const TWELVE_H = 12 * 3600;
    const s1 = transition(fresh(), 'good', NOW, TWELVE_H);
    expect(s1.due).toBe(NOW + 2 * TWELVE_H);
    const s2 = transition(s1, 'good', NOW + 100, TWELVE_H);
    expect(s2.due).toBe(NOW + 100 + 6 * TWELVE_H);
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
