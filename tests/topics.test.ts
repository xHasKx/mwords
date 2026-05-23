import { describe, expect, it } from 'vitest';
import {
  settingsTopic,
  groupTopic,
  groupsFilter,
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

  it('wordTopic and wordsFilter', () => {
    expect(wordTopic(P, '12345', '67890')).toBe('mwords/g/12345/words/67890');
    expect(wordsFilter(P, '12345')).toBe('mwords/g/12345/words/+');
  });

  it('srsTopic and srsFilter', () => {
    expect(srsTopic(P, '12345', '67890')).toBe('mwords/g/12345/srs/67890');
    expect(srsFilter(P, '12345')).toBe('mwords/g/12345/srs/+');
  });

  it('honours non-default prefix', () => {
    expect(wordTopic('myapp', 'g1', 'w1')).toBe('myapp/g/g1/words/w1');
  });
});

describe('parseTopic — round-trips', () => {
  it('parses settings', () => {
    expect(parseTopic(P, settingsTopic(P))).toEqual({ kind: 'settings' });
  });

  it('parses group', () => {
    expect(parseTopic(P, groupTopic(P, '12345'))).toEqual({ kind: 'group', gid: '12345' });
  });

  it('parses word', () => {
    expect(parseTopic(P, wordTopic(P, '12345', '67890'))).toEqual({
      kind: 'word',
      gid: '12345',
      id: '67890',
    });
  });

  it('parses srs', () => {
    expect(parseTopic(P, srsTopic(P, '12345', '67890'))).toEqual({
      kind: 'srs',
      gid: '12345',
      id: '67890',
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

  it('rejects extra trailing segments', () => {
    expect(parseTopic(P, 'mwords/g/12345/words/67890/extra')).toEqual({ kind: 'unknown' });
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
