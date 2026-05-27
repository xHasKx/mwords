import type { Grade, SrsState, Word } from '../types.ts';

const QUALITY: Record<Grade, number> = {
  again: 0,
  hard: 3,
  good: 4,
  easy: 5,
};

// Anki-style modifiers layered onto the classic SM-2 schedule so the
// three passing grades produce distinct intervals instead of all three
// snapping to the same step.
const HARD_FACTOR = 1.2;
const EASY_BONUS = 1.3;

// Seconds per `intervalDays` unit. The "day" in the SM-2 model is one
// repeat interval; mwords lets the user shorten/extend it via the
// Settings → Repeat interval control. Default 86_400 = 24h, matching
// classic SM-2 in days.
export const DEFAULT_INTERVAL_SECONDS = 86_400;

export function transition(
  state: SrsState,
  grade: Grade,
  now: number,
  intervalSeconds: number = DEFAULT_INTERVAL_SECONDS,
): SrsState {
  const q = QUALITY[grade];
  const nextDays = nextIntervalDaysFor(state, grade);

  let { ease, reps, lapses } = state;

  if (q < 3) {
    reps = 0;
    lapses += 1;
  } else {
    reps += 1;
  }

  ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

  return {
    id: state.id,
    ease,
    intervalDays: nextDays,
    reps,
    lapses,
    due: now + nextDays * intervalSeconds,
    lastGrade: grade,
    reviewCount: state.reviewCount + 1,
    updated: now,
  };
}

export function nextIntervalDaysFor(state: SrsState, grade: Grade): number {
  if (grade === 'again') return 0;
  if (state.reps === 0) {
    if (grade === 'hard') return 1;
    if (grade === 'good') return 2;
    return 4;
  }
  if (state.reps === 1) {
    if (grade === 'hard') return 3;
    if (grade === 'good') return 6;
    return Math.round(6 * EASY_BONUS);
  }
  // Mature card — multiply the prior interval, never letting Hard stall
  // (must grow by at least one unit) and giving Easy the standard bonus.
  if (grade === 'hard') {
    return Math.max(state.intervalDays + 1, Math.round(state.intervalDays * HARD_FACTOR));
  }
  if (grade === 'good') return Math.round(state.intervalDays * state.ease);
  return Math.round(state.intervalDays * state.ease * EASY_BONUS);
}

export function pick(args: {
  words: Word[];
  srs: Map<string, SrsState>;
  now: number;
}): Word | null {
  const due: { word: Word; dueAt: number }[] = [];
  for (const word of args.words) {
    const st = args.srs.get(word.id);
    const dueAt = st ? st.due : args.now;
    if (dueAt <= args.now) due.push({ word, dueAt });
  }
  if (due.length === 0) return null;
  due.sort((a, b) => a.dueAt - b.dueAt || Number(a.word.id) - Number(b.word.id));
  return due[0].word;
}
