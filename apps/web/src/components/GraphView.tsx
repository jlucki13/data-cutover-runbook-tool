/**
 * Dependency graph (DAG) view. Renders the filtered subgraph with a layered layout,
 * critical path highlighted by default, gates as round nodes, scenario shifts as badges.
 * Large events are meant to be explored through filters and neighborhood focus rather
 * than drawn whole.
 */
import { memo, useEffect, useMemo } from "react";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import type { TaskId } from "@cutover/engine";
import type { EventModel } from "../lib/model";
import { layoutGraph } from "../lib/layout";
import { fmtDelta, fmtDuration, fmtTime } from "../lib/format";
import { STATUS, tint } from "../lib/colors";

const MAX_NODES = 600;

interface TaskNodeData extends Record<string, unknown> {
  ref: string;
  name: string;
  owner: string;
  color: string;
  status: string;
  start?: string;
  duration: string;
  float?: number;
  critical: boolean;
  held: boolean;
  assumed: boolean;
  selected: boolean;
  shift?: number;
  breach?: number;
}
interface GateNodeData extends Record<string, unknown> {
  name: string;
  status: string;
  slack?: number;
  ponr: boolean;
}

const TaskNode = memo(({ data }: NodeProps<Node<TaskNodeData>>) => (
  <div className={`task-node ${data.critical ? "critical" : ""} ${data.held ? "held" : ""} ${data.assumed ? "assumed" : ""} ${data.selected ? "selected" : ""}`} style={{ borderColor: data.critical ? undefined : data.color, background: data.critical ? tint(STATUS.critical, 0.06) : tint(data.color, 0.08) }}>
    <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
    <div className="row" style={{ justifyContent: "space-between" }}>
      <span className="ref">{data.ref}</span>
      <span className="small muted">{data.status.replace("_", " ")}</span>
    </div>
    <div className="name" title={data.name}>
      {data.name}
    </div>
    <div className="meta">
      <span>{data.held ? "held" : data.start}</span>
      <span>{data.duration}</span>
    </div>
    <div className="meta">
      <span>{data.owner}</span>
      <span>
        {data.shift !== undefined && data.shift !== 0 && <span className={`shift ${data.shift > 0 ? "later" : "earlier"}`}>{fmtDelta(data.shift)} </span>}
        {data.breach !== undefined && <span className="shift later">breach {fmtDuration(data.breach)} </span>}
        {data.float !== undefined && !data.held && <span title="total float">float {fmtDuration(data.float)}</span>}
      </span>
    </div>
    <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
  </div>
));
TaskNode.displayName = "TaskNode";

const GateNode = memo(({ data }: NodeProps<Node<GateNodeData>>) => (
  <div className={`gate-node ${data.status}`}>
    <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
    <div>
      <strong>{data.ponr ? "⛔ " : "◆ "}</strong>
      {data.name}
    </div>
    <div className="small muted">
      <span className={`badge ${data.status}`}>{data.status.replace("_", " ")}</span>
      {data.slack !== undefined && <span> slack {fmtDelta(data.slack)}</span>}
    </div>
    <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
  </div>
));
GateNode.displayName = "GateNode";

const nodeTypes = { task: TaskNode, gate: GateNode };

function Inner({ model, visible, selected, onSelect, onFocus }: { model: EventModel; visible: TaskId[]; selected: TaskId | null; onSelect: (id: TaskId | null) => void; onFocus: (id: TaskId) => void }) {
  const { fitView } = useReactFlow();
  const truncated = visible.length > MAX_NODES;
  const shown = useMemo(() => (truncated ? visible.slice(0, MAX_NODES) : visible), [visible, truncated]);

  const { nodes, edges } = useMemo(() => {
    const s = model.schedule;
    const base = model.baseline;
    const set = new Set(shown);
    const gateIds = model.payload.gates.filter((g) => g.entryTaskIds.some((id) => set.has(id)) || g.gatedTaskIds.some((id) => set.has(id))).map((g) => g.id);
    const layoutNodes = [...shown.map((id) => ({ id, width: 220, height: 78 })), ...gateIds.map((id) => ({ id: `gate:${id}`, width: 200, height: 56 }))];
    const layoutEdges: { source: string; target: string }[] = [];
    for (const d of model.payload.dependencies) if (set.has(d.predecessorTaskId) && set.has(d.successorTaskId)) layoutEdges.push({ source: d.predecessorTaskId, target: d.successorTaskId });
    for (const g of model.payload.gates) {
      if (!gateIds.includes(g.id)) continue;
      for (const e of g.entryTaskIds) if (set.has(e)) layoutEdges.push({ source: e, target: `gate:${g.id}` });
      for (const t of g.gatedTaskIds) if (set.has(t)) layoutEdges.push({ source: `gate:${g.id}`, target: t });
    }
    const pos = layoutGraph(layoutNodes, layoutEdges);
    const critical = new Set(s.criticalTaskIds);
    const pathEdges = new Set<string>();
    for (let i = 1; i < s.criticalPath.length; i++) pathEdges.add(`${s.criticalPath[i - 1]}>${s.criticalPath[i]}`);

    const nodes: Node[] = shown.map((id) => {
      const t = model.taskById.get(id)!;
      const tm = s.tasks[id];
      const btm = base.tasks[id];
      const shift = model.scenario && tm?.earlyFinish !== undefined && btm?.earlyFinish !== undefined ? Math.round((tm.earlyFinish - btm.earlyFinish) / 60_000) : undefined;
      const data: TaskNodeData = {
        ref: t.ref,
        name: t.name,
        owner: model.ownerName(t),
        color: model.colorOf(t),
        status: t.status,
        start: tm?.earlyStart !== undefined ? fmtTime(tm.earlyStart, model.tz) : undefined,
        duration: fmtDuration(t.plannedDurationMinutes),
        float: tm?.totalFloatMinutes,
        critical: critical.has(id),
        held: !!tm?.held,
        assumed: (tm?.assumedFrom.length ?? 0) > 0,
        selected: id === selected,
        shift,
        breach: tm?.deadlineBreachMinutes,
      };
      return { id, type: "task", position: pos.get(id) ?? { x: 0, y: 0 }, data, draggable: false };
    });
    for (const gid of gateIds) {
      const g = model.payload.gates.find((x) => x.id === gid)!;
      const gp = s.gates[gid];
      const data: GateNodeData = { name: g.name, status: gp?.status ?? "ok", slack: gp?.slackMinutes, ponr: g.isPointOfNoReturn };
      nodes.push({ id: `gate:${gid}`, type: "gate", position: pos.get(`gate:${gid}`) ?? { x: 0, y: 0 }, data, draggable: false });
    }
    const edges: Edge[] = [];
    for (const d of model.payload.dependencies) {
      if (!set.has(d.predecessorTaskId) || !set.has(d.successorTaskId)) continue;
      const onPath = pathEdges.has(`${d.predecessorTaskId}>${d.successorTaskId}`);
      const driving = s.tasks[d.successorTaskId]?.drivenBy.includes(`task:${d.predecessorTaskId}`) ?? false;
      edges.push({
        id: d.id,
        source: d.predecessorTaskId,
        target: d.successorTaskId,
        label: d.type !== "FS" || d.lagMinutes !== 0 ? `${d.type}${d.lagMinutes ? fmtDelta(d.lagMinutes) : ""}` : undefined,
        style: { stroke: onPath ? STATUS.critical : driving ? "var(--ink-2)" : "var(--axis)", strokeWidth: onPath ? 2.5 : driving ? 1.6 : 1 },
        animated: false,
        labelStyle: { fontSize: 10, fill: "var(--muted)" },
      });
    }
    for (const g of model.payload.gates) {
      if (!gateIds.includes(g.id)) continue;
      const gp = s.gates[g.id];
      const color = gp?.status === "breached" || gp?.status === "decided_no_go" ? STATUS.critical : gp?.status === "at_risk" ? STATUS.warning : "var(--ink-2)";
      for (const e of g.entryTaskIds) if (set.has(e)) edges.push({ id: `${e}>gate:${g.id}`, source: e, target: `gate:${g.id}`, style: { stroke: color, strokeDasharray: "4 3" } });
      for (const t of g.gatedTaskIds) if (set.has(t)) edges.push({ id: `gate:${g.id}>${t}`, source: `gate:${g.id}`, target: t, style: { stroke: color, strokeDasharray: "4 3" } });
    }
    return { nodes, edges };
  }, [model, shown, selected]);

  const [rfNodes, setNodes, onNodesChange] = useNodesState(nodes);
  const [rfEdges, setEdges, onEdgesChange] = useEdgesState(edges);
  useEffect(() => {
    setNodes(nodes);
    setEdges(edges);
  }, [nodes, edges, setNodes, setEdges]);
  useEffect(() => {
    const t = setTimeout(() => void fitView({ padding: 0.15, duration: 250 }), 30);
    return () => clearTimeout(t);
  }, [shown.length, fitView]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {truncated && (
        <div className="notice" style={{ position: "absolute", top: 8, left: 8, zIndex: 5 }}>
          Showing the first {MAX_NODES} of {visible.length} tasks. Narrow the filters or focus a task's neighborhood.
        </div>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, n) => (n.type === "task" ? onSelect(n.id) : undefined)}
        onNodeDoubleClick={(_, n) => (n.type === "task" ? onFocus(n.id) : undefined)}
        onPaneClick={() => onSelect(null)}
        minZoom={0.05}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} color="var(--grid)" />
        <Controls showInteractive={false} />
        {shown.length > 40 && <MiniMap pannable zoomable nodeColor={(n) => ((n.data as TaskNodeData).critical ? STATUS.critical : ((n.data as TaskNodeData).color ?? "#888"))} />}
      </ReactFlow>
      <div className="small muted" style={{ position: "absolute", bottom: 8, left: 56 }}>
        click: details · double-click: focus neighborhood · <span style={{ color: STATUS.critical }}>■</span> critical path · dashed: assumed recovery · dotted edges: gates
      </div>
    </div>
  );
}

/** useReactFlow (for fitView) requires a provider above the ReactFlow instance. */
export function GraphView(props: Parameters<typeof Inner>[0]) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
