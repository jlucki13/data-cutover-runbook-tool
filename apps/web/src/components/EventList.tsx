import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listEvents } from "../api";
import { fmtTime } from "../lib/format";

export function EventList() {
  const q = useQuery({ queryKey: ["events"], queryFn: listEvents });
  if (q.isLoading) return <div className="panel muted">Loading events…</div>;
  if (q.error) return <div className="panel error">{(q.error as Error).message}. Set your identity above (for the seeded database: jordan@example.com).</div>;
  return (
    <div className="panel">
      <h2 style={{ margin: "4px 0 12px" }}>Events</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Window</th>
            <th>Timezone</th>
          </tr>
        </thead>
        <tbody>
          {q.data!.map((e) => (
            <tr key={e.id}>
              <td>
                <Link to={`/events/${e.id}`}>{e.name}</Link>
              </td>
              <td>
                <span className={`badge ${e.status}`}>{e.status}</span>
              </td>
              <td className="mono">
                {fmtTime(Date.parse(e.windowStart), e.timezone)} → {fmtTime(Date.parse(e.windowEnd), e.timezone)}
              </td>
              <td>{e.timezone}</td>
            </tr>
          ))}
          {q.data!.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No events yet. Seed one with <code>pnpm --filter @cutover/api seed</code>.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
