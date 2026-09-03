/**
 * Timeline (Gantt-hybrid) view: rows grouped by workstream, bars from projected
 * start to finish, float tails, deadlines, gates, the live "now" line, and baseline
 * ghosts when a scenario is active. Plain SVG; hover tooltip; click selects.
 */
import { useMemo, useState } from "react";
import type { TaskId } from "@cutover/engine";
import type { EventModel } from "../lib/model";
import type { Filters } from "../lib/filters";
import { STATUS, tint } from "../lib/colors";
import { fmtDelta, fmtDuration, fmtTime } from "../lib/format";

const ROW = 22;
const GROUP = 26;
const LABEL_W = 230;
const AXIS_H = 34;

interface Tip {
  x: number;
  y: number;
  lines: string[];
}

export function TimelineView({ model, visible, selected, onSelect, filters }: { model: EventModel; visible: TaskId[]; selected: TaskId | null; onSelect: (id: TaskId | null) => void; filters: Filters }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [width, setWidth] = useState(1200);
  const s = model.schedule;
  const base = model.baseline;
  const ev = model.payload.event;

  const [t0, t1] = useMemo(() => {
    const w0 = Date.parse(ev.windowStart);
    const w1 = Date.parse(ev.windowEnd);
    let lo = filters.timeFrom ?? w0;
    let hi = filters.timeTo ?? Math.max(w1, s.projectedFinish ?? w1);
    if (filters.timeFrom === null && filters.timeTo === null) {
      for (const id of visible) {
        const tm = s.tasks[id];
        if (tm?.earlyStart !== undefined && tm.earlyStart < lo) lo = tm.earlyStart;
      }
    }
    if (hi - lo < 3_600_000) hi = lo + 3_600_000;
    return [lo, hi];
  }, [ev.windowStart, ev.windowEnd, filters.timeFrom, filters.timeTo, s, visible]);

  const plotW = Math.max(300, width - LABEL_W - 24);
  const x = (ms: number) => LABEL_W + ((ms - t0) / (t1 - t0)) * plotW;

  const groups = useMemo(() => {
    const byWs = new Map<string, TaskId[]>();
    for (const id of visible) {
      const t = model.taskById.get(id)!;
      const k = t.workstreamId ?? "";
      if (!byWs.has(k)) byWs.set(k, []);
      byWs.get(k)!.push(id);
    }
    return Array.from(byWs.entries())
      .map(([k, ids]) => ({ key: k, name: k ? (model.workstreamById.get(k)?.name ?? "?") : "No workstream", ids: ids.sort((a, b) => (s.tasks[a]?.earlyStart ?? Infinity) - (s.tasks[b]?.earlyStart ?? Infinity)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [visible, model, s]);

  const gates = model.payload.gates;
  const gateRows = gates.length;
  let y = AXIS_H + 6;
  const gateY = y;
  y += gateRows > 0 ? GROUP + gateRows * ROW : 0;
  const rowY = new Map<TaskId, number>();
  const groupY: { name: string; y: number }[] = [];
  for (const g of groups) {
    groupY.push({ name: g.name, y });
    y += GROUP;
    for (const id of g.ids) {
      rowY.set(id, y);
      y += ROW;
    }
  }
  const height = y + 12;

  // Axis ticks: hourly, or every N hours to keep ~12 labels.
  const hours = (t1 - t0) / 3_600_000;
  const step = hours <= 14 ? 1 : hours <= 30 ? 2 : hours <= 80 ? 6 : 24;
  const ticks: number[] = [];
  const firstTick = Math.ceil(t0 / 3_600_000) * 3_600_000;
  for (let t = firstTick; t <= t1; t += step * 3_600_000) ticks.push(t);

  const show = (e: React.MouseEvent, lines: string[]) => setTip({ x: e.clientX + 12, y: e.clientY + 12, lines });

  return (
    <div
      ref={(el) => {
        if (el && el.clientWidth !== width) setWidth(el.clientWidth);
      }}
      style={{ position: "relative", minHeight: "100%" }}
      onMouseLeave={() => setTip(null)}
    >
      <svg className="timeline" width={width} height={height}>
        <g className="grid">
          {ticks.map((t) => (
            <line key={t} x1={x(t)} x2={x(t)} y1={AXIS_H} y2={height} />
          ))}
        </g>
        <g className="axis">
          {ticks.map((t) => (
            <text key={t} x={x(t) + 3} y={14}>
              {fmtTime(t, model.tz, { withDay: step >= 24 || new Date(t).getUTCHours() === 0 })}
            </text>
          ))}
          <line x1={LABEL_W} x2={width} y1={AXIS_H - 6} y2={AXIS_H - 6} stroke="var(--axis)" />
        </g>
        {/* window bounds */}
        <line x1={x(Date.parse(ev.windowEnd))} x2={x(Date.parse(ev.windowEnd))} y1={AXIS_H} y2={height} stroke={STATUS.critical} strokeWidth={1} opacity={0.6} />
        <text x={x(Date.parse(ev.windowEnd)) + 4} y={AXIS_H + 4} fontSize={10} fill={STATUS.critical}>
          window end
        </text>
        {model.mode === "live" && <line className="now" x1={x(model.asOf)} x2={x(model.asOf)} y1={AXIS_H} y2={height} />}

        {gateRows > 0 && (
          <g>
            <text className="group" x={8} y={gateY + 17} style={{ fontWeight: 700 }}>
              Gates
            </text>
            {gates.map((g, i) => {
              const gp = s.gates[g.id];
              const bp = base.gates[g.id];
              const cy = gateY + GROUP + i * ROW + ROW / 2;
              const color = gp?.status === "breached" || gp?.status === "decided_no_go" ? STATUS.critical : gp?.status === "at_risk" ? STATUS.warning : gp?.status === "decided_go" ? STATUS.good : "var(--ink-2)";
              const target = g.targetDecisionAt ? Date.parse(g.targetDecisionAt) : undefined;
              return (
                <g key={g.id} onMouseMove={(e) => show(e, [g.name, `status: ${gp?.status ?? "?"}`, gp?.projectedReadyAt !== undefined ? `entry work done: ${fmtTime(gp.projectedReadyAt, model.tz)}` : "entry work: held", target !== undefined ? `target decision: ${fmtTime(target, model.tz)}` : "", gp?.slackMinutes !== undefined ? `slack: ${fmtDelta(gp.slackMinutes)}` : "", gp?.assumed ? "rests on an assumed recovery" : ""].filter(Boolean))}>
                  <text x={8} y={cy + 4} className="row-label">
                    {g.isPointOfNoReturn ? "⛔ " : "◆ "}
                    {g.name.length > 30 ? g.name.slice(0, 29) + "…" : g.name}
                  </text>
                  {target !== undefined && <line x1={x(target)} x2={x(target)} y1={cy - 8} y2={cy + 8} stroke="var(--ink-2)" strokeWidth={2} />}
                  {bp?.projectedReadyAt !== undefined && model.scenario && <polygon className="ghost" points={diamond(x(bp.projectedReadyAt), cy, 6)} />}
                  {gp?.projectedReadyAt !== undefined && <polygon points={diamond(x(gp.projectedReadyAt), cy, 7)} fill={color} stroke="var(--panel)" strokeWidth={2} />}
                  {gp?.projectedReadyAt !== undefined && target !== undefined && <line x1={x(Math.min(gp.projectedReadyAt, target))} x2={x(Math.max(gp.projectedReadyAt, target))} y1={cy} y2={cy} stroke={color} strokeWidth={2} strokeDasharray={gp.projectedReadyAt > target ? "3 2" : undefined} />}
                </g>
              );
            })}
          </g>
        )}

        {groupY.map((g) => (
          <text key={g.name + g.y} className="group" x={8} y={g.y + 17}>
            {g.name}
          </text>
        ))}
        {visible.map((id) => {
          const t = model.taskById.get(id)!;
          const tm = s.tasks[id];
          const btm = base.tasks[id];
          const ry = rowY.get(id)!;
          const cy = ry + ROW / 2;
          const color = model.colorOf(t);
          const isSel = id === selected;
          const critical = tm?.isCritical ?? false;
          const lines = [
            `${t.ref} — ${t.name}`,
            `${model.ownerName(t)} · ${t.status.replace("_", " ")} · ${fmtDuration(t.plannedDurationMinutes)}`,
            tm?.held ? `held: ${tm.held.reason.replace("_", " ")}` : `${fmtTime(tm?.earlyStart, model.tz)} → ${fmtTime(tm?.earlyFinish, model.tz)}`,
            tm?.totalFloatMinutes !== undefined ? `float ${fmtDuration(tm.totalFloatMinutes)}${critical ? " (critical)" : ""}` : "",
            tm?.deadlineBreachMinutes ? `deadline breached by ${fmtDuration(tm.deadlineBreachMinutes)}` : t.windowDeadline ? `deadline ${fmtTime(Date.parse(t.windowDeadline), model.tz)}` : "",
            tm && tm.assumedFrom.length > 0 ? `assumes recovery of ${tm.assumedFrom.map(model.refOf).join(", ")}` : "",
            model.scenario && btm?.earlyFinish !== undefined && tm?.earlyFinish !== undefined && tm.earlyFinish !== btm.earlyFinish ? `scenario shift ${fmtDelta(Math.round((tm.earlyFinish - btm.earlyFinish) / 60_000))}` : "",
          ].filter(Boolean);
          return (
            <g key={id} onClick={() => onSelect(isSel ? null : id)} onMouseMove={(e) => show(e, lines)}>
              <rect x={0} y={ry} width={width} height={ROW} fill={isSel ? tint(color, 0.08) : "transparent"} />
              <text x={16} y={cy + 4} className="row-label" fontFamily="ui-monospace, Menlo, monospace" fontSize={11}>
                {t.ref}
              </text>
              <text x={16 + Math.min(80, t.ref.length * 7 + 8)} y={cy + 4} className="row-label" fontSize={11}>
                {t.name.length > 24 ? t.name.slice(0, 23) + "…" : t.name}
              </text>
              {tm?.held ? (
                <text x={LABEL_W + 4} y={cy + 4} fontSize={11} fill={STATUS.muted}>
                  held — {tm.held.reason.replace("_", " ")}
                </text>
              ) : (
                tm && (
                  <>
                    {model.scenario && btm?.earlyStart !== undefined && btm.earlyFinish !== undefined && (btm.earlyStart !== tm.earlyStart || btm.earlyFinish !== tm.earlyFinish) && (
                      <rect className="ghost" x={x(btm.earlyStart)} y={cy - 3} width={Math.max(2, x(btm.earlyFinish) - x(btm.earlyStart))} height={6} rx={2} />
                    )}
                    {tm.lateFinish !== undefined && tm.earlyFinish !== undefined && tm.lateFinish > tm.earlyFinish && <line className="float" x1={x(tm.earlyFinish)} x2={x(tm.lateFinish)} y1={cy} y2={cy} />}
                    <rect
                      className={`bar ${critical ? "critical" : ""} ${isSel ? "selected" : ""}`}
                      x={x(tm.earlyStart!)}
                      y={cy - 7}
                      width={Math.max(3, x(tm.earlyFinish!) - x(tm.earlyStart!))}
                      height={14}
                      rx={3}
                      fill={t.status === "complete" || t.status === "skipped" ? tint(color, 0.35) : tint(color, 0.85)}
                      strokeDasharray={tm.assumedFrom.length > 0 ? "3 2" : undefined}
                      stroke={critical || isSel ? undefined : tm.assumedFrom.length > 0 ? color : "var(--panel)"}
                      strokeWidth={critical || isSel ? undefined : 1}
                    />
                    {t.windowDeadline && (
                      <>
                        {tm.deadlineBreachMinutes !== undefined && <rect className="breach" x={x(Date.parse(t.windowDeadline))} y={cy - 7} width={Math.max(2, x(tm.earlyFinish!) - x(Date.parse(t.windowDeadline)))} height={14} rx={3} />}
                        <polygon className="deadline" points={`${x(Date.parse(t.windowDeadline))},${cy - 10} ${x(Date.parse(t.windowDeadline)) - 5},${cy - 16} ${x(Date.parse(t.windowDeadline)) + 5},${cy - 16}`} />
                      </>
                    )}
                  </>
                )
              )}
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.lines.map((l, i) => (
            <div key={i} style={i === 0 ? { fontWeight: 600 } : undefined}>
              {l}
            </div>
          ))}
        </div>
      )}
      <div className="small muted" style={{ padding: "4px 8px" }}>
        bar: projected start → finish · dotted tail: float to late finish · ▼ deadline · <span style={{ color: STATUS.critical }}>red outline</span>: critical · grey ghost: baseline when a what-if is active · dashed bar: rests on an assumed recovery
      </div>
    </div>
  );
}

function diamond(cx: number, cy: number, r: number): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
}
