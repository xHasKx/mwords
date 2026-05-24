import { describe, expect, it } from 'vitest';
import { parseImportFile } from '../src/lib/import.ts';

const minimal = {
  version: 2,
  groups: [
    {
      name: 'German',
      decks: [
        {
          name: 'A1 Verbs',
          words: [{ text: 'Hallo', translation: 'Hello' }],
        },
      ],
    },
  ],
};

describe('parseImportFile', () => {
  it('accepts a canonical v2 file', () => {
    const r = parseImportFile(JSON.stringify(minimal));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file).toEqual(minimal);
  });

  it('accepts a v2 file with multiple groups, multiple decks, empty word arrays', () => {
    const file = {
      version: 2,
      groups: [
        {
          name: 'A',
          decks: [
            { name: 'D1', words: [] },
            { name: 'D2', words: [{ text: 'x', translation: 'y' }] },
          ],
        },
        { name: 'B', decks: [{ name: 'D3', words: [] }] },
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

  it('rejects v1 files with a re-export hint', () => {
    const v1 = {
      version: 1,
      groups: [{ name: 'A', words: [{ text: 'x', translation: 'y' }] }],
    };
    const r = parseImportFile(JSON.stringify(v1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/v1.*re-export/i);
  });

  it('rejects unknown version', () => {
    const bad = { ...minimal, version: 3 };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects missing groups array', () => {
    const bad = { version: 2 };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects group with empty name', () => {
    const bad = { version: 2, groups: [{ name: '   ', decks: [] }] };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects group with non-string name', () => {
    const bad = { version: 2, groups: [{ name: 42, decks: [] }] };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects group missing decks array', () => {
    const bad = { version: 2, groups: [{ name: 'A' }] };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects deck with empty name', () => {
    const bad = { version: 2, groups: [{ name: 'A', decks: [{ name: '   ', words: [] }] }] };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects deck missing words array', () => {
    const bad = { version: 2, groups: [{ name: 'A', decks: [{ name: 'D' }] }] };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects word missing translation', () => {
    const bad = {
      version: 2,
      groups: [{ name: 'A', decks: [{ name: 'D', words: [{ text: 'x' }] }] }],
    };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects word with empty text', () => {
    const bad = {
      version: 2,
      groups: [
        {
          name: 'A',
          decks: [{ name: 'D', words: [{ text: '   ', translation: 'y' }] }],
        },
      ],
    };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects deck.words being a non-array', () => {
    const bad = {
      version: 2,
      groups: [{ name: 'A', decks: [{ name: 'D', words: 'nope' }] }],
    };
    const r = parseImportFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects null', () => {
    const r = parseImportFile('null');
    expect(r.ok).toBe(false);
  });
});
