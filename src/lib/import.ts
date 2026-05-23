export type ImportWord = { text: string; translation: string };
export type ImportGroup = { name: string; words: ImportWord[] };
export type ImportFile = { version: 1; groups: ImportGroup[] };

const MAX_NAME = 256;

function isImportWord(x: unknown): x is ImportWord {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.text !== 'string' || o.text.trim().length === 0) return false;
  if (typeof o.translation !== 'string' || o.translation.trim().length === 0) return false;
  return true;
}

function isImportGroup(x: unknown): x is ImportGroup {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.name !== 'string') return false;
  const trimmed = o.name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_NAME) return false;
  if (!Array.isArray(o.words)) return false;
  for (const w of o.words) {
    if (!isImportWord(w)) return false;
  }
  return true;
}

export function isImportFile(x: unknown): x is ImportFile {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (!Array.isArray(o.groups)) return false;
  for (const g of o.groups) {
    if (!isImportGroup(g)) return false;
  }
  return true;
}

export type ParseResult = { ok: true; file: ImportFile } | { ok: false; error: string };

export function parseImportFile(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not a valid JSON file.' };
  }
  if (!isImportFile(json)) {
    return {
      ok: false,
      error: 'File does not match the mwords v1 export schema.',
    };
  }
  return { ok: true, file: json };
}
