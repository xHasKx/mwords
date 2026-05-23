export type Group = {
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

export type Settings = {
  srsMode: SrsMode;
  direction: Direction;
  updated: number;
};

export const defaultSettings = (): Settings => ({
  srsMode: 'sm2',
  direction: 'text',
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
