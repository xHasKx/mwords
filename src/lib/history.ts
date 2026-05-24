// Synthetic browser-history intent model. See docs/design.md → "Back navigation".
//
// The app's navigable state is reduced to an Intent and stored under
// `history.state.mwords`. The store pushes/replaces entries through
// `pushIntent` / `replaceIntent`; a popstate listener feeds popped intents
// back via `reconcileOnPop` and `applyIntent`.

export type View = 'connect' | 'picker' | 'deck-picker' | 'review' | 'edit' | 'settings';

export type ModalState =
  | { kind: 'word-editor'; wordId?: string }
  | { kind: 'rename-group'; groupId: string }
  | { kind: 'rename-deck'; deckId: string };

export type PickerReturn = 'review' | 'edit' | 'settings';

export type Intent = {
  view: View;
  modal?: ModalState;
  pickerReturn?: PickerReturn;
};

export const STATE_KEY = 'mwords';

const VIEWS: ReadonlySet<View> = new Set([
  'connect',
  'picker',
  'deck-picker',
  'review',
  'edit',
  'settings',
]);
const PICKER_RETURNS: ReadonlySet<PickerReturn> = new Set(['review', 'edit', 'settings']);

function isModalState(v: unknown): v is ModalState {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'word-editor') {
    return o.wordId === undefined || typeof o.wordId === 'string';
  }
  if (o.kind === 'rename-group') {
    return typeof o.groupId === 'string';
  }
  if (o.kind === 'rename-deck') {
    return typeof o.deckId === 'string';
  }
  return false;
}

export function isIntent(v: unknown): v is Intent {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.view !== 'string' || !VIEWS.has(o.view as View)) return false;
  if (o.modal !== undefined && !isModalState(o.modal)) return false;
  if (o.pickerReturn !== undefined && !PICKER_RETURNS.has(o.pickerReturn as PickerReturn)) {
    return false;
  }
  // pickerReturn is meaningful for both picker steps in the chain
  // (group picker → deck picker → final destination).
  if (o.pickerReturn !== undefined && o.view !== 'picker' && o.view !== 'deck-picker') {
    return false;
  }
  return true;
}

export function readIntent(state: unknown): Intent | null {
  if (!state || typeof state !== 'object') return null;
  const wrapped = (state as Record<string, unknown>)[STATE_KEY];
  return isIntent(wrapped) ? wrapped : null;
}

// Decide how to handle a popped intent given the app's current connection
// and group/deck context. Stale forward entries (e.g., a `view: 'review'`
// entry surviving a disconnect, or a `view: 'edit'` entry after the deck
// the user was editing was tombstoned) are caught here and forced to the
// closest supportable view.
//
// Preconditions per design.md:
//   - edit:        connected + active group + active deck.
//   - review:      connected + active group. (Broad scopes — "All decks"
//                  and multi-select — deliberately reach review without
//                  an active deck. ReviewView handles the empty
//                  active-deck case gracefully.)
//   - deck-picker: connected + active group.
//   - picker:      connected.
//   - settings:    connected only (Settings is global; Disconnect must
//                  be reachable from a fresh-group state).
//   - connect:     no preconditions.
export function reconcileOnPop(
  popped: Intent,
  ctx: { connected: boolean; hasActiveGroup: boolean; hasActiveDeck: boolean },
): { action: 'apply'; intent: Intent } | { action: 'fallback'; intent: Intent } {
  const needsConn = popped.view !== 'connect';
  const needsGroup =
    popped.view === 'deck-picker' ||
    popped.view === 'review' ||
    popped.view === 'edit' ||
    popped.view === 'settings';
  const needsDeck = popped.view === 'edit';

  if (needsConn && !ctx.connected) {
    return { action: 'fallback', intent: { view: 'connect' } };
  }
  if (needsGroup && !ctx.hasActiveGroup) {
    return { action: 'fallback', intent: { view: 'picker' } };
  }
  if (needsDeck && !ctx.hasActiveDeck) {
    return { action: 'fallback', intent: { view: 'deck-picker' } };
  }
  return { action: 'apply', intent: popped };
}
