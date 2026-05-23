import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare } from '../src/lib/share.ts';

describe('encode/decodeShare', () => {
  it('round-trips an ASCII payload', () => {
    const payload = {
      url: 'wss://mqtt.example.com:8884/mqtt',
      username: 'alice',
      password: 'hunter2',
      prefix: 'u123/mwords',
    };
    const out = decodeShare(encodeShare(payload));
    expect(out).toEqual(payload);
  });

  it('round-trips a unicode password', () => {
    const payload = {
      url: 'wss://broker.test',
      username: 'юзер',
      password: 'пароль🔑',
      prefix: 'préfix/mots',
    };
    const out = decodeShare(encodeShare(payload));
    expect(out).toEqual(payload);
  });

  it('produces url-safe output (no +, /, =)', () => {
    const encoded = encodeShare({
      url: 'wss://x',
      // Crafted to force "+" and "/" in standard base64.
      username: '???>>>',
      password: '<<<<<<',
      prefix: 'p',
    });
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('rejects garbage base64', () => {
    expect(decodeShare('not-valid-base64-$$$')).toBeNull();
  });

  it('rejects valid base64 of non-JSON', () => {
    const notJson = btoa('hello world').replace(/=+$/, '');
    expect(decodeShare(notJson)).toBeNull();
  });

  it('rejects valid JSON missing required fields', () => {
    const incomplete = btoa(JSON.stringify({ url: 'wss://x' })).replace(/=+$/, '');
    expect(decodeShare(incomplete)).toBeNull();
  });

  it('rejects valid JSON with wrong types', () => {
    const wrong = btoa(
      JSON.stringify({ url: 1, username: 'a', password: 'b', prefix: 'c' }),
    ).replace(/=+$/, '');
    expect(decodeShare(wrong)).toBeNull();
  });
});
