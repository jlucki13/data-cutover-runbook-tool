/**
 * Impact simulation ("what if"). Changes are applied in the browser with the same
 * engine the server uses, so every keystroke recomputes instantly; "Save scenario"
 * persists the run server-side for the record. Live events use live mode as of now.
 */
import { useMemo, useState } from "react";
import type { Change, TaskId } from "@cutover/engine";
import { ApiError, saveScenario } from "../api";
import type { EventModel } from "../lib/model";
import { fmtDelta, fmtDuration, fmtTime } from "../lib/format";

type Kind = "delay" | "set_duration" | "set_status" | "set_gate_decision" | "set_planned_start";

export function SimulatePanel({ model, changes, setChanges, onSelect }: { model: EventModel; changes: Change[]; setChanges: (c: Change[]) => void; onSelect: (id: TaskId) => void }) {
  const [kind, setKind] = useState<Kind>("delay");
  const [ref, setRef] = useState("");
  const [n, setN] = useState("60");
  const [status, setStatus] = useState<"blocked" | "failed" | "complete" | "in_progress">("blocked");
  const [gateId, setGateId] = useState(model.payload.gates[0]?.id ?? "");
  const [decision, setDecision] = useState<"go" | "no_go" | "pending">("no_go");
  const [when, setWhen] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const tasks = model.payload.tasks;
  const taskByRef = useMemo(() => new Map(tasks.map((t) => [t.ref.toLowerCase(), t] as const)), [tasks]);
  const target = taskByRef.get(ref.trim().toLowerCase());

  const add = () => {
    const at = when ? Date.parse(when) : model.asOf;
    let c: Change | undefined;
    if (kind === "set_gate_decision") c = { kind, gateId, decision, at };
    else if (!target) return;
    else if (kind === "delay") c = { kind, taskId: target.id, minutes: Number(n) || 0 };
    else if (kind === "set_duration") c = { kind, taskId: target.id, plannedDurationMinutes: Math.max(0, Number(n) || 0) };
    else if (kind === "set_planned_start") c = { kind, taskId: target.id, plannedStart: at };
    else if (kind === "set_status") c = { kind, taskId: target.id, status, at, ...(status === "blocked" || status === "in_progress" ? { remainingDurationMinutes: Number(n) || undefined } : {}) };
    if (c) setChanges([...changes, c]);
  };

  const describe = (c: Change): string => {
    const r = "taskId" in c ? model.refOf(c.taskId) : "";
    switch (c.kind) {
      case "delay":
        return `${r}: delay ${fmtDelta(c.minutes)}`;
      case "set_duration":
        return `${r}: duration → ${fmtDuration(c.plannedDurationMinutes)}`;
      case "set_planned_start":
        return `${r}: start no earlier than ${fmtTime(c.plannedStart, model.tz)}`;
      case "set_status":
        return `${r}: status → ${c.status.replace("_", " ")} at ${fmtTime(c.at, model.tz)}${c.remainingDurationMinutes ? `, ${fmtDuration(c.remainingDurationMinutes)} remaining` : ""}`;
      case "set_gate_decision":
        return `gate ${model.payload.gates.find((g) => g.id === c.gateId)?.name ?? ""}: ${c.decision.replace("_", " ")}`;
      case "set_deadline":
        return `${r}: deadline → ${fmtTime(c.windowDeadline, model.tz)}`;
      case "set_expected_unblock":
        return `${r}: expected unblock → ${fmtTime(c.expectedUnblockAt, model.tz)}`;
      case "add_dependency":
        return `add ${model.refOf(c.dependency.predecessorId)} → ${model.refOf(c.dependency.successorId)}`;
      case "remove_dependency":
        return `remove ${model.refOf(c.predecessorId)} → ${model.refOf(c.successorId)}`;
    }
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await saveScenario(model.payload.event.id, changes, model.mode, model.asOf);
      setMsg(`Saved as scenario run ${r.scheduleRunId?.slice(0, 8)}`);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const impact = model.scenario?.impact;
  const invalid = changes.length > 0 && !model.scenario;

  return (
    <div className="panel col" style={{ gap: 12 }}>
      <div className="card">
        <div className="row" style={{ gap: 8 }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="delay">Delay task by…</option>
            <option value="set_duration">Set task duration…</option>
            <option value="set_status">Set task status…</option>
            <option value="set_planned_start">Set task start-no-earlier-than…</option>
            <option value="set_gate_decision">Decide a gate…</option>
          </select>
          {kind !== "set_gate_decision" && (
            <>
              <input list="task-refs" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="task ref" style={{ width: 130 }} />
              <datalist id="task-refs">
                {tasks.map((t) => (
                  <option key={t.id} value={t.ref}>
                    {t.name}
                  </option>
                ))}
              </datalist>
              {target ? <span className="small muted">{target.name}</span> : ref ? <span className="small error">unknown ref</span> : null}
            </>
          )}
          {(kind === "delay" || kind === "set_duration") && (
            <label className="row small">
              <input value={n} onChange={(e) => setN(e.target.value)} style={{ width: 70 }} /> minutes
            </label>
          )}
          {kind === "set_status" && (
            <>
              <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                <option value="blocked">blocked</option>
                <option value="failed">failed</option>
                <option value="in_progress">in progress</option>
                <option value="complete">complete</option>
              </select>
              {(status === "blocked" || status === "in_progress") && (
                <label className="row small">
                  remaining <input value={n} onChange={(e) => setN(e.target.value)} style={{ width: 60 }} /> min
                </label>
              )}
            </>
          )}
          {kind === "set_gate_decision" && (
            <>
              <select value={gateId} onChange={(e) => setGateId(e.target.value)}>
                {model.payload.gates.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <select value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}>
                <option value="no_go">no-go</option>
                <option value="go">go</option>
                <option value="pending">pending</option>
              </select>
            </>
          )}
          {(kind === "set_status" || kind === "set_gate_decision" || kind === "set_planned_start") && (
            <label className="row small">
              at <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /> <span className="muted">(blank = {model.mode === "live" ? "now" : "window start"})</span>
            </label>
          )}
          <button className="primary" onClick={add} disabled={kind !== "set_gate_decision" && !target}>
            Add
          </button>
        </div>
        {changes.length > 0 && (
          <div className="col" style={{ marginTop: 10 }}>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {changes.map((c, i) => (
                <li key={i} className="row small">
                  <span>{describe(c)}</span>
                  <button className="ghost small" onClick={() => setChanges(changes.filter((_, j) => j !== i))} aria-label="Remove change">
                    ×
                  </button>
                </li>
              ))}
            </ol>
            <div className="row">
              <button onClick={() => setChanges([])}>Clear scenario</button>
              <button onClick={() => void save()} disabled={saving || !model.scenario}>
                {saving ? "Saving…" : "Save scenario run"}
              </button>
              {msg && <span className="small muted">{msg}</span>}
              <span className="small muted">Scenarios never change the plan. Real status changes are made from a task's panel.</span>
            </div>
          </div>
        )}
        {changes.length === 0 && <div className="small muted" style={{ marginTop: 8 }}>Add a change to see every downstream task that moves, deadline and gate impact, the new critical path, and who to notify. The graph and timeline switch to the what-if while a scenario is active.</div>}
        {invalid && <div className="error" style={{ marginTop: 8 }}>These changes make the graph invalid (for example a cycle). Remove the offending change.</div>}
      </div>
      {impact && <ImpactSummary model={model} onSelect={onSelect} />}
    </div>
  );
}

export function ImpactSummary({ model, onSelect }: { model: EventModel; onSelect: (id: TaskId) => void }) {
  const impact = model.scenario!.impact;
  const ew = impact.eventWindow;
  const affected = [...impact.affectedTasks].sort((a, b) => (b.finishShiftMinutes ?? 0) - (a.finishShiftMinutes ?? 0) || (b.deadlineBreachMinutes ?? 0) - (a.deadlineBreachMinutes ?? 0));
  const gateOf = (id: string) => model.payload.gates.find((g) => g.id === id);
  const gateName = (id: string) => gateOf(id)?.name ?? id;
  // Read in the order the command centre meets them, not by internal id.
  const gates = [...impact.gates].sort((a, b) => {
    const ta = gateOf(a.gateId)?.targetDecisionAt;
    const tb = gateOf(b.gateId)?.targetDecisionAt;
    if (ta && tb && ta !== tb) return Date.parse(ta) - Date.parse(tb);
    if (ta && !tb) return -1;
    if (!ta && tb) return 1;
    return gateName(a.gateId).localeCompare(gateName(b.gateId));
  });
  const userName = (id: string) => model.userById.get(id)?.name ?? id;
  return (
    <div className="impact col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 12, alignItems: "stretch" }}>
        <div className={`tile ${ew.breachMinutesAfter > 0 ? "critical" : ""}`}>
          <div className="label">Event finish</div>
          <div className="value">{fmtTime(ew.projectedFinishAfter, model.tz)}</div>
          <div className="delta">
            {ew.finishShiftMinutes ? <span className={ew.finishShiftMinutes > 0 ? "later" : "earlier"}>{fmtDelta(ew.finishShiftMinutes)}</span> : "unchanged"}
            {ew.breachMinutesAfter > 0 && <span className="later"> · window breached by {fmtDuration(ew.breachMinutesAfter)}</span>}
          </div>
        </div>
        <div className={`tile ${impact.deadlineBreaches.new.length + impact.deadlineBreaches.worsened.length > 0 ? "critical" : ""}`}>
          <div className="label">Deadlines</div>
          <div className="value">{impact.deadlineBreaches.new.length}</div>
          <div className="delta">
            new breaches{impact.deadlineBreaches.worsened.length ? ` · ${impact.deadlineBreaches.worsened.length} worsened` : ""}
            {impact.deadlineBreaches.resolved.length ? ` · ${impact.deadlineBreaches.resolved.length} resolved` : ""}
          </div>
        </div>
        <div className={`tile ${impact.criticalPath.changed ? "warning" : ""}`}>
          <div className="label">Critical path</div>
          <div className="value" style={{ fontSize: 13 }}>
            {impact.criticalPath.changed ? "changed" : "unchanged"}
          </div>
          <div className="delta mono">{impact.criticalPath.after.map(model.refOf).join(" → ") || "—"}</div>
        </div>
        <div className="tile">
          <div className="label">Affected tasks</div>
          <div className="value">{affected.length}</div>
          <div className="delta">{impact.ownersToNotify.length} owners to notify</div>
        </div>
      </div>

      {gates.length > 0 && (
        <div className="card">
          <strong>Gates</strong>
          <table>
            <thead>
              <tr>
                <th>Gate</th>
                <th>Before</th>
                <th>After</th>
                <th>Slack</th>
                <th>Entry work moves</th>
              </tr>
            </thead>
            <tbody>
              {gates.map((g) => (
                <tr key={g.gateId}>
                  <td>{gateName(g.gateId)}</td>
                  <td>
                    <span className={`badge ${g.before}`}>{g.before.replace("_", " ")}</span>
                  </td>
                  <td>
                    <span className={`badge ${g.after}`}>{g.after.replace("_", " ")}</span>
                  </td>
                  <td>
                    {fmtDelta(g.slackBeforeMinutes)} → <strong className={(g.slackAfterMinutes ?? 0) < 0 ? "later" : undefined}>{fmtDelta(g.slackAfterMinutes)}</strong>
                  </td>
                  <td className={(g.readyShiftMinutes ?? 0) > 0 ? "later" : undefined}>{fmtDelta(g.readyShiftMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <strong>Owners to notify</strong>
        {impact.ownersToNotify.length === 0 && impact.unownedAffectedTaskIds.length === 0 && <div className="muted small">Nobody's tasks move.</div>}
        <ul className="list-plain small">
          {impact.ownersToNotify.map((o) => (
            <li key={o.ownerId}>
              <strong>{userName(o.ownerId)}</strong> — {o.reasons.map((r) => r.replace(/_/g, " ")).join(", ")}:{" "}
              {o.taskIds.map((id) => (
                <button key={id} className="linkish mono" onClick={() => onSelect(id)} style={{ marginRight: 6 }}>
                  {model.refOf(id)}
                </button>
              ))}
            </li>
          ))}
          {impact.unownedAffectedTaskIds.length > 0 && (
            <li className="later">
              <strong>No owner assigned</strong> — nobody will be told about:{" "}
              {impact.unownedAffectedTaskIds.map((id) => (
                <button key={id} className="linkish mono" onClick={() => onSelect(id)} style={{ marginRight: 6 }}>
                  {model.refOf(id)}
                </button>
              ))}
            </li>
          )}
        </ul>
      </div>

      <div className="card" style={{ maxHeight: 420, overflow: "auto" }}>
        <strong>Affected tasks</strong>
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Owner</th>
              <th>Start shift</th>
              <th>Finish shift</th>
              <th>Finish</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {affected.map((a) => (
              <tr key={a.taskId}>
                <td>
                  <button className="linkish mono" onClick={() => onSelect(a.taskId)}>
                    {a.ref}
                  </button>{" "}
                  <span className="muted">{model.taskById.get(a.taskId)?.name}</span>
                </td>
                <td>{a.ownerId ? userName(a.ownerId) : <span className="muted">—</span>}</td>
                <td className={(a.startShiftMinutes ?? 0) > 0 ? "later" : (a.startShiftMinutes ?? 0) < 0 ? "earlier" : undefined}>{fmtDelta(a.startShiftMinutes)}</td>
                <td className={(a.finishShiftMinutes ?? 0) > 0 ? "later" : (a.finishShiftMinutes ?? 0) < 0 ? "earlier" : undefined}>{fmtDelta(a.finishShiftMinutes)}</td>
                <td className="mono">{fmtTime(a.after.earlyFinish, model.tz)}</td>
                <td className="row small" style={{ gap: 4 }}>
                  {a.becameCritical && <span className="badge critical">now critical</span>}
                  {a.leftCriticalPath && <span className="badge ok">off critical path</span>}
                  {a.deadlineBreachMinutes !== undefined && <span className="badge breached">breach {fmtDuration(a.deadlineBreachMinutes)}</span>}
                  {a.becameHeld && <span className="badge held">held</span>}
                  {a.released && <span className="badge ok">released</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
