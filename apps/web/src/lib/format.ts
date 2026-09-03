const MIN = 60_000;

export function fmtTime(ms: number | undefined | null, tz: string, opts: { withDay?: boolean } = {}): string {
  if (ms === undefined || ms === null) return "—";
  const d = new Date(ms);
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: opts.withDay === false ? undefined : "short",
    day: opts.withDay === false ? undefined : "2-digit",
    month: opts.withDay === false ? undefined : "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return f.format(d);
}

export function fmtDuration(minutes: number | undefined | null): string {
  if (minutes === undefined || minutes === null) return "—";
  const sign = minutes < 0 ? "-" : "";
  const m = Math.abs(Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${sign}${r}m`;
  if (r === 0) return `${sign}${h}h`;
  return `${sign}${h}h ${r}m`;
}

/** Signed delta for shifts: "+45m", "-2h", "0". */
export function fmtDelta(minutes: number | undefined | null): string {
  if (minutes === undefined || minutes === null) return "—";
  if (minutes === 0) return "0";
  return `${minutes > 0 ? "+" : "-"}${fmtDuration(Math.abs(minutes))}`;
}

export function minutesBetween(a: number, b: number): number {
  return Math.round((b - a) / MIN);
}

export function relDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

export const isoToMs = (iso: string | null | undefined): number | undefined => (iso ? Date.parse(iso) : undefined);
