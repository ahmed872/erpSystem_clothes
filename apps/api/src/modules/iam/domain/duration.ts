/** Parses a "15m" / "30d" style TTL string and adds it to `base`. */
export function addDuration(base: Date, ttl: string): Date {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return new Date(base.getTime() + 30 * 86_400_000);
  const value = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const msPerUnit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return new Date(base.getTime() + value * msPerUnit[unit]);
}
