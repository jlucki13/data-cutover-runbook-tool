import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Change, TaskId } from "@cutover/engine";
import { patchEvent } from "../api";
import { applyFilters, EMPTY_FILTERS, type Filters } from "../lib/filters";
import { useEventModel } from "../lib/model";
import { StatusStrip } from "./StatusStrip";
import { FilterBar } from "./FilterBar";
import { GraphView } from "./GraphView";
import { TimelineView } from "./TimelineView";
import { TaskPanel } from "./TaskPanel";
import { SimulatePanel } from "./SimulatePanel";
import { ImportsPage } from "./ImportsPage";
import { AuditView } from "./AuditView";

const TABS = ["graph", "timeline", "simulate", "imports", "audit"] as const;
type Tab = (typeof TABS)[number];

export function EventPage() {
  const { eventId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get("view") as Tab) ? params.get("view") : "graph") as Tab;
  const setTab = (t: Tab) => setParams((p) => ({ ...Object.fromEntries(p), view: t }));

  const [changes, setChanges] = useState<Change[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<TaskId | null>(null);
  const qc = useQueryClient();
  const { model, isLoading, error, refetch } = useEventModel(eventId, changes);

  const visible = useMemo(() => (model ? applyFilters(model.payload.tasks, model.graph, model.schedule, filters) : []), [model, filters]);

  if (isLoading) return <div className="panel muted">Loading event…</div>;
  if (error || !model) return <div className="panel error">{error?.message ?? "Could not load event"}</div>;
  if (model.graphError) return <div className="panel error">The committed graph is invalid: {model.graphError}</div>;

  const ev = model.payload.event;
  const focus = (taskId: TaskId, radius = 2) => {
    setFilters((f) => ({ ...f, focus: { taskId, radius } }));
    setSelected(taskId);
  };
  const setStatus = async (status: "planning" | "live" | "closed") => {
    await patchEvent(ev.id, { status });
    await qc.invalidateQueries({ queryKey: ["graph", ev.id] });
  };

  return (
    <div className="event-page">
      <div className="row" style={{ padding: "8px 16px 0", background: "var(--surface)" }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{ev.name}</h2>
        <span className={`badge ${ev.status}`}>{ev.status}</span>
        <span className="muted small">{ev.timezone}</span>
        {model.scenario && <span className="badge change">what-if: {changes.length} change{changes.length === 1 ? "" : "s"}</span>}
        <span className="grow" />
        {ev.status === "planning" && (
          <button onClick={() => void setStatus("live")} title="Switch to live mode: statuses and actuals drive the schedule">
            Go live
          </button>
        )}
        {ev.status === "live" && (
          <button onClick={() => void setStatus("closed")} title="Close the event">
            Close event
          </button>
        )}
        <button className="ghost" onClick={refetch} title="Reload from the server">
          ↻
        </button>
      </div>
      <StatusStrip model={model} />
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="workspace">
        <div className="main">
          {(tab === "graph" || tab === "timeline") && <FilterBar model={model} filters={filters} setFilters={setFilters} visibleCount={visible.length} />}
          <div className="view">
            {tab === "graph" && <GraphView model={model} visible={visible} selected={selected} onSelect={setSelected} onFocus={focus} />}
            {tab === "timeline" && <TimelineView model={model} visible={visible} selected={selected} onSelect={setSelected} filters={filters} />}
            {tab === "simulate" && <SimulatePanel model={model} changes={changes} setChanges={setChanges} onSelect={setSelected} />}
            {tab === "imports" && <ImportsPage model={model} onCommitted={() => void qc.invalidateQueries({ queryKey: ["graph", ev.id] })} />}
            {tab === "audit" && <AuditView model={model} />}
          </div>
        </div>
        {selected && model.taskById.has(selected) && (
          <TaskPanel model={model} taskId={selected} onClose={() => setSelected(null)} onSelect={setSelected} onFocus={focus} onAddChange={(c) => setChanges((cs) => [...cs, c])} />
        )}
      </div>
    </div>
  );
}
