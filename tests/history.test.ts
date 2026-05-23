import { describe, expect, it } from 'vitest';
import {
  type Intent,
  STATE_KEY,
  isIntent,
  readIntent,
  reconcileOnPop,
} from '../src/lib/history.ts';

describe('isIntent', () => {
  it('accepts a minimal connect intent', () => {
    expect(isIntent({ view: 'connect' })).toBe(true);
  });

  it('accepts every valid view', () => {
    for (const v of ['connect', 'picker', 'review', 'edit', 'settings']) {
      expect(isIntent({ view: v })).toBe(true);
    }
  });

  it('rejects unknown view', () => {
    expect(isIntent({ view: 'home' })).toBe(false);
  });

  it('rejects missing view', () => {
    expect(isIntent({})).toBe(false);
    expect(isIntent({ modal: { kind: 'word-editor' } })).toBe(false);
  });

  it('accepts word-editor modal with and without wordId', () => {
    expect(isIntent({ view: 'edit', modal: { kind: 'word-editor' } })).toBe(true);
    expect(isIntent({ view: 'edit', modal: { kind: 'word-editor', wordId: 'w1' } })).toBe(true);
  });

  it('rejects word-editor modal with non-string wordId', () => {
    expect(isIntent({ view: 'edit', modal: { kind: 'word-editor', wordId: 42 } })).toBe(false);
  });

  it('accepts rename-group modal', () => {
    expect(isIntent({ view: 'picker', modal: { kind: 'rename-group', groupId: 'g1' } })).toBe(true);
  });

  it('rejects rename-group modal without groupId', () => {
    expect(isIntent({ view: 'picker', modal: { kind: 'rename-group' } })).toBe(false);
  });

  it('rejects unknown modal kind', () => {
    expect(isIntent({ view: 'picker', modal: { kind: 'mystery' } })).toBe(false);
  });

  it('accepts pickerReturn on picker view', () => {
    expect(isIntent({ view: 'picker', pickerReturn: 'review' })).toBe(true);
  });

  it('rejects pickerReturn outside picker view', () => {
    expect(isIntent({ view: 'review', pickerReturn: 'edit' })).toBe(false);
  });

  it('rejects invalid pickerReturn value', () => {
    expect(isIntent({ view: 'picker', pickerReturn: 'connect' })).toBe(false);
  });

  it('rejects null/undefined/primitives', () => {
    expect(isIntent(null)).toBe(false);
    expect(isIntent(undefined)).toBe(false);
    expect(isIntent('connect')).toBe(false);
    expect(isIntent(42)).toBe(false);
  });
});

describe('readIntent', () => {
  it('reads an intent from the wrapped state shape', () => {
    const intent: Intent = { view: 'review' };
    expect(readIntent({ [STATE_KEY]: intent })).toEqual(intent);
  });

  it('returns null on missing key', () => {
    expect(readIntent({})).toBeNull();
    expect(readIntent({ other: { view: 'review' } })).toBeNull();
  });

  it('returns null when wrapped value is invalid', () => {
    expect(readIntent({ [STATE_KEY]: { view: 'mystery' } })).toBeNull();
  });

  it('returns null on null / non-object state', () => {
    expect(readIntent(null)).toBeNull();
    expect(readIntent(undefined)).toBeNull();
    expect(readIntent(42)).toBeNull();
  });
});

describe('reconcileOnPop', () => {
  const connected = { connected: true, hasActiveGroup: true };
  const disconnected = { connected: false, hasActiveGroup: false };
  const connectedNoGroup = { connected: true, hasActiveGroup: false };

  it('applies a connect intent regardless of connection', () => {
    expect(reconcileOnPop({ view: 'connect' }, disconnected)).toEqual({
      action: 'apply',
      intent: { view: 'connect' },
    });
    expect(reconcileOnPop({ view: 'connect' }, connected)).toEqual({
      action: 'apply',
      intent: { view: 'connect' },
    });
  });

  it('applies picker when connected (group not required)', () => {
    expect(reconcileOnPop({ view: 'picker' }, connectedNoGroup)).toEqual({
      action: 'apply',
      intent: { view: 'picker' },
    });
  });

  it('resets picker to connect when disconnected', () => {
    expect(reconcileOnPop({ view: 'picker' }, disconnected)).toEqual({
      action: 'reset-to-connect',
    });
  });

  it.each([
    'review' as const,
    'edit' as const,
    'settings' as const,
  ])('resets %s to connect when disconnected', (view) => {
    expect(reconcileOnPop({ view }, disconnected)).toEqual({ action: 'reset-to-connect' });
  });

  it.each([
    'review' as const,
    'edit' as const,
    'settings' as const,
  ])('resets %s to connect when no active group', (view) => {
    expect(reconcileOnPop({ view }, connectedNoGroup)).toEqual({ action: 'reset-to-connect' });
  });

  it.each([
    'review' as const,
    'edit' as const,
    'settings' as const,
  ])('applies %s when connected with active group', (view) => {
    expect(reconcileOnPop({ view }, connected)).toEqual({
      action: 'apply',
      intent: { view },
    });
  });

  it('preserves modal and pickerReturn on apply', () => {
    const intent: Intent = {
      view: 'picker',
      modal: { kind: 'rename-group', groupId: 'g1' },
      pickerReturn: 'review',
    };
    expect(reconcileOnPop(intent, connected)).toEqual({ action: 'apply', intent });
  });
});
