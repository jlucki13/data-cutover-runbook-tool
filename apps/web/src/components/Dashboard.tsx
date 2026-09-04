/**
 * Live command-centre dashboard (PRD §4.6): overall status, the current critical path,
 * at-risk items, open gates, blocked work, and the notification outbox.
 *
 * Every number here comes from the engine. The one optional model-written element is the
 * plain-language headline, and it is labelled as such.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskId } from "@cutover/engine";
import { ApiError, decideGate, dispatchNotifications, draftGateComms, evaluateNotifications, getSummary, listNotifications, retryNotifications, type NotificationRow } from "../api";
import type { EventModel } from "../lib/model";
import { fmtDelta, fmtDuration, fmtTime, relDate } from "../lib/format";
import { STATUS } from "../lib/colors";

export function Dashboard({ model, onSelect }: { model: EventModel; onSelect: (id: TaskId) => void }) {
  const eventId = model.payload.event.id;
  const qc = useQueryClient();
  // The dashboard is the command centre's view of reality: it always reads the baseline,
  // never an active what-if. Scenarios belong to the Simulate tab, and mixing the two
  // would let a hypothetical breach appear beside a server-computed "on track" summary.
  const s = model.baseline;
  const live = model.mode === "live";
  const summary = useQuery({ queryKey: ["summary", eventId, live], queryFn: () => getSummary(eventId), refetchInterval: live ? 60_000 : false });
  const notes = useQuery({ queryKey: ["notifications", eventId], queryFn: () => listNotifications(eventId), refetchInterval: live ? 30_000 : false });
  const [msg, setMsg] = useState<string | null>(null);

  const dispatch = useMutation({
    mutationFn: () => dispatchNotifications(eventId),
    onSuccess: (r) => {
      setMsg(`Dispatched ${r.sent} of ${r.attempted}${r.failed ? `, ${r.failed} failed` : ""}.`);
      void qc.invalidateQueries({ queryKey: ["notifications", eventId] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : String(e)),
  });
  const recheck = useMutation({
    mutationFn: () => evaluateNotifications(eventId),
    onSuccess: (r) => {
      setMsg(`Re-checked: ${r.evaluated} notices apply, ${r.enqueued} new, ${r.suppressed} already sent.`);
      void qc.invalidateQueries({ queryKey: ["notifications", eventId] });
    },
  });
  const retry = useMutation({
    mutationFn: (ids: string[]) => retryNotifications(eventId, ids),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications", eventId] }),
  });

  const atRisk = s.deadlineBreaches.map((b) => ({ ...b, task: model.taskById.get(b.taskId)! })).filter((x) => x.task);
  const blocked = model.payload.tasks.filter((t) => t.status === "blocked" || t.status === "failed");
  const inProgress = model.payload.tasks.filter((t) => t.status === "in_progress");
  const openGates = model.payload.gates.filter((g) => g.decision === "pending");
  const failedNotes = (notes.data?.notifications ?? []).filter((n) => n.status === "failed");

  return (
    <div className="panel col" style={{ gap: 12 }}>
      {model.scenario && (
        <div className="notice small">
          A what-if scenario is active. This dashboard shows the real plan; open <strong>Simulate</strong> to see the scenario.
        </div>
      )}
      <div className="card col">
        <div className="row">
          <strong>Situation</strong>
          {summary.data?.model ? <span className="badge change">worded by {summary.data.model}</span> : <span className="badge">computed</span>}
          <span className="grow" />
          <button className="ghost small" onClick={() => void summary.refetch()}>
            ↻
          </button>
        </div>
        {summary.isLoading && <span className="muted">Reading the plan…</span>}
        {summary.data && (
          <>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{summary.data.headline}</div>
            <div>{summary.data.summary}</div>
            {summary.data.watchItems.length > 0 && (
              <ul className="list-plain small">
                {summary.data.watchItems.map((w, i) => (
                  <li key={i}>
                    <strong>{w.what}</strong> — {w.why}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="row" style={{ alignItems: "stretch", gap: 12 }}>
        <div className="card grow col" style={{ minWidth: 320 }}>
          <strong>Critical path</strong>
          {s.criticalPath.length === 0 ? (
            <span className="muted small">Nothing is critical: every chain has float.</span>
          ) : (
            <div className="row small" style={{ gap: 4 }}>
              {s.criticalPath.map((id, i) => (
                <span key={id} className="row" style={{ gap: 4 }}>
                  {i > 0 && <span className="muted">→</span>}
                  <button className="linkish mono" onClick={() => onSelect(id)}>
                    {model.refOf(id)}
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="small muted">
            {s.criticalTaskIds.length} task{s.criticalTaskIds.length === 1 ? "" : "s"} with no float ·{" "}
            {s.windowSlackMinutes !== undefined && s.windowSlackMinutes < 0 ? <span className="later">window breached by {fmtDuration(-s.windowSlackMinutes)}</span> : `window slack ${fmtDuration(s.windowSlackMinutes)}`}
          </div>
        </div>
        <div className="card col" style={{ minWidth: 260 }}>
          <strong>Progress</strong>
          <ProgressBar model={model} />
        </div>
      </div>

      <div className="card">
        <strong>Open gates</strong>
        {openGates.length === 0 && <div className="muted small">Every gate has been decided.</div>}
        {openGates.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Gate</th>
                <th>Status</th>
                <th>Entry work done</th>
                <th>Target</th>
                <th>Slack</th>
                <th>Approver</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {openGates.map((g) => {
                const gp = s.gates[g.id];
                return (
                  <tr key={g.id}>
                    <td>
                      {g.isPointOfNoReturn && <span title="Point of no return">⛔ </span>}
                      {g.name}
                    </td>
                    <td>
                      <span className={`badge ${gp?.status ?? ""}`}>{(gp?.status ?? "ok").replace("_", " ")}</span>
                      {gp?.assumed && (
                        <span className="badge warning" title="This projection rests on blocked work recovering as estimated">
                          assumed
                        </span>
                      )}
                    </td>
                    <td className="mono small">{fmtTime(gp?.projectedReadyAt, model.tz)}</td>
                    <td className="mono small">{g.targetDecisionAt ? fmtTime(Date.parse(g.targetDecisionAt), model.tz) : "—"}</td>
                    <td className={(gp?.slackMinutes ?? 0) < 0 ? "later" : undefined}>{fmtDelta(gp?.slackMinutes)}</td>
                    <td className="small">{g.approverId ? (model.userById.get(g.approverId)?.name ?? "—") : "—"}</td>
                    <td>
                      <GateActions model={model} gateId={g.id} gateName={g.name} onDone={() => void qc.invalidateQueries({ queryKey: ["graph", eventId] })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="card grow" style={{ minWidth: 340 }}>
          <strong>At risk</strong>
          {atRisk.length === 0 && blocked.length === 0 && <div className="muted small">No deadline breaches and nothing blocked.</div>}
          <ul className="list-plain small">
            {atRisk.map((x) => (
              <li key={x.taskId}>
                <span className="badge breached">−{fmtDuration(x.minutes)}</span>{" "}
                <button className="linkish mono" onClick={() => onSelect(x.taskId)}>
                  {x.task.ref}
                </button>{" "}
                {x.task.name} <span className="muted">({model.ownerName(x.task)})</span>
              </li>
            ))}
            {blocked.map((t) => (
              <li key={t.id}>
                <span className={`badge ${t.status === "failed" ? "breached" : "warning"}`}>{t.status}</span>{" "}
                <button className="linkish mono" onClick={() => onSelect(t.id)}>
                  {t.ref}
                </button>{" "}
                {t.name} <span className="muted">({model.ownerName(t)})</span>
                {t.statusNote && <div className="muted" style={{ marginLeft: 24 }}>{t.statusNote}</div>}
              </li>
            ))}
          </ul>
        </div>
        <div className="card grow" style={{ minWidth: 300 }}>
          <strong>In flight</strong>
          {inProgress.length === 0 && <div className="muted small">Nothing is in progress.</div>}
          <ul className="list-plain small">
            {inProgress.map((t) => {
              const tm = s.tasks[t.id];
              return (
                <li key={t.id}>
                  <button className="linkish mono" onClick={() => onSelect(t.id)}>
                    {t.ref}
                  </button>{" "}
                  {t.name} <span className="muted">({model.ownerName(t)})</span> → {fmtTime(tm?.earlyFinish, model.tz)}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <strong>Notifications</strong>
          {notes.data && (
            <span className="small muted">
              {notes.data.counts.pending ?? 0} pending · {notes.data.counts.sent ?? 0} sent
              {notes.data.counts.failed ? ` · ${notes.data.counts.failed} failed` : ""}
            </span>
          )}
          <span className="grow" />
          <button onClick={() => recheck.mutate()} disabled={recheck.isPending} title="Re-run the notification rules against the current schedule">
            Re-check
          </button>
          <button className="primary" onClick={() => dispatch.mutate()} disabled={dispatch.isPending || (notes.data?.counts.pending ?? 0) === 0}>
            Send pending
          </button>
          {failedNotes.length > 0 && (
            <button onClick={() => retry.mutate(failedNotes.map((n) => n.id))} disabled={retry.isPending}>
              Retry {failedNotes.length} failed
            </button>
          )}
        </div>
        {msg && <div className="small muted">{msg}</div>}
        <NotificationList rows={notes.data?.notifications ?? []} model={model} onSelect={onSelect} />
      </div>
    </div>
  );
}

function ProgressBar({ model }: { model: EventModel }) {
  const tasks = model.payload.tasks;
  const by = (s: string) => tasks.filter((t) => t.status === s).length;
  const segments = [
    { label: "complete", n: by("complete") + by("skipped"), color: STATUS.good },
    { label: "in progress", n: by("in_progress"), color: "#2a78d6" },
    { label: "blocked", n: by("blocked") + by("failed"), color: STATUS.critical },
    { label: "not started", n: by("not_started"), color: "#c3c2b7" },
  ];
  const total = Math.max(1, tasks.length);
  return (
    <>
      <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden", border: "1px solid var(--grid)" }}>
        {segments.map((s) => (s.n > 0 ? <div key={s.label} title={`${s.label}: ${s.n}`} style={{ width: `${(s.n / total) * 100}%`, background: s.color }} /> : null))}
      </div>
      <div className="row small muted" style={{ gap: 10 }}>
        {segments.map((s) => (
          <span key={s.label} className="row" style={{ gap: 4 }}>
            <span className="swatch" style={{ background: s.color }} /> {s.label} {s.n}
          </span>
        ))}
      </div>
    </>
  );
}

function GateActions({ model, gateId, gateName, onDone }: { model: EventModel; gateId: string; gateName: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (decision: "go" | "no_go") => {
    if (!confirm(`Record ${decision === "go" ? "GO" : "NO-GO"} on "${gateName}"? Everyone waiting on this gate is notified.`)) return;
    setBusy(true);
    setErr(null);
    try {
      await decideGate(gateId, decision);
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="row" style={{ gap: 4 }}>
      <button className="primary small" onClick={() => void decide("go")} disabled={busy}>
        Go
      </button>
      <button className="danger small" onClick={() => void decide("no_go")} disabled={busy}>
        No-go
      </button>
      <button
        className="ghost small"
        title="Draft a stakeholder note about this gate (a human reviews and sends it)"
        onClick={async () => {
          setErr(null);
          try {
            setDraft(await draftGateComms(gateId, "workstream leads and the programme sponsor"));
          } catch (e) {
            setErr(e instanceof ApiError ? e.message : String(e));
          }
        }}
      >
        Draft comms
      </button>
      {err && <span className="error small">{err}</span>}
      {draft && (
        <div className="card" style={{ position: "fixed", right: 24, bottom: 24, width: 460, zIndex: 40 }}>
          <div className="row">
            <strong>Draft: {draft.subject}</strong>
            <span className="grow" />
            <button className="ghost" onClick={() => setDraft(null)}>
              ×
            </button>
          </div>
          <textarea readOnly value={draft.body} rows={10} style={{ width: "100%" }} />
          <div className="small muted">Drafted from the engine's facts. Review before sending. Model: {model.payload.event.timezone ? "" : ""}</div>
        </div>
      )}
    </span>
  );
}

function NotificationList({ rows, model, onSelect }: { rows: NotificationRow[]; model: EventModel; onSelect: (id: TaskId) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (rows.length === 0) return <div className="muted small">Nothing to notify. Rules run automatically after every live change.</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Notice</th>
          <th>To</th>
          <th>Channel</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 60).map((n) => (
          <tr key={n.id}>
            <td className="small mono">{relDate(n.createdAt)}</td>
            <td>
              <span className={`badge ${n.severity === "critical" ? "breached" : n.severity === "warning" ? "warning" : "info"}`}>{n.severity}</span>{" "}
              {n.entityType === "task" && n.entityId ? (
                <button className="linkish" onClick={() => onSelect(n.entityId!)}>
                  {n.title}
                </button>
              ) : (
                n.title
              )}
              <button className="ghost small" onClick={() => setExpanded(expanded === n.id ? null : n.id)} title="Show the message">
                {expanded === n.id ? "−" : "+"}
              </button>
              {expanded === n.id && <div className="small muted" style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>}
            </td>
            <td className="small">{n.recipientUserId ? (model.userById.get(n.recipientUserId)?.name ?? "—") : "—"}</td>
            <td className="small">{n.channel}</td>
            <td>
              <span className={`badge ${n.status === "sent" ? "ok" : n.status === "failed" ? "breached" : ""}`}>{n.status}</span>
              {n.lastError && <div className="small error">{n.lastError}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
