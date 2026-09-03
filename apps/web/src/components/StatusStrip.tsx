import type { Schedule } from "@cutover/engine";
import type { EventModel } from "../lib/model";
import { fmtDelta, fmtDuration, fmtTime } from "../lib/format";

function count(s: Schedule) {
  const gates = Object.values(s.gates);
  return {
    breaches: s.deadlineBreaches.length,
    gatesAtRisk: gates.filter((g) => g.status === "at_risk").length,
    gatesBreached: gates.filter((g) => g.status === "breached").length,
    held: s.heldTaskIds.length,
    critical: s.criticalTaskIds.length,
  };
}

export function StatusStrip({ model }: { model: EventModel }) {
  const base = model.baseline;
  const cur = model.schedule;
  const b = count(base);
  const c = count(cur);
  const shift = cur.projectedFinish !== undefined && base.projectedFinish !== undefined ? Math.round((cur.projectedFinish - base.projectedFinish) / 60_000) : undefined;
  const delta = (before: number, after: number) => (model.scenario && before !== after ? <span className="delta">was {before}</span> : null);
  const slack = cur.windowSlackMinutes;
  return (
    <div className="strip">
      <div className={`tile ${cur.eventWindowBreachMinutes > 0 ? "critical" : ""}`}>
        <div className="label">Projected finish</div>
        <div className="value">{fmtTime(cur.projectedFinish, model.tz)}</div>
        {model.scenario && shift !== undefined && shift !== 0 && <div className={`delta ${shift > 0 ? "later" : "earlier"}`}>{fmtDelta(shift)} vs baseline</div>}
      </div>
      <div className={`tile ${slack !== undefined && slack < 0 ? "critical" : slack !== undefined && slack < 60 ? "warning" : ""}`}>
        <div className="label">Window slack</div>
        <div className="value">{slack === undefined ? "—" : slack < 0 ? `-${fmtDuration(-slack)}` : fmtDuration(slack)}</div>
        <div className="delta">ends {fmtTime(Date.parse(model.payload.event.windowEnd), model.tz)}</div>
      </div>
      <div className={`tile ${c.breaches > 0 ? "critical" : ""}`}>
        <div className="label">Deadline breaches</div>
        <div className="value">{c.breaches}</div>
        {delta(b.breaches, c.breaches)}
      </div>
      <div className={`tile ${c.gatesBreached > 0 ? "critical" : c.gatesAtRisk > 0 ? "warning" : ""}`}>
        <div className="label">Gates at risk</div>
        <div className="value">
          {c.gatesAtRisk + c.gatesBreached}
          <span className="small muted"> / {Object.keys(cur.gates).length}</span>
        </div>
        {c.gatesBreached > 0 && <div className="delta later">{c.gatesBreached} breached</div>}
      </div>
      <div className="tile">
        <div className="label">Critical tasks</div>
        <div className="value">{c.critical}</div>
        {delta(b.critical, c.critical)}
      </div>
      <div className={`tile ${c.held > 0 ? "warning" : ""}`}>
        <div className="label">Held</div>
        <div className="value">{c.held}</div>
        {delta(b.held, c.held)}
      </div>
      <div className="tile">
        <div className="label">{model.mode === "live" ? "Live as of" : "Plan mode"}</div>
        <div className="value" style={{ fontSize: 14 }}>
          {model.mode === "live" ? fmtTime(model.asOf, model.tz) : `${model.payload.tasks.length} tasks`}
        </div>
        <div className="delta">{model.payload.dependencies.length} dependencies · {model.payload.gates.length} gates</div>
      </div>
    </div>
  );
}
