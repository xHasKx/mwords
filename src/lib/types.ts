export type Group = {
  id: string;
  name: string;
  created: number;
  updated: number;
};

export type Deck = {
  id: string;
  name: string;
  created: number;
  updated: number;
};

export type Word = {
  id: string;
  text: string;
  translation: string;
  created: number;
  updated: number;
};

export type Grade = 'again' | 'hard' | 'good' | 'easy';

export type SrsState = {
  id: string;
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  due: number;
  lastGrade: Grade | null;
  reviewCount: number;
  updated: number;
};

export type SrsMode = 'sm2' | 'weighted-random' | 'serial';
export type Direction = 'text' | 'translation';

// Review scope. Controls which words feed the Review picker.
// - 'active-deck' uses activeDeckId.
// - 'decks' is a multi-select across decks in the active group.
// - 'group' is every deck in the active group.
// Edit always operates on the active deck regardless of scope.
export type ReviewScope =
  | { kind: 'active-deck' }
  | { kind: 'decks'; deckIds: string[] }
  | { kind: 'group' };

export type Settings = {
  srsMode: SrsMode;
  direction: Direction;
  // Hours between repeats of a graded card (the unit `intervalDays`
  // multiplies). Default 24 = classic SM-2 in days. Optional in the
  // type for back-compat with Settings published by older versions
  // that didn't have the field; read sites must default to
  // DEFAULT_REPEAT_HOURS when absent.
  repeatHours?: number;
  updated: number;
};

export const DEFAULT_REPEAT_HOURS = 24;

export const defaultSettings = (): Settings => ({
  srsMode: 'sm2',
  direction: 'text',
  repeatHours: DEFAULT_REPEAT_HOURS,
  updated: 0,
});

export const defaultSrs = (id: string): SrsState => ({
  id,
  ease: 2.5,
  intervalDays: 0,
  reps: 0,
  lapses: 0,
  due: Date.now() / 1000,
  lastGrade: null,
  reviewCount: 0,
  updated: 0,
});
