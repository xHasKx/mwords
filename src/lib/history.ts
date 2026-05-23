// Synthetic browser-history intent model. See docs/design.md → "Back navigation".
//
// The app's navigable state is reduced to an Intent and stored under
// `history.state.mwords`. The store pushes/replaces entries through
// `pushIntent` / `replaceIntent`; a popstate listener feeds popped intents
// back via `reconcileOnPop` and `applyIntent`.

export type View = 'connect' | 'picker' | 'review' | 'edit' | 'settings';

export type ModalState =
  | { kind: 'word-editor'; wordId?: string }
  | { kind: 'rename-group'; groupId: string };

export type PickerReturn = 'review' | 'edit' | 'settings';

export type Intent = {
  view: View;
  modal?: ModalState;
  pickerReturn?: PickerReturn;
};

export const STATE_KEY = 'mwords';

const VIEWS: ReadonlySet<View> = new Set(['connect', 'picker', 'review', 'edit', 'settings']);
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
  // pickerReturn only meaningful when view === 'picker'.
  if (o.pickerReturn !== undefined && o.view !== 'picker') return false;
  return true;
}

export function readIntent(state: unknown): Intent | null {
  if (!state || typeof state !== 'object') return null;
  const wrapped = (state as Record<string, unknown>)[STATE_KEY];
  return isIntent(wrapped) ? wrapped : null;
}

// Decide how to handle a popped intent given the app's current connection.
// Stale forward entries (e.g., a `view: 'review'` entry surviving a
// disconnect) are caught here and forced back to the connect form so the
// UI doesn't render a state the store can't support.
export function reconcileOnPop(
  popped: Intent,
  conn: { connected: boolean; hasActiveGroup: boolean },
): { action: 'apply'; intent: Intent } | { action: 'reset-to-connect' } {
  const needsConn = popped.view !== 'connect';
  const needsGroup =
    popped.view === 'review' || popped.view === 'edit' || popped.view === 'settings';
  if (needsConn && !conn.connected) return { action: 'reset-to-connect' };
  if (needsGroup && !conn.hasActiveGroup) return { action: 'reset-to-connect' };
  return { action: 'apply', intent: popped };
}
