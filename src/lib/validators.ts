import type { Grade, Group, Settings, SrsState, Word } from './types.ts';

function isFiniteNonNeg(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

const GRADES: ReadonlySet<Grade> = new Set(['again', 'hard', 'good', 'easy']);
const SRS_MODES = new Set(['sm2', 'weighted-random', 'serial']);
const DIRECTIONS = new Set(['text', 'translation']);

export function isGroup(x: unknown, topicId: string): x is Group {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id !== topicId) return false;
  if (typeof o.name !== 'string') return false;
  const trimmed = o.name.trim();
  if (trimmed.length < 1 || trimmed.length > 256) return false;
  if (!isFiniteNonNeg(o.created)) return false;
  if (!isFiniteNonNeg(o.updated)) return false;
  if (o.created > o.updated) return false;
  return true;
}

export function isWord(x: unknown, topicId: string): x is Word {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id !== topicId) return false;
  if (typeof o.text !== 'string') return false;
  if (typeof o.translation !== 'string') return false;
  if (!isFiniteNonNeg(o.created)) return false;
  if (!isFiniteNonNeg(o.updated)) return false;
  if (o.created > o.updated) return false;
  return true;
}

export function isSrsState(x: unknown, topicId: string): x is SrsState {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id !== topicId) return false;
  if (!isFiniteNumber(o.ease)) return false;
  if (!isFiniteNumber(o.intervalDays)) return false;
  if (!isFiniteNumber(o.reps)) return false;
  if (!isFiniteNumber(o.lapses)) return false;
  if (!isFiniteNumber(o.due)) return false;
  if (
    o.lastGrade !== null &&
    !(typeof o.lastGrade === 'string' && GRADES.has(o.lastGrade as Grade))
  )
    return false;
  if (!isFiniteNumber(o.reviewCount)) return false;
  if (!isFiniteNonNeg(o.updated)) return false;
  return true;
}

export function isSettings(x: unknown): x is Settings {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.srsMode !== 'string' || !SRS_MODES.has(o.srsMode)) return false;
  if (typeof o.direction !== 'string' || !DIRECTIONS.has(o.direction)) return false;
  if (!isFiniteNonNeg(o.updated)) return false;
  return true;
}
