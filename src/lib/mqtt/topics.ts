export const settingsTopic = (prefix: string) => `${prefix}/settings`;

export const groupTopic = (prefix: string, gid: string) => `${prefix}/g/${gid}`;
export const groupsFilter = (prefix: string) => `${prefix}/g/+`;

export const deckTopic = (prefix: string, gid: string, did: string) =>
  `${prefix}/g/${gid}/d/${did}`;
export const decksFilter = (prefix: string, gid: string) => `${prefix}/g/${gid}/d/+`;

export const wordTopic = (prefix: string, gid: string, did: string, id: string) =>
  `${prefix}/g/${gid}/d/${did}/words/${id}`;
// Whole-group word filter — wildcards over every deck. v2 has no
// per-deck word filter; switching decks within a group is in-memory.
export const wordsFilter = (prefix: string, gid: string) => `${prefix}/g/${gid}/d/+/words/+`;

export const srsTopic = (prefix: string, gid: string, did: string, id: string) =>
  `${prefix}/g/${gid}/d/${did}/srs/${id}`;
export const srsFilter = (prefix: string, gid: string) => `${prefix}/g/${gid}/d/+/srs/+`;

export type ParsedTopic =
  | { kind: 'settings' }
  | { kind: 'group'; gid: string }
  | { kind: 'deck'; gid: string; did: string }
  | { kind: 'word'; gid: string; did: string; id: string }
  | { kind: 'srs'; gid: string; did: string; id: string }
  | { kind: 'unknown' };

export function parseTopic(prefix: string, topic: string): ParsedTopic {
  if (!topic.startsWith(`${prefix}/`)) return { kind: 'unknown' };
  const rest = topic.slice(prefix.length + 1);
  const parts = rest.split('/');
  if (parts.length === 1 && parts[0] === 'settings') return { kind: 'settings' };
  if (parts.length === 2 && parts[0] === 'g') return { kind: 'group', gid: parts[1] };
  if (parts.length === 4 && parts[0] === 'g' && parts[2] === 'd') {
    return { kind: 'deck', gid: parts[1], did: parts[3] };
  }
  if (parts.length === 6 && parts[0] === 'g' && parts[2] === 'd') {
    if (parts[4] === 'words') {
      return { kind: 'word', gid: parts[1], did: parts[3], id: parts[5] };
    }
    if (parts[4] === 'srs') {
      return { kind: 'srs', gid: parts[1], did: parts[3], id: parts[5] };
    }
  }
  return { kind: 'unknown' };
}

const PREFIX_RE = /^[^\s/+#\0]+$/;
export const isValidPrefix = (p: string) => PREFIX_RE.test(p);
