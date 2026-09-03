/**
 * Deterministic text utilities shared by the parsers: CSV tokenizing, header
 * normalization, duration / lag / date parsing. No dependencies.
 */
import type { DependencyType } from "@cutover/engine";

export const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Guess the delimiter from the header line: the candidate that yields the most columns. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = -1;
  for (const d of [",", "\t", ";", "|"]) {
    const n = splitCsvLine(firstLine, d).length;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  return parseCsv(line, delimiter)[0] ?? [];
}

/** RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes. Returns rows of raw strings. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  // Strip BOM.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  // Drop fully empty trailing rows.
  while (rows.length > 0 && rows[rows.length - 1]!.every((f) => f.trim() === "")) rows.pop();
  return rows;
}

/** "Planned Start (UTC)" → "plannedstartutc"; used to match headers against synonyms. */
export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

/** "Planned Start (UTC)" → "planned_start_utc"; used as a custom-field key. */
export function headerToKey(h: string): string {
  const k = h
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "c$1");
  return k.slice(0, 64) || "column";
}

// ---------------------------------------------------------------------------
// Durations and lags
// ---------------------------------------------------------------------------

export interface DurationOptions {
  hoursPerDay?: number;
  /** Unit assumed for a bare number. Default "minutes". */
  bareUnit?: "minutes" | "hours" | "days";
}

const UNIT_MINUTES: Record<string, (hpd: number) => number> = {
  m: () => 1,
  min: () => 1,
  mins: () => 1,
  minute: () => 1,
  minutes: () => 1,
  h: () => 60,
  hr: () => 60,
  hrs: () => 60,
  hour: () => 60,
  hours: () => 60,
  d: (hpd) => 60 * hpd,
  day: (hpd) => 60 * hpd,
  days: (hpd) => 60 * hpd,
  w: (hpd) => 60 * hpd * 7,
  wk: (hpd) => 60 * hpd * 7,
  week: (hpd) => 60 * hpd * 7,
  weeks: (hpd) => 60 * hpd * 7,
};

/**
 * Parse "90", "90m", "1.5h", "2h 30m", "1d 4h", "01:30", "1:30:00", "PT1H30M" into whole minutes.
 * Returns undefined when unparseable. Empty input → undefined.
 */
export function parseDurationMinutes(raw: string | number | undefined | null, opts: DurationOptions = {}): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const hpd = opts.hoursPerDay ?? 24;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return undefined;
    return Math.round(raw * bareFactor(opts.bareUnit, hpd));
  }
  const s = raw.trim().toLowerCase();
  if (s === "") return undefined;
  // ISO 8601 duration: PnDTnHnMnS
  const iso = /^p(?:(\d+(?:\.\d+)?)d)?(?:t(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?)?$/.exec(s);
  if (iso) {
    const [, d, h, m, sec] = iso;
    const total = (Number(d ?? 0) * hpd * 60) + Number(h ?? 0) * 60 + Number(m ?? 0) + Number(sec ?? 0) / 60;
    return Math.round(total);
  }
  // hh:mm or hh:mm:ss
  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) + Math.round(Number(clock[3] ?? 0) / 60);
  // bare number
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * bareFactor(opts.bareUnit, hpd));
  // sequence of number+unit tokens: "2h 30m", "1d4h", "90 mins"
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let matched = 0;
  let consumed = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const f = UNIT_MINUTES[m[2]!];
    if (!f) return undefined;
    total += Number(m[1]) * f(hpd);
    matched++;
    consumed += m[0];
  }
  if (matched === 0) return undefined;
  // Everything except whitespace/commas must have been consumed.
  if (s.replace(/[\s,]+/g, "") !== consumed.replace(/\s+/g, "")) return undefined;
  return Math.round(total);
}

function bareFactor(unit: DurationOptions["bareUnit"], hpd: number): number {
  return unit === "hours" ? 60 : unit === "days" ? 60 * hpd : 1;
}

export interface PredecessorToken {
  ref: string;
  type: DependencyType;
  lagMinutes: number;
  raw: string;
}

/**
 * Split a predecessor cell like "T-9, T-11FS+2h; 14SS-30m" into tokens.
 * `knownRefs` lets a ref that itself ends in FS/SS/FF/SF be matched exactly before the suffix
 * grammar is tried. Tokens that cannot be parsed come back with `ref` = raw token and `type` FS.
 */
export function parsePredecessorCell(cell: string, knownRefs: ReadonlySet<string>, opts: DurationOptions = {}): { tokens: PredecessorToken[]; bad: string[] } {
  const tokens: PredecessorToken[] = [];
  const bad: string[] = [];
  const parts = cell
    .split(/[,;\n]+|\s{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const raw of parts) {
    if (knownRefs.has(raw)) {
      tokens.push({ ref: raw, type: "FS", lagMinutes: 0, raw });
      continue;
    }
    const m = /^(.*?)(\s*(FS|SS|FF|SF))?(\s*([+-])\s*(\d+(?:\.\d+)?\s*[a-z]*|\d+:\d{2}))?$/i.exec(raw);
    let ref = m?.[1]?.trim() ?? "";
    let type: DependencyType = (m?.[3]?.toUpperCase() as DependencyType | undefined) ?? "FS";
    let lag = 0;
    if (m && m[5] !== undefined && m[6] !== undefined) {
      const sign = m[5];
      const lagStr = m[6].trim();
      const hasType = m[3] !== undefined;
      const spaced = /^\s/.test(m[4]!);
      const hasUnit = /[a-z:]/i.test(lagStr);
      if (sign === "-" && !hasType && !spaced && !hasUnit) {
        // "ACC-1" is a ref, not "ACC" with a lag of -1.
        ref = raw;
        type = "FS";
      } else {
        const v = parseDurationMinutes(lagStr, { ...opts, bareUnit: opts.bareUnit ?? "minutes" });
        if (v === undefined) {
          bad.push(raw);
          continue;
        }
        lag = sign === "-" ? -v : v;
      }
    }
    if (ref === "" || ref.includes("+")) {
      bad.push(raw);
      continue;
    }
    tokens.push({ ref, type, lagMinutes: lag, raw });
  }
  return { tokens, bad };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export interface DateOptions {
  timezone?: string;
  dateOrder?: "MDY" | "DMY";
}

/** Offset (ms) of `zone` at the given UTC instant, via Intl. */
function zoneOffsetMs(zone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]), Number(parts["hour"]), Number(parts["minute"]), Number(parts["second"]));
  return asUtc - utcMs;
}

/** Interpret wall-clock components in `zone` and return the UTC instant. */
export function zonedToUtc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, zone = "UTC"): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (zone === "UTC") return guess;
  // Two-pass correction handles DST edges well enough for planning data.
  let off = zoneOffsetMs(zone, guess);
  let utc = guess - off;
  off = zoneOffsetMs(zone, utc);
  utc = guess - off;
  return utc;
}

/**
 * Parse a date-time string into epoch ms. Accepts ISO 8601 (with or without offset),
 * "YYYY-MM-DD HH:mm", "M/D/YYYY H:mm[:ss] [AM|PM]", "D/M/YYYY" (per dateOrder), and
 * "17 Oct 2026 02:00". Naive values are interpreted in `timezone`. Returns undefined if unparseable.
 */
export function parseDateTime(raw: string | number | Date | undefined | null, opts: DateOptions = {}): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw.getTime();
  if (typeof raw === "number") return excelSerialToUtc(raw, opts.timezone ?? "UTC");
  const s = raw.trim();
  if (s === "") return undefined;
  const zone = opts.timezone ?? "UTC";

  // ISO with explicit offset or Z → exact.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    return Number.isNaN(t) ? undefined : t;
  }
  // ISO naive (date or date-time).
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return zonedToUtc(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), zone);
  // Numeric with slashes or dots: a/b/yyyy [h:mm[:ss]] [am|pm]
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(s);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    let y = +m[3]!;
    if (y < 100) y += 2000;
    let month: number;
    let day: number;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      month = a;
      day = b;
    } else if ((opts.dateOrder ?? "MDY") === "MDY") {
      month = a;
      day = b;
    } else {
      day = a;
      month = b;
    }
    let h = +(m[4] ?? 0);
    const ampm = m[7]?.toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    return zonedToUtc(y, month, day, h, +(m[5] ?? 0), +(m[6] ?? 0), zone);
  }
  // "17 Oct 2026 02:00", "Oct 17, 2026 2:00 PM", "Sat 17 Oct 2026 02:00"
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  m = /^(?:[a-z]{3,9},?\s+)?(?:(\d{1,2})\s+([a-z]{3,9})|([a-z]{3,9})\s+(\d{1,2}),?)\s+(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(s);
  if (m) {
    const day = +(m[1] ?? m[4]!);
    const monName = (m[2] ?? m[3]!).slice(0, 3).toLowerCase();
    const month = months.indexOf(monName) + 1;
    if (month === 0) return undefined;
    let h = +(m[6] ?? 0);
    const ampm = m[9]?.toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    return zonedToUtc(+m[5]!, month, day, h, +(m[7] ?? 0), +(m[8] ?? 0), zone);
  }
  return undefined;
}

/** Excel serial date (days since 1899-12-30, fractional days = time) interpreted as wall-clock in `zone`. */
export function excelSerialToUtc(serial: number, zone = "UTC"): number | undefined {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return undefined;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), zone);
}

/** Case/whitespace-insensitive ref normalization used for fuzzy resolution ("t-014" ≈ "T-14"). */
export function looseRef(ref: string): string {
  return ref
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(^|[^0-9])0+(\d)/g, "$1$2");
}
