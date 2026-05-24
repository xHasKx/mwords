import type { Grade, SrsState, Word } from '../types.ts';

const QUALITY: Record<Grade, number> = {
  again: 0,
  hard: 3,
  good: 4,
  easy: 5,
};

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

  let { ease, reps, intervalDays, lapses } = state;

  if (q < 3) {
    reps = 0;
    intervalDays = 0;
    lapses += 1;
  } else {
    if (reps === 0) intervalDays = 1;
    else if (reps === 1) intervalDays = 6;
    else intervalDays = Math.round(intervalDays * ease);
    reps += 1;
  }

  ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

  return {
    id: state.id,
    ease,
    intervalDays,
    reps,
    lapses,
    due: now + intervalDays * intervalSeconds,
    lastGrade: grade,
    reviewCount: state.reviewCount + 1,
    updated: now,
  };
}

export function nextIntervalDaysFor(state: SrsState, grade: Grade): number {
  const q = QUALITY[grade];
  if (q < 3) return 0;
  if (state.reps === 0) return 1;
  if (state.reps === 1) return 6;
  return Math.round(state.intervalDays * state.ease);
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
