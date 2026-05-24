import type { Grade, Settings, SrsState, Word } from '../types.ts';
import { pick as sm2pick, transition as sm2transition } from './sm2.ts';
import { pick as weightedPick } from './weighted.ts';
import { pick as serialPick } from './serial.ts';

export type PickArgs = {
  words: Word[];
  srs: Map<string, SrsState>;
  settings: Settings;
  now: number;
  previousId?: string;
  rng?: () => number;
};

export function pickNext(args: PickArgs): Word | null {
  switch (args.settings.srsMode) {
    case 'weighted-random':
      return weightedPick({
        words: args.words,
        srs: args.srs,
        previousId: args.previousId,
        rng: args.rng,
      });
    case 'serial':
      return serialPick({ words: args.words, previousId: args.previousId });
    default:
      return sm2pick({ words: args.words, srs: args.srs, now: args.now });
  }
}

export function applyGrade(
  state: SrsState,
  grade: Grade,
  now: number,
  intervalSeconds?: number,
): SrsState {
  // All three modes write the same fields — sm2 transition keeps history
  // consistent across mode switches.
  return sm2transition(state, grade, now, intervalSeconds);
}
