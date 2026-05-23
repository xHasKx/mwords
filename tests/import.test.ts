import { describe, expect, it } from 'vitest';
import { parseImportFile } from '../src/lib/import.ts';

const minimal = {
  version: 1,
  groups: [
    {
      name: 'German A1',
      words: [{ text: 'Hallo', translation: 'Hello' }],
    },
  ],
};

describe('parseImportFile', () => {
  it('accepts a canonical v1 file', () => {
    const r = parseImportFile(JSON.stringify(minimal));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file).toEqual(minimal);
  });

  it('accepts a v1 file with multiple groups and empty word arrays', () => {
    const file = {
      version: 1,
      groups: [
        { name: 'A', words: [] },
        { name: 'B', words: [{ text: 'x', translation: 'y' }] },
      ],
    };
    const r = parseImportFile(JSON.stringify(file));
    expect(r.ok).toBe(true);
  });

  it('rejects invalid JSON', () => {
    const r = parseImportFile('{not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/valid JSON/);
  });

  it('rejects wrong version number', () => {
    const bad = { ...minimal, version: 2 };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects missing groups array', () => {
    const bad = { version: 1 };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects group with empty name', () => {
    const bad = { version: 1, groups: [{ name: '   ', words: [] }] };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects group with non-string name', () => {
    const bad = { version: 1, groups: [{ name: 42, words: [] }] };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects word missing translation', () => {
    const bad = {
      version: 1,
      groups: [{ name: 'A', words: [{ text: 'x' }] }],
    };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects word with empty text', () => {
    const bad = {
      version: 1,
      groups: [{ name: 'A', words: [{ text: '   ', translation: 'y' }] }],
    };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects words array being a non-array', () => {
    const bad = { version: 1, groups: [{ name: 'A', words: 'nope' }] };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects null', () => {
    const r = parseImportFile('null');
    expect(r.ok).toBe(false);
  });
});
