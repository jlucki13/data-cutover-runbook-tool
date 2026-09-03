import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Change, TaskId, TaskStatus } from "@cutover/engine";
import { ApiError, patchTask } from "../api";
import type { EventModel } from "../lib/model";
import { fmtDelta, fmtDuration, fmtTime } from "../lib/format";

const STATUSES: TaskStatus[] = ["not_started", "in_progress", "blocked", "complete", "failed", "skipped"];

export function TaskPanel({ model, taskId, onClose, onSelect, onFocus, onAddChange }: { model: EventModel; taskId: TaskId; onClose: () => void; onSelect: (id: TaskId) => void; onFocus: (id: TaskId) => void; onAddChange: (c: Change) => void }) {
  const qc = useQueryClient();
  const t = model.taskById.get(taskId)!;
  const tm = model.schedule.tasks[taskId];
  const btm = model.baseline.tasks[taskId];
  const g = model.graph;
  const preds = g.inEdges.get(taskId) ?? [];
  const succs = g.outEdges.get(taskId) ?? [];
  const [status, setStatus] = useState<TaskStatus>(t.status);
  const [remaining, setRemaining] = useState<string>(t.remainingDurationMinutes?.toString() ?? "");
  const [unblock, setUnblock] = useState<string>("");
  const [note, setNote] = useState<string>(t.statusNote ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [delay, setDelay] = useState("60");

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await patchTask(taskId, {
        status,
        statusNote: note || null,
        remainingDurationMinutes: remaining === "" ? null : Number(remaining),
        expectedUnblockAt: unblock ? Date.parse(unblock) : undefined,
      });
      await qc.invalidateQueries({ queryKey: ["graph", t.eventId] });
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message}${e.details ? ` — ${JSON.stringify(e.details)}` : ""}` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shift = model.scenario && tm?.earlyFinish !== undefined && btm?.earlyFinish !== undefined ? Math.round((tm.earlyFinish - btm.earlyFinish) / 60_000) : undefined;

  return (
    <aside className="side">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>
          <span className="mono">{t.ref}</span> {t.name}
        </h3>
        <button className="ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="row small">
        <span className="badge">{t.status.replace("_", " ")}</span>
        {tm?.isCritical && <span className="badge critical">critical</span>}
        {tm?.held && <span className="badge held">held</span>}
        {tm && tm.assumedFrom.length > 0 && <span className="badge warning">assumed</span>}
        {tm?.deadlineBreachMinutes !== undefined && <span className="badge breached">breach {fmtDuration(tm.deadlineBreachMinutes)}</span>}
      </div>
      <h4>Plan</h4>
      <dl className="kv">
        <dt>Workstream</dt>
        <dd>{t.workstreamId ? model.workstreamById.get(t.workstreamId)?.name : "—"}</dd>
        <dt>Owner</dt>
        <dd>{model.ownerName(t)}</dd>
        <dt>Duration</dt>
        <dd>{fmtDuration(t.plannedDurationMinutes)}</dd>
        <dt>Start no earlier</dt>
        <dd>{t.plannedStart ? fmtTime(Date.parse(t.plannedStart), model.tz) : "—"}</dd>
        <dt>Deadline</dt>
        <dd>{t.windowDeadline ? fmtTime(Date.parse(t.windowDeadline), model.tz) : "—"}</dd>
        {t.description && (
          <>
            <dt>Notes</dt>
            <dd>{t.description}</dd>
          </>
        )}
        {Object.entries(t.customFields ?? {}).map(([k, v]) => (
          <span key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{String(v)}</dd>
          </span>
        ))}
      </dl>
      <h4>Projection {model.scenario ? "(what-if)" : model.mode === "live" ? "(live)" : ""}</h4>
      {tm?.held ? (
        <div className="notice">
          Held: {tm.held.reason.replace("_", " ")}
          {tm.held.byTaskIds ? ` by ${tm.held.byTaskIds.map(model.refOf).join(", ")}` : ""}
          {tm.held.byGateId ? ` by gate ${model.payload.gates.find((x) => x.id === tm.held!.byGateId)?.name ?? ""}` : ""}
        </div>
      ) : (
        <dl className="kv">
          <dt>Early start</dt>
          <dd>{fmtTime(tm?.earlyStart, model.tz)}</dd>
          <dt>Early finish</dt>
          <dd>
            {fmtTime(tm?.earlyFinish, model.tz)} {shift !== undefined && shift !== 0 && <span className={shift > 0 ? "later" : "earlier"}>({fmtDelta(shift)})</span>}
          </dd>
          <dt>Late start</dt>
          <dd>{fmtTime(tm?.lateStart, model.tz)}</dd>
          <dt>Late finish</dt>
          <dd>{fmtTime(tm?.lateFinish, model.tz)}</dd>
          <dt>Total float</dt>
          <dd className={tm && tm.totalFloatMinutes !== undefined && tm.totalFloatMinutes < 0 ? "later" : undefined}>{fmtDuration(tm?.totalFloatMinutes)}</dd>
          <dt>Driven by</dt>
          <dd>
            {tm && tm.drivenBy.length > 0
              ? tm.drivenBy.map((k) =>
                  k.startsWith("task:") ? (
                    <button key={k} className="linkish" onClick={() => onSelect(k.slice(5))} style={{ marginRight: 6 }}>
                      {model.refOf(k.slice(5))}
                    </button>
                  ) : (
                    <span key={k} style={{ marginRight: 6 }}>
                      gate {model.payload.gates.find((x) => x.id === k.slice(5))?.name ?? ""}
                    </span>
                  ),
                )
              : "its own constraint"}
          </dd>
          {tm?.assumption && (
            <>
              <dt>Assumption</dt>
              <dd>
                {tm.assumption.kind === "blocked_recovery" ? "resumes" : "re-runs"} at {fmtTime(tm.assumption.resumeAt, model.tz)} ({tm.assumption.fromOwnerEstimate ? "owner estimate" : "event default"})
              </dd>
            </>
          )}
          {tm && tm.assumedFrom.length > 0 && !tm.assumption && (
            <>
              <dt>Assumes</dt>
              <dd>recovery of {tm.assumedFrom.map(model.refOf).join(", ")}</dd>
            </>
          )}
        </dl>
      )}
      <h4>Dependencies</h4>
      <div className="small">
        <div className="muted">Predecessors</div>
        <ul className="list-plain">
          {preds.length === 0 && <li className="muted">none</li>}
          {preds.map((e) => (
            <li key={e.predecessorId + e.viaGateId}>
              <button className="linkish" onClick={() => onSelect(e.predecessorId)}>
                {model.refOf(e.predecessorId)}
              </button>{" "}
              <span className="muted">
                {model.taskById.get(e.predecessorId)?.name} {e.viaGateId ? "(via gate)" : `${e.type}${e.lagMinutes ? fmtDelta(e.lagMinutes) : ""}`}
              </span>
            </li>
          ))}
        </ul>
        <div className="muted">Successors</div>
        <ul className="list-plain">
          {succs.length === 0 && <li className="muted">none</li>}
          {succs.map((e) => (
            <li key={e.successorId + e.viaGateId}>
              <button className="linkish" onClick={() => onSelect(e.successorId)}>
                {model.refOf(e.successorId)}
              </button>{" "}
              <span className="muted">
                {model.taskById.get(e.successorId)?.name} {e.viaGateId ? "(via gate)" : ""}
              </span>
            </li>
          ))}
        </ul>
        <button className="small" onClick={() => onFocus(taskId)}>
          Focus neighborhood
        </button>
      </div>
      <h4>What if</h4>
      <div className="row small">
        <span>delay by</span>
        <input value={delay} onChange={(e) => setDelay(e.target.value)} style={{ width: 60 }} /> min
        <button onClick={() => onAddChange({ kind: "delay", taskId, minutes: Number(delay) || 0 })} disabled={t.status === "complete" || t.status === "skipped"}>
          Add to scenario
        </button>
      </div>
      <h4>Update status {model.mode !== "live" && <span className="muted">(event is in planning; statuses still record)</span>}</h4>
      <div className="col small">
        <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace("_", " ")}
            </option>
          ))}
        </select>
        {(status === "in_progress" || status === "blocked") && (
          <label className="row">
            remaining <input value={remaining} onChange={(e) => setRemaining(e.target.value)} placeholder="minutes" style={{ width: 80 }} />
          </label>
        )}
        {(status === "blocked" || status === "failed") && (
          <label className="row">
            expected unblock <input type="datetime-local" value={unblock} onChange={(e) => setUnblock(e.target.value)} />
          </label>
        )}
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (why blocked, what changed)" />
        <div className="row">
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          {err && <span className="error">{err}</span>}
        </div>
      </div>
    </aside>
  );
}
