/**
 * Palette (validated categorical order; status colors reserved). Workstreams take
 * categorical slots in a fixed order by name; beyond eight they fold into "Other".
 * Critical / at-risk / held are status colors, never reused for a series.
 */
export const CATEGORICAL_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const OTHER_LIGHT = "#898781";

export const STATUS = {
  critical: "#d03b3b",
  warning: "#fab219",
  serious: "#ec835a",
  good: "#0ca30c",
  muted: "#898781",
};

export function workstreamPalette(workstreamIds: string[], nameOf: (id: string) => string): Map<string, string> {
  const sorted = [...workstreamIds].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const m = new Map<string, string>();
  sorted.forEach((id, i) => m.set(id, i < CATEGORICAL_LIGHT.length ? CATEGORICAL_LIGHT[i] : OTHER_LIGHT));
  return m;
}

/** Hex → rgba string for tinted fills. */
export function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
