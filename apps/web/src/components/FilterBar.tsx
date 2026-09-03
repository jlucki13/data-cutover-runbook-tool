import type { TaskStatus } from "@cutover/engine";
import type { EventModel } from "../lib/model";
import { EMPTY_FILTERS, isFiltering, type Filters } from "../lib/filters";
import { fmtTime } from "../lib/format";

const STATUSES: TaskStatus[] = ["not_started", "in_progress", "blocked", "complete", "failed", "skipped"];

export function FilterBar({ model, filters, setFilters, visibleCount }: { model: EventModel; filters: Filters; setFilters: (f: Filters | ((f: Filters) => Filters)) => void; visibleCount: number }) {
  const ev = model.payload.event;
  const w0 = Date.parse(ev.windowStart);
  const w1 = Date.parse(ev.windowEnd);
  const hours = Math.max(1, Math.round((w1 - w0) / 3_600_000));
  const fromH = filters.timeFrom === null ? 0 : Math.round((filters.timeFrom - w0) / 3_600_000);
  const toH = filters.timeTo === null ? hours : Math.round((filters.timeTo - w0) / 3_600_000);
  const toggleWs = (id: string) =>
    setFilters((f) => {
      const cur = f.workstreams ?? model.payload.workstreams.map((w) => w.id);
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      return { ...f, workstreams: next.length === model.payload.workstreams.length ? null : next };
    });
  const owners = model.payload.users.filter((u) => model.payload.tasks.some((t) => t.ownerId === u.id));
  return (
    <div className="filterbar">
      <input placeholder="Search ref or name" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} style={{ width: 170 }} />
      <span className="row" style={{ gap: 4 }}>
        {model.payload.workstreams.map((w) => {
          const on = filters.workstreams === null || filters.workstreams.includes(w.id);
          return (
            <button key={w.id} className={`chip ${on ? "on" : ""}`} onClick={() => toggleWs(w.id)} title={`Toggle ${w.name}`}>
              <span className="swatch" style={{ background: model.colorOf({ workstreamId: w.id } as never) }} />
              {w.name}
            </button>
          );
        })}
      </span>
      <select value={filters.statuses?.[0] ?? ""} onChange={(e) => setFilters((f) => ({ ...f, statuses: e.target.value ? [e.target.value as TaskStatus] : null }))} title="Status">
        <option value="">any status</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s.replace("_", " ")}
          </option>
        ))}
      </select>
      <select value={filters.ownerId ?? ""} onChange={(e) => setFilters((f) => ({ ...f, ownerId: e.target.value || null }))} title="Owner">
        <option value="">any owner</option>
        {owners.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      <label className="chip">
        <input type="checkbox" checked={filters.criticalOnly} onChange={(e) => setFilters((f) => ({ ...f, criticalOnly: e.target.checked }))} /> critical only
      </label>
      <span className="row small" title="Show tasks whose projected span overlaps this part of the window">
        <span className="muted">from</span>
        <input type="range" min={0} max={hours} value={fromH} onChange={(e) => setFilters((f) => ({ ...f, timeFrom: Number(e.target.value) === 0 ? null : w0 + Number(e.target.value) * 3_600_000 }))} style={{ width: 90 }} />
        <span className="mono">{fmtTime(w0 + fromH * 3_600_000, model.tz, { withDay: false })}</span>
        <span className="muted">to</span>
        <input type="range" min={0} max={hours} value={toH} onChange={(e) => setFilters((f) => ({ ...f, timeTo: Number(e.target.value) === hours ? null : w0 + Number(e.target.value) * 3_600_000 }))} style={{ width: 90 }} />
        <span className="mono">{fmtTime(w0 + toH * 3_600_000, model.tz, { withDay: false })}</span>
      </span>
      {filters.focus && (
        <span className="chip on">
          around {model.refOf(filters.focus.taskId)} ·
          <select value={filters.focus.radius} onChange={(e) => setFilters((f) => ({ ...f, focus: f.focus ? { ...f.focus, radius: Number(e.target.value) } : null }))} style={{ padding: "0 4px" }}>
            {[1, 2, 3, 4, 6].map((r) => (
              <option key={r} value={r}>
                {r} hop{r === 1 ? "" : "s"}
              </option>
            ))}
          </select>
          <button className="ghost" onClick={() => setFilters((f) => ({ ...f, focus: null }))} title="Clear focus">
            ×
          </button>
        </span>
      )}
      <span className="grow" />
      <span className="small muted">
        {visibleCount} of {model.payload.tasks.length} tasks
      </span>
      {isFiltering(filters) && (
        <button className="ghost small" onClick={() => setFilters(EMPTY_FILTERS)}>
          clear filters
        </button>
      )}
    </div>
  );
}
