import dagre from "@dagrejs/dagre";

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}
export interface LayoutEdge {
  source: string;
  target: string;
}

/** Layered left-to-right layout. Deterministic for a given node/edge order. */
export function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], opts: { rankdir?: "LR" | "TB"; ranksep?: number; nodesep?: number } = {}): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: opts.rankdir ?? "LR", ranksep: opts.ranksep ?? 70, nodesep: opts.nodesep ?? 24, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) if (ids.has(e.source) && ids.has(e.target) && e.source !== e.target) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p) out.set(n.id, { x: p.x - n.width / 2, y: p.y - n.height / 2 });
  }
  return out;
}
