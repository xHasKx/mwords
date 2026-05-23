export const settingsTopic = (prefix: string) => `${prefix}/settings`;
export const groupTopic = (prefix: string, gid: string) => `${prefix}/g/${gid}`;
export const groupsFilter = (prefix: string) => `${prefix}/g/+`;
export const wordTopic = (prefix: string, gid: string, id: string) =>
  `${prefix}/g/${gid}/words/${id}`;
export const wordsFilter = (prefix: string, gid: string) => `${prefix}/g/${gid}/words/+`;
export const srsTopic = (prefix: string, gid: string, id: string) => `${prefix}/g/${gid}/srs/${id}`;
export const srsFilter = (prefix: string, gid: string) => `${prefix}/g/${gid}/srs/+`;

export type ParsedTopic =
  | { kind: 'group'; gid: string }
  | { kind: 'settings' }
  | { kind: 'word'; gid: string; id: string }
  | { kind: 'srs'; gid: string; id: string }
  | { kind: 'unknown' };

export function parseTopic(prefix: string, topic: string): ParsedTopic {
  if (!topic.startsWith(`${prefix}/`)) return { kind: 'unknown' };
  const rest = topic.slice(prefix.length + 1);
  const parts = rest.split('/');
  if (parts.length === 1 && parts[0] === 'settings') return { kind: 'settings' };
  if (parts.length === 2 && parts[0] === 'g') return { kind: 'group', gid: parts[1] };
  if (parts.length === 4 && parts[0] === 'g') {
    if (parts[2] === 'words') return { kind: 'word', gid: parts[1], id: parts[3] };
    if (parts[2] === 'srs') return { kind: 'srs', gid: parts[1], id: parts[3] };
  }
  return { kind: 'unknown' };
}

const PREFIX_RE = /^[^\s/+#\0]+$/;
export const isValidPrefix = (p: string) => PREFIX_RE.test(p);
