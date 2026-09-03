import { useQuery } from "@tanstack/react-query";
import { getAudit } from "../api";
import type { EventModel } from "../lib/model";
import { fmtTime } from "../lib/format";

export function AuditView({ model }: { model: EventModel }) {
  const q = useQuery({ queryKey: ["audit", model.payload.event.id], queryFn: () => getAudit(model.payload.event.id), refetchInterval: model.mode === "live" ? 30_000 : false });
  if (q.isLoading) return <div className="panel muted">Loading audit log…</div>;
  const rows = [...(q.data ?? [])].reverse();
  const label = (entityType: string, entityId: string) => {
    if (entityType === "task") return model.refOf(entityId);
    if (entityType === "gate") return model.payload.gates.find((g) => g.id === entityId)?.name ?? entityId.slice(0, 8);
    return entityId.slice(0, 8);
  };
  return (
    <div className="panel">
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
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="mono small">{fmtTime(Date.parse(a.occurredAt), model.tz)}</td>
              <td className="small">{a.actorId ? (model.userById.get(a.actorId)?.name ?? a.actorId.slice(0, 8)) : <span className="muted">system</span>}</td>
              <td className="mono small">{a.action}</td>
              <td className="small">
                {a.entityType} {label(a.entityType, a.entityId)}
              </td>
              <td className="small muted">{summarize(a.before, a.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summarize(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!after) return "";
  if (!before) {
    const keys = ["name", "ref", "status", "decision", "format", "summary"].filter((k) => k in after);
    return keys.map((k) => `${k}=${short(after[k])}`).join(" ");
  }
  const diffs: string[] = [];
  for (const k of Object.keys(after)) {
    if (k === "updatedAt") continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diffs.push(`${k}: ${short(before[k])} → ${short(after[k])}`);
  }
  return diffs.join("; ");
}
function short(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}
