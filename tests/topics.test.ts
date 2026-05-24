import { describe, expect, it } from 'vitest';
import {
  settingsTopic,
  groupTopic,
  groupsFilter,
  deckTopic,
  decksFilter,
  wordTopic,
  wordsFilter,
  srsTopic,
  srsFilter,
  parseTopic,
  isValidPrefix,
} from '../src/lib/mqtt/topics.ts';

const P = 'mwords';

describe('topic builders', () => {
  it('settingsTopic', () => {
    expect(settingsTopic(P)).toBe('mwords/settings');
  });

  it('groupTopic and groupsFilter', () => {
    expect(groupTopic(P, '12345')).toBe('mwords/g/12345');
    expect(groupsFilter(P)).toBe('mwords/g/+');
  });

  it('deckTopic and decksFilter', () => {
    expect(deckTopic(P, '12345', '67890')).toBe('mwords/g/12345/d/67890');
    expect(decksFilter(P, '12345')).toBe('mwords/g/12345/d/+');
  });

  it('wordTopic and wordsFilter (group-wide)', () => {
    expect(wordTopic(P, '12345', '67890', '11111')).toBe('mwords/g/12345/d/67890/words/11111');
    expect(wordsFilter(P, '12345')).toBe('mwords/g/12345/d/+/words/+');
  });

  it('srsTopic and srsFilter (group-wide)', () => {
    expect(srsTopic(P, '12345', '67890', '11111')).toBe('mwords/g/12345/d/67890/srs/11111');
    expect(srsFilter(P, '12345')).toBe('mwords/g/12345/d/+/srs/+');
  });

  it('honours non-default prefix', () => {
    expect(wordTopic('myapp', 'g1', 'd1', 'w1')).toBe('myapp/g/g1/d/d1/words/w1');
  });
});

describe('parseTopic — round-trips', () => {
  it('parses settings', () => {
    expect(parseTopic(P, settingsTopic(P))).toEqual({ kind: 'settings' });
  });

  it('parses group', () => {
    expect(parseTopic(P, groupTopic(P, '12345'))).toEqual({ kind: 'group', gid: '12345' });
  });

  it('parses deck', () => {
    expect(parseTopic(P, deckTopic(P, '12345', '67890'))).toEqual({
      kind: 'deck',
      gid: '12345',
      did: '67890',
    });
  });

  it('parses word', () => {
    expect(parseTopic(P, wordTopic(P, '12345', '67890', '11111'))).toEqual({
      kind: 'word',
      gid: '12345',
      did: '67890',
      id: '11111',
    });
  });

  it('parses srs', () => {
    expect(parseTopic(P, srsTopic(P, '12345', '67890', '11111'))).toEqual({
      kind: 'srs',
      gid: '12345',
      did: '67890',
      id: '11111',
    });
  });
});

describe('parseTopic — rejects', () => {
  it('rejects topic outside the prefix', () => {
    expect(parseTopic(P, 'other/settings')).toEqual({ kind: 'unknown' });
  });

  it('rejects a prefix-overlap topic that lacks the / separator', () => {
    // "mwords-other/..." starts with "mwords" but the next char isn't "/".
    expect(parseTopic(P, 'mwords-other/settings')).toEqual({ kind: 'unknown' });
  });

  it('rejects unknown second segment', () => {
    expect(parseTopic(P, 'mwords/foo')).toEqual({ kind: 'unknown' });
  });

  it('rejects malformed group-scoped topic', () => {
    expect(parseTopic(P, 'mwords/g/12345/foo/bar')).toEqual({ kind: 'unknown' });
  });

  it('rejects legacy v1 word topic (no deck level)', () => {
    expect(parseTopic(P, 'mwords/g/12345/words/67890')).toEqual({ kind: 'unknown' });
  });

  it('rejects legacy v1 srs topic (no deck level)', () => {
    expect(parseTopic(P, 'mwords/g/12345/srs/67890')).toEqual({ kind: 'unknown' });
  });

  it('rejects malformed deck-scoped topic', () => {
    expect(parseTopic(P, 'mwords/g/12345/d/67890/foo/bar')).toEqual({ kind: 'unknown' });
  });

  it('rejects extra trailing segments', () => {
    expect(parseTopic(P, 'mwords/g/12345/d/67890/words/11111/extra')).toEqual({
      kind: 'unknown',
    });
  });
});

describe('isValidPrefix', () => {
  it('accepts simple identifiers', () => {
    expect(isValidPrefix('mwords')).toBe(true);
    expect(isValidPrefix('app-1')).toBe(true);
    expect(isValidPrefix('user.kial')).toBe(true);
  });

  it('rejects empty', () => {
    expect(isValidPrefix('')).toBe(false);
  });

  it('rejects MQTT-reserved characters', () => {
    expect(isValidPrefix('a/b')).toBe(false);
    expect(isValidPrefix('a+b')).toBe(false);
    expect(isValidPrefix('a#b')).toBe(false);
  });

  it('rejects whitespace', () => {
    expect(isValidPrefix('with space')).toBe(false);
    expect(isValidPrefix('with\ttab')).toBe(false);
    expect(isValidPrefix('with\nnewline')).toBe(false);
  });

  it('rejects null byte', () => {
    expect(isValidPrefix('a\0b')).toBe(false);
  });
});
