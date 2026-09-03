/**
 * Import workflow UI: upload a worksheet (or paste prose), review the staged
 * candidates against the committed graph, accept/reject, commit. Nothing reaches the
 * graph until the reviewer commits.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, commitImport, createImport, discardImport, getImport, listImports, reviewImport, type CandidateDependency, type CandidateTask, type CreateImportBody, type ImportBatch, type ReviewState } from "../api";
import type { EventModel } from "../lib/model";
import { fmtDelta, fmtDuration, fmtTime, relDate } from "../lib/format";

function formatFor(name: string): CreateImportBody["format"] {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "xml") return "ms_project_xml";
  return "csv";
}

function readFile(file: File, asBase64: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const res = r.result as string;
      resolve(asBase64 ? res.slice(res.indexOf(",") + 1) : res);
    };
    if (asBase64) r.readAsDataURL(file);
    else r.readAsText(file);
  });
}

export function ImportsPage({ model, onCommitted }: { model: EventModel; onCommitted: () => void }) {
  const eventId = model.payload.event.id;
  const qc = useQueryClient();
  const batches = useQuery({ queryKey: ["imports", eventId], queryFn: () => listImports(eventId) });
  const [selected, setSelected] = useState<string | null>(null);
  const [prose, setProse] = useState("");
  const [removalScope, setRemovalScope] = useState<"incoming_workstreams" | "none" | "all">("incoming_workstreams");
  const [defaultWs, setDefaultWs] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: (body: CreateImportBody) => createImport(eventId, body),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["imports", eventId] });
      setSelected(r.batch.id);
      setErr(null);
    },
    onError: (e) => setErr(e instanceof ApiError ? `${e.message}${e.details ? ` — ${JSON.stringify(e.details).slice(0, 300)}` : ""}` : String(e)),
  });

  const onFile = async (file: File) => {
    const format = formatFor(file.name);
    const content = await readFile(file, format === "xlsx");
    upload.mutate({ format, filename: file.name, content, encoding: format === "xlsx" ? "base64" : "utf8", options: { removalScope, ...(defaultWs ? { defaultWorkstream: defaultWs } : {}) } });
  };

  return (
    <div className="panel col" style={{ gap: 12 }}>
      <div className="card col">
        <strong>New import</strong>
        <div className="row">
          <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xml" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} disabled={upload.isPending} />
          <label className="row small">
            removals
            <select value={removalScope} onChange={(e) => setRemovalScope(e.target.value as typeof removalScope)} title="Which existing tasks this upload may propose to remove">
              <option value="incoming_workstreams">within the uploaded workstreams</option>
              <option value="none">never</option>
              <option value="all">full replacement</option>
            </select>
          </label>
          <label className="row small">
            default workstream <input value={defaultWs} onChange={(e) => setDefaultWs(e.target.value)} placeholder="if the sheet has none" style={{ width: 160 }} />
          </label>
        </div>
        <details>
          <summary className="small">Or paste free text (parsed by Claude, every dependency reviewed before commit)</summary>
          <textarea value={prose} onChange={(e) => setProse(e.target.value)} rows={5} style={{ width: "100%", marginTop: 6 }} placeholder="Task 14 starts after Task 9 and Task 11 complete…" />
          <button disabled={!prose.trim() || upload.isPending} onClick={() => upload.mutate({ format: "prose", filename: "notes", content: prose, options: { removalScope: "none", ...(defaultWs ? { defaultWorkstream: defaultWs } : {}) } })}>
            Parse text
          </button>
        </details>
        {upload.isPending && <span className="muted small">Parsing and compiling against the current runbook…</span>}
        {err && <span className="error small">{err}</span>}
      </div>

      <div className="card">
        <strong>Imports</strong>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>File</th>
              <th>Format</th>
              <th>Status</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {(batches.data ?? []).map((b) => (
              <tr key={b.id} style={{ background: b.id === selected ? "var(--surface)" : undefined }}>
                <td className="small">{relDate(b.createdAt)}</td>
                <td>
                  <button className="linkish" onClick={() => setSelected(b.id)}>
                    {b.filename ?? b.id.slice(0, 8)}
                  </button>
                  {b.worksheets.length > 1 && <span className="muted small"> ({b.worksheets.length} sheets)</span>}
                </td>
                <td className="small">{b.format}</td>
                <td>
                  <span className={`badge ${b.status === "review" ? "warning" : b.status === "committed" ? "ok" : ""}`}>{b.status}</span>
                </td>
                <td className="small muted">{summaryLine(b)}</td>
              </tr>
            ))}
            {batches.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No imports yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && <ImportReview batchId={selected} model={model} onCommitted={onCommitted} onDone={() => void qc.invalidateQueries({ queryKey: ["imports", eventId] })} />}
    </div>
  );
}

function summaryLine(b: ImportBatch): string {
  const s = b.summary;
  if (!s) return "";
  return `+${s.tasksAdded ?? 0} ~${s.tasksChanged ?? 0} −${s.tasksRemoved ?? 0} tasks · +${s.dependenciesAdded ?? 0} ~${s.dependenciesChanged ?? 0} −${s.dependenciesRemoved ?? 0} deps · ${s.errors ?? 0} errors, ${s.warnings ?? 0} warnings`;
}

function ImportReview({ batchId, model, onCommitted, onDone }: { batchId: string; model: EventModel; onCommitted: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["import", batchId], queryFn: () => getImport(batchId) });
  const [acceptAll, setAcceptAll] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["import", batchId] });
  const review = useMutation({ mutationFn: (body: Parameters<typeof reviewImport>[1]) => reviewImport(batchId, body), onSuccess: refresh, onError: (e) => setMsg(String(e)) });
  const commit = useMutation({
    mutationFn: () => commitImport(batchId, acceptAll),
    onSuccess: (r) => {
      setMsg(`Committed: ${r.tasksCreated} tasks created, ${r.tasksUpdated} updated, ${r.tasksDeleted} removed; ${r.dependenciesCreated} dependencies created, ${r.dependenciesDeleted} removed.${Array.isArray(r.unmatchedOwners) && r.unmatchedOwners.length ? ` Owners not matched to users: ${(r.unmatchedOwners as string[]).join(", ")}.` : ""}`);
      refresh();
      onDone();
      onCommitted();
    },
    onError: (e) => setMsg(e instanceof ApiError ? `${e.message}${e.details ? ` — ${describeDetails(e.details)}` : ""}` : String(e)),
  });
  const discard = useMutation({
    mutationFn: () => discardImport(batchId),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  if (q.isLoading || !q.data) return <div className="muted">Loading review…</div>;
  const { batch, tasks, dependencies, issues } = q.data;
  const editable = batch.status === "review";
  const setTask = (c: CandidateTask, reviewState: ReviewState) => review.mutate({ tasks: [{ id: c.id, reviewState }] });
  const setDep = (c: CandidateDependency, reviewState: ReviewState) => review.mutate({ dependencies: [{ id: c.id, reviewState }] });
  const visibleTasks = tasks.filter((t) => showUnchanged || t.diffKind !== "unchanged");
  const visibleDeps = dependencies.filter((d) => showUnchanged || d.diffKind !== "unchanged");
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity !== "error");
  const isLlm = batch.format === "prose_llm";

  return (
    <div className="card col" style={{ gap: 10 }}>
      <div className="row">
        <strong>Review: {batch.filename ?? batch.id.slice(0, 8)}</strong>
        <span className={`badge ${batch.status === "review" ? "warning" : batch.status === "committed" ? "ok" : ""}`}>{batch.status}</span>
        <span className="muted small">{summaryLine(batch)}</span>
        <span className="grow" />
        <label className="small row">
          <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} /> show unchanged
        </label>
        {editable && (
          <>
            <button onClick={() => review.mutate({ allProposed: "accepted" })}>Accept all proposed</button>
            <button onClick={() => review.mutate({ allProposed: "rejected" })}>Reject all proposed</button>
            <label className="small row" title={isLlm ? "For LLM-parsed batches only dependencies with confidence ≥ 0.9 are auto-accepted" : ""}>
              <input type="checkbox" checked={acceptAll} onChange={(e) => setAcceptAll(e.target.checked)} /> treat proposed as accepted
            </label>
            <button className="primary" onClick={() => commit.mutate()} disabled={commit.isPending || errors.length > 0} title={errors.length > 0 ? "Resolve the errors first" : ""}>
              Commit to runbook
            </button>
            <button className="danger" onClick={() => discard.mutate()}>
              Discard
            </button>
          </>
        )}
      </div>
      {msg && <div className="notice small">{msg}</div>}
      {errors.length > 0 && (
        <div className="notice small">
          <strong className="error">{errors.length} blocking issue{errors.length === 1 ? "" : "s"}</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {errors.map((i, k) => (
              <li key={k}>
                {i.line ? <span className="muted">line {i.line}: </span> : null}
                {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <details className="small">
          <summary>{warnings.length} warnings / notes</summary>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {warnings.map((i, k) => (
              <li key={k}>
                <span className={`badge ${i.severity}`}>{i.severity}</span> {i.line ? <span className="muted">line {i.line}: </span> : null}
                {i.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div style={{ maxHeight: 360, overflow: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Change</th>
              <th>Workstream</th>
              <th>Owner</th>
              <th>Duration</th>
              <th>Start / deadline</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {visibleTasks.map((c) => (
              <tr key={c.id} style={c.reviewState === "rejected" ? { opacity: 0.5 } : undefined}>
                <td>
                  <span className="mono">{c.ref}</span> {c.name}
                  {c.worksheet && <div className="muted small">{c.worksheet}{c.sourceLine ? ` · row ${c.sourceLine}` : ""}</div>}
                </td>
                <td>
                  <span className={`badge ${c.diffKind}`}>{c.diffKind}</span>
                  {c.changes && (
                    <div className="small muted">
                      {c.changes.map((ch) => (
                        <div key={ch.field}>
                          {ch.field}: {fmtField(ch.field, ch.before, model.tz)} → <strong>{fmtField(ch.field, ch.after, model.tz)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td>{c.workstreamName ?? <span className="muted">—</span>}</td>
                <td>{c.ownerName ?? <span className="muted">—</span>}</td>
                <td>{c.plannedDurationMinutes !== null ? fmtDuration(c.plannedDurationMinutes) : <span className="muted">—</span>}</td>
                <td className="small">
                  {c.plannedStart ? fmtTime(Date.parse(c.plannedStart), model.tz) : ""}
                  {c.windowDeadline ? <div>due {fmtTime(Date.parse(c.windowDeadline), model.tz)}</div> : null}
                </td>
                <td>
                  <ReviewButtons state={c.reviewState} editable={editable} onChange={(s) => setTask(c, s)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ maxHeight: 360, overflow: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Dependency</th>
              <th>Change</th>
              <th>Type</th>
              <th>Resolution</th>
              {isLlm && <th>Confidence</th>}
              <th>Evidence</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {visibleDeps.map((d) => (
              <tr key={d.id} style={d.reviewState === "rejected" ? { opacity: 0.5 } : undefined}>
                <td className="mono">
                  {d.predecessorRef} → {d.successorRef}
                </td>
                <td>
                  <span className={`badge ${d.diffKind}`}>{d.diffKind}</span>
                </td>
                <td>
                  {d.type}
                  {d.lagMinutes ? ` ${fmtDelta(d.lagMinutes)}` : ""}
                </td>
                <td>{d.resolution === "unresolved" ? <span className="badge error">unresolved</span> : d.resolution === "loose" ? <span className="badge warning">loose match</span> : <span className="muted">exact</span>}</td>
                {isLlm && <td className={d.confidence !== null && Number(d.confidence) < 0.9 ? "later" : undefined}>{d.confidence ?? "—"}</td>}
                <td className="small muted" style={{ maxWidth: 320 }}>
                  {d.evidence}
                </td>
                <td>
                  <ReviewButtons state={d.reviewState} editable={editable} onChange={(s) => setDep(d, s)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReviewButtons({ state, editable, onChange }: { state: ReviewState; editable: boolean; onChange: (s: ReviewState) => void }) {
  if (!editable) return <span className={`badge ${state}`}>{state}</span>;
  return (
    <span className="row" style={{ gap: 4 }}>
      <button className={`chip ${state === "accepted" ? "on" : ""}`} onClick={() => onChange("accepted")}>
        accept
      </button>
      <button className={`chip ${state === "rejected" ? "on" : ""}`} onClick={() => onChange("rejected")}>
        reject
      </button>
      {state === "proposed" && <span className="muted small">proposed</span>}
    </span>
  );
}

function fmtField(field: string, v: unknown, tz: string): string {
  if (v === undefined || v === null) return "—";
  if (field === "plannedStart" || field === "windowDeadline") return typeof v === "number" ? fmtTime(v, tz) : String(v);
  if (field === "plannedDurationMinutes") return fmtDuration(Number(v));
  return String(v);
}

function describeDetails(d: unknown): string {
  if (Array.isArray(d)) return d.map((x) => (typeof x === "object" && x && "predecessorRef" in x ? `${(x as { predecessorRef: string }).predecessorRef} → ${(x as { successorRef: string }).successorRef}` : JSON.stringify(x))).join(", ");
  if (typeof d === "object" && d && "issues" in d) return ((d as { issues: { message: string }[] }).issues ?? []).map((i) => i.message).join(" ");
  return JSON.stringify(d).slice(0, 300);
}
