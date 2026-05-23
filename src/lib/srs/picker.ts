import type { Grade, Settings, SrsState, Word } from '../types.ts';
import { pick as sm2pick, transition as sm2transition } from './sm2.ts';

export type PickArgs = {
  words: Word[];
  srs: Map<string, SrsState>;
  settings: Settings;
  now: number;
  previousId?: string;
};

export function pickNext(args: PickArgs): Word | null {
  return sm2pick({ words: args.words, srs: args.srs, now: args.now });
}

export function applyGrade(state: SrsState, grade: Grade, now: number): SrsState {
  return sm2transition(state, grade, now);
}
