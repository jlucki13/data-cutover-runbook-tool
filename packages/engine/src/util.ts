export const MINUTE_MS = 60_000;

export const minutesToMs = (m: number): number => m * MINUTE_MS;
/** Round a millisecond delta to whole minutes. */
export const msToMinutes = (ms: number): number => Math.round(ms / MINUTE_MS);

/**
 * Natural string compare: "T-2" < "T-10". Locale-independent so ordering is identical
 * on every machine. Used for every tie-break in the engine.
 */
export function compareRef(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const as = a.match(re) ?? [];
  const bs = b.match(re) ?? [];
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i]!;
    const y = bs[i]!;
    const xn = /^\d/.test(x);
    const yn = /^\d/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (as.length !== bs.length) return as.length < bs.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedUnique(ids: Iterable<string>, cmp: (a: string, b: string) => number): string[] {
  return Array.from(new Set(ids)).sort(cmp);
}

/** Minimal binary heap keyed by a comparator; used for deterministic Kahn's algorithm. */
export class MinHeap<T> {
  private readonly a: T[] = [];
  constructor(private readonly cmp: (x: T, y: T) => number) {}
  get size(): number {
    return this.a.length;
  }
  push(v: T): void {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i]!, a[p]!) >= 0) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l]!, a[m]!) < 0) m = l;
        if (r < a.length && this.cmp(a[r]!, a[m]!) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}
