import { useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getIdentity, me, setIdentity } from "./api";

function IdentityBox() {
  const qc = useQueryClient();
  const [email, setEmail] = useState(getIdentity());
  const who = useQuery({ queryKey: ["me", getIdentity()], queryFn: me, enabled: getIdentity() !== "", retry: false });
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        setIdentity(email.trim());
        void qc.invalidateQueries();
      }}
    >
      <label className="small muted" htmlFor="identity">
        Acting as
      </label>
      <input id="identity" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={{ width: 200 }} />
      <button type="submit">Set</button>
      {who.data ? (
        <span className="small">
          {who.data.name} <span className="badge">{who.data.role}</span>
        </span>
      ) : getIdentity() ? (
        <span className="small error">unknown user</span>
      ) : null}
    </form>
  );
}

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          Cutover
        </Link>
        <span className="muted small">runbook orchestration for M&amp;A data migrations</span>
        <span className="grow" />
        <IdentityBox />
      </header>
      <Outlet />
    </div>
  );
}
