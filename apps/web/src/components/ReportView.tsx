/**
 * Post-event report (PRD §4.6): the record a compliance reviewer asks for — planned vs
 * actual per task, every gate decision with its approver and timestamp, every status
 * change, and the full audit trail. Exports as JSON or CSV; prints cleanly to PDF.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getReport, reportUrl } from "../api";
import type { EventModel } from "../lib/model";
import { fmtDuration, fmtTime } from "../lib/format";

type Section = "summary" | "tasks" | "gates" | "changes" | "audit";

export function ReportView({ model }: { model: EventModel }) {
  const eventId = model.payload.event.id;
  const q = useQuery({ queryKey: ["report", eventId], queryFn: () => getReport(eventId) });
  const [section, setSection] = useState<Section>("summary");
  if (q.isLoading) return <div className="panel muted">Building the report…</div>;
  if (q.error) return <div className="panel error">{(q.error as Error).message}</div>;
  const r = q.data!;
  const tz = model.tz;
  const t = (iso: string | null) => (iso ? fmtTime(Date.parse(iso), tz) : "—");
  const variance = (m: number | null) => (m === null ? "—" : <span className={m > 0 ? "later" : m < 0 ? "earlier" : undefined}>{m > 0 ? `+${fmtDuration(m)}` : m < 0 ? `-${fmtDuration(-m)}` : "0"}</span>);

  return (
    <div className="panel col report" style={{ gap: 12 }}>
      <div className="card">
        <div className="row">
          <strong>{r.event.name} — post-event report</strong>
          <span className={`badge ${r.event.status}`}>{r.event.status}</span>
          <span className="grow" />
          <a className="chip" href={reportUrl(eventId, "audit.csv")} download>
            Audit trail (CSV)
          </a>
          <a className="chip" href={reportUrl(eventId, "tasks.csv")} download>
            Tasks (CSV)
          </a>
          <a className="chip" href={reportUrl(eventId, "json")} target="_blank" rel="noreferrer">
            Full record (JSON)
          </a>
          <button onClick={() => window.print()}>Print / PDF</button>
        </div>
        <div className="small muted">
          Generated {new Date(r.generatedAt).toLocaleString()} · window {t(r.event.windowStart)} → {t(r.event.windowEnd)} · {r.event.timezone}
          {r.event.actualStart ? ` · first task started ${t(r.event.actualStart)}` : ""}
          {r.event.actualEnd ? ` · last task finished ${t(r.event.actualEnd)}` : ""}
          {r.event.overranWindowMinutes ? ` · overran by ${fmtDuration(r.event.overranWindowMinutes)}` : ""}
        </div>
      </div>

      <div className="row" style={{ gap: 6 }}>
        {(["summary", "tasks", "gates", "changes", "audit"] as Section[]).map((s) => (
          <button key={s} className={`chip ${section === s ? "on" : ""}`} onClick={() => setSection(s)}>
            {s}
          </button>
        ))}
      </div>

      {section === "summary" && (
        <div className="row" style={{ gap: 12, alignItems: "stretch", flexWrap: "wrap" }}>
          {[
            { label: "Tasks", value: r.summary.tasks, delta: `${r.summary.complete} complete · ${r.summary.skipped} skipped` },
            { label: "Not finished", value: r.summary.notStarted + r.summary.inProgress + r.summary.blocked + r.summary.failed, delta: `${r.summary.blocked} blocked · ${r.summary.failed} failed`, warn: r.summary.failed > 0 },
            { label: "Deadlines missed", value: r.summary.deadlinesMissed, warn: r.summary.deadlinesMissed > 0 },
            { label: "Gates decided", value: `${r.summary.gatesDecided} / ${r.summary.gates}` },
            { label: "Status changes", value: r.summary.statusChanges },
            { label: "Imports committed", value: r.summary.imports },
            { label: "Notifications sent", value: r.summary.notificationsSent },
          ].map((tile) => (
            <div key={tile.label} className={`tile ${tile.warn ? "critical" : ""}`}>
              <div className="label">{tile.label}</div>
              <div className="value">{tile.value}</div>
              {tile.delta && <div className="delta">{tile.delta}</div>}
            </div>
          ))}
        </div>
      )}

      {section === "tasks" && (
        <div className="card" style={{ overflow: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Workstream</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Planned</th>
                <th>Actual start</th>
                <th>Actual end</th>
                <th>Actual</th>
                <th>vs planned</th>
                <th>Deadline</th>
              </tr>
            </thead>
            <tbody>
              {r.tasks.map((x) => (
                <tr key={x.ref}>
                  <td>
                    <span className="mono">{x.ref}</span> {x.name}
                  </td>
                  <td className="small">{x.workstream ?? "—"}</td>
                  <td className="small">{x.owner ?? "—"}</td>
                  <td>
                    <span className={`badge ${x.status === "complete" ? "ok" : x.status === "failed" ? "breached" : ""}`}>{String(x.status).replace("_", " ")}</span>
                  </td>
                  <td className="small">{fmtDuration(x.plannedDurationMinutes)}</td>
                  <td className="small mono">{t(x.actualStart)}</td>
                  <td className="small mono">{t(x.actualEnd)}</td>
                  <td className="small">{x.actualDurationMinutes === null ? "—" : fmtDuration(x.actualDurationMinutes)}</td>
                  <td className="small">{variance(x.durationVarianceMinutes)}</td>
                  <td className="small">{x.metDeadline === null ? "—" : x.metDeadline ? <span className="badge ok">met</span> : <span className="badge breached">missed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {section === "gates" && (
        <div className="card" style={{ overflow: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Gate</th>
                <th>Approver</th>
                <th>Target</th>
                <th>Decision</th>
                <th>Decided at</th>
                <th>Decided by</th>
                <th>vs target</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {r.gates.map((g) => (
                <tr key={g.name}>
                  <td>
                    {g.isPointOfNoReturn && <span title="Point of no return">⛔ </span>}
                    {g.name}
                    <div className="small muted">entry: {g.entryTaskRefs.join(", ") || "—"}</div>
                  </td>
                  <td className="small">{g.approver ?? "—"}</td>
                  <td className="small mono">{t(g.targetDecisionAt)}</td>
                  <td>
                    <span className={`badge ${g.decision === "go" ? "ok" : g.decision === "no_go" ? "breached" : ""}`}>{String(g.decision).replace("_", "-")}</span>
                  </td>
                  <td className="small mono">{t(g.decidedAt)}</td>
                  <td className="small">{g.decidedBy ?? "—"}</td>
                  <td className="small">{variance(g.decisionVarianceMinutes)}</td>
                  <td className="small">{g.decisionNote ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {section === "changes" && (
        <div className="card" style={{ overflow: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Task</th>
                <th>From</th>
                <th>To</th>
                <th>By</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {r.statusChanges.map((c, i) => (
                <tr key={i}>
                  <td className="small mono">{t(c.at)}</td>
                  <td className="mono small">{c.taskRef}</td>
                  <td className="small">{String(c.from ?? "—").replace("_", " ")}</td>
                  <td className="small">{String(c.to ?? "—").replace("_", " ")}</td>
                  <td className="small">{c.actor ?? "system"}</td>
                  <td className="small">{c.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {section === "audit" && (
        <div className="card" style={{ overflow: "auto", maxHeight: 620 }}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {r.auditTrail.map((a, i) => (
                <tr key={i}>
                  <td className="small mono">{t(a.at)}</td>
                  <td className="small">{a.actor ?? "system"}</td>
                  <td className="small mono">{a.action}</td>
                  <td className="small">
                    {a.entityType} {a.entity}
                  </td>
                  <td className="small muted">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
