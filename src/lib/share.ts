// URL-safe base64 wrappers over the four-field connection payload used for
// "share connection" links. Not encryption — base64 is just obfuscation so
// credentials aren't directly readable from an address bar.

export type SharePayload = {
  url: string;
  username: string;
  password: string;
  prefix: string;
};

function b64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlDecode(s: string): Uint8Array {
  let padded = s.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4) padded += '=';
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeShare(p: SharePayload): string {
  const json = JSON.stringify({
    url: p.url,
    username: p.username,
    password: p.password,
    prefix: p.prefix,
  });
  return b64UrlEncode(new TextEncoder().encode(json));
}

export function decodeShare(s: string): SharePayload | null {
  try {
    const bytes = b64UrlDecode(s);
    const json = new TextDecoder().decode(bytes);
    const v = JSON.parse(json) as Partial<SharePayload>;
    if (
      typeof v.url !== 'string' ||
      typeof v.username !== 'string' ||
      typeof v.password !== 'string' ||
      typeof v.prefix !== 'string'
    ) {
      return null;
    }
    return {
      url: v.url,
      username: v.username,
      password: v.password,
      prefix: v.prefix,
    };
  } catch {
    return null;
  }
}
