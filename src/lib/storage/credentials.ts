export type StoredConnection = {
  url: string;
  username: string;
  password: string;
  prefix: string;
  lastGroup?: string;
  autoconnect?: boolean;
};

const KEY = 'mwords:connection';

export function read(): StoredConnection | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredConnection>;
    if (
      typeof v.url !== 'string' ||
      typeof v.username !== 'string' ||
      typeof v.password !== 'string' ||
      typeof v.prefix !== 'string'
    )
      return null;
    return {
      url: v.url,
      username: v.username,
      password: v.password,
      prefix: v.prefix,
      ...(typeof v.lastGroup === 'string' ? { lastGroup: v.lastGroup } : {}),
      ...(typeof v.autoconnect === 'boolean' ? { autoconnect: v.autoconnect } : {}),
    };
  } catch {
    return null;
  }
}

export function write(conn: StoredConnection): void {
  localStorage.setItem(KEY, JSON.stringify(conn));
}

export function update(patch: Partial<StoredConnection>): void {
  const cur = read();
  if (!cur) return;
  write({ ...cur, ...patch });
}

export function clearLastGroup(): void {
  const cur = read();
  if (!cur?.lastGroup) return;
  const { lastGroup: _, ...rest } = cur;
  void _;
  write(rest);
}

export function forget(): void {
  localStorage.removeItem(KEY);
}
