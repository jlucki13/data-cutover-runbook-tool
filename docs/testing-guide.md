# Testing this yourself

A walkthrough for driving the app by hand: what to click, what should happen, and where
the seams are. It assumes nothing about the codebase.

## Start it

### What you need first

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Node 22+ | `brew install node` | your package manager, or [nodejs.org](https://nodejs.org) | [nodejs.org](https://nodejs.org) |
| pnpm | `corepack enable pnpm` | `corepack enable pnpm` | `corepack enable pnpm` |
| Postgres 16 | Docker Desktop, or `brew install postgresql@16 && brew services start postgresql@16` | Docker, or your distro's `postgresql-16` | run all of this inside WSL2 |

`corepack enable pnpm` ships with Node, so there is nothing to install for it. Docker is
the easiest route to Postgres because the repo brings its own — but any Postgres 16 works
if you point `DATABASE_URL` at it.

On Windows, do this inside WSL2 rather than PowerShell: the launcher is a bash script.

### Then

```sh
git clone https://github.com/jlucki13/data-cutover-runbook-tool.git
cd data-cutover-runbook-tool
git checkout claude/new-session-tbclbz
scripts/dev.sh
```

That installs dependencies, starts Postgres (Docker, or your own at `DATABASE_URL`),
migrates, seeds two demo events, and runs the API and the web app. Then open
**http://localhost:5173**. Ctrl-C stops everything, servers included. Re-running is safe:
the seeds skip work that already exists.

Using your own Postgres instead of Docker:

```sh
createdb cutover
DATABASE_URL=postgres://$(whoami)@localhost:5432/cutover scripts/dev.sh
```

If a port is taken, the script says so before doing any work:
`API_PORT=4001 WEB_PORT=5174 scripts/dev.sh`.

Nothing is sent anywhere: no account, no cloud service, no API key required. The optional
integrations in [`README.md`](../README.md#optional-integrations) are all off by default,
and the app runs entirely on localhost.

### Signing in

There is no password. Type an email in the top bar and you are that person — development
auth is a header (`apps/api/src/auth.ts`), and real auth is deferred by PRD §5. Switching
users is the fastest way to test the role rules:

| Email | Role | Can do |
| --- | --- | --- |
| `jordan@example.com` | admin | everything, plus column configuration |
| `ops@example.com` | builder | build the plan, import worksheets, define gates |
| `cc@example.com` | command_center | decide gates, update any task, dispatch notices |
| `bala@example.com` | task_owner | update only their own tasks |
| `audit@example.com` | auditor | read everything, change nothing |

### The two seeded events

**TRBK Cutover** is in planning, with a window next October. Use it for building: imports,
dependencies, gates, what-ifs against a plan.

**Meridian Rehearsal** is live, with a window that straddles right now — the early tasks
complete, one in flight, and `MIG-STM` blocked with the vendor. Use it for the command
centre: dashboard, notifications, gate decisions, the report. Its times are computed when
you seed it, so if it drifts stale, re-seed a fresh one:

```sh
SEED_LIVE_NAME="Rehearsal 2" pnpm --filter @cutover/api seed:live
```

## What to try

Roughly in order of how much of the product each exercises. The first two are the ones the
PRD says carry the product; spend your time there.

### 1. Ingestion — does it take a real worksheet?

The honest test is your own file. Export a runbook worksheet you actually have (CSV, XLSX,
or MS Project XML), strip anything sensitive, and drop it on **Imports → New import** on
the TRBK event. There are also purpose-built samples in
[`docs/sample-imports/`](./sample-imports/), each with its expected result written down.

What to judge:

- Did it find your columns without being told? Header names vary wildly and the parser
  guesses; where it guessed wrong, that is a finding.
- Did `Depends on` cells parse — comma lists, `FS+30`, hyphenated refs like `ACC-1`?
- Are the durations right? `2h 30m`, `1.5h`, `90`, `30 min` should all land as minutes.
- Nothing reaches the graph until you press commit. Check that: upload, look at the graph,
  confirm it is unchanged, then commit.
- Re-import a changed copy of the same sheet. You should get *changes*, not duplicates,
  each showing old → new.

Free-text parsing (paste handover notes rather than a file) needs `ANTHROPIC_API_KEY` set
before you start the app. Every dependency the model proposes carries a confidence and a
verbatim quote, and nothing below 0.9 is accepted for you — that human review step is
mandatory by design, so try to talk it into a bad dependency and check you can still see
and reject it.

### 2. Impact simulation — is the answer right, and is it fast?

On **Simulate**, add a delay to `MIG-STM` and watch the numbers. Then check them:

- Pick a task and add up its chain by hand. The projected finish should match to the minute.
- The engine runs in your browser, so the answer should appear as you type, not after a
  round trip. If it ever feels slow, that is worth reporting.
- Run the same scenario twice, and in a different order. Same answer every time — the
  engine has no clock and no randomness inside it.
- Push it far enough to breach the window and watch the gate statuses and the critical
  path change. The critical path should *move* when the slack runs out somewhere else.

Nothing you do here touches the plan unless you save the scenario. Confirm that: simulate,
then open the Graph or the Dashboard and see the real plan untouched.

### 3. Live mode — the command centre

On Meridian Rehearsal:

1. **Dashboard** first. It always shows reality, never a what-if. If a scenario is open it
   says so in a banner rather than blending the two.
2. Open `MIG-STM` and change its expected unblock time. Everything downstream should move,
   and the gate slack should change with it.
3. Mark something complete early. Float should come back and notices should stop.
4. **Decide a gate** as `cc@example.com`. A no-go should visibly *hold* the work behind it,
   not just colour it red.
5. Sign in as `bala@example.com` and try to update someone else's task. It should be
   refused — the API decides that, not the interface.

### 4. Notifications

The outbox is on the Dashboard. Notices are queued, then dispatched when you press
**Send pending**; with no Slack or SMTP configured they deliver to the API's log, so watch
the terminal.

- Change something, then press **Re-check** twice. The second time should enqueue nothing:
  an unchanged situation does not page anyone twice.
- Make a situation *worse* and re-check. That should produce a new notice.
- Note that a planning event is silent by design. Blocking a task on TRBK audits and
  recomputes but pages nobody, because nothing has started.

### 5. Report and audit

**Report** covers the whole event: planned versus actual per task, every gate decision with
who made it, and the audit trail. Export the CSVs and open them in Excel. Print to PDF from
the browser — the app chrome drops out.

The audit log is append-only, enforced by a database trigger rather than by application
code. If you have psql handy, try `update audit_log_entry set action = 'x';` and watch it
be refused.

### 6. Scale

The seeded events are small enough to read. If you want to see it at real size, the engine
is benchmarked at 15,000 tasks (build 462ms, schedule 201ms, simulate and diff 551ms).
Generating a runbook that size to click through is not wired up as a script — ask if you
want one.

## Where the seams are

Things you will notice, that are known rather than broken:

- **No real auth.** Type an email, be that person. PRD §5 defers it.
- **A planning event never notifies.** Deliberate, but if you expected a nudge while
  building the plan, say so.
- **Imports read fields, not columns.** A re-imported sheet that omits a column proposes
  clearing that field rather than leaving it alone — see the note in
  [`docs/sample-imports/`](./sample-imports/README.md). It shows up in review, but the
  default is to accept proposals.
- **The prose parser has never been evaluated.** There has been no Anthropic key in the
  build environment, so `pnpm --filter @cutover/ingest eval:prose` has not run. Treat
  free-text parsing as unproven until it does.
- **Negative float notifies per task.** One upstream slip can queue a notice for every
  downstream owner. Fine at demo size; worth judging at 15,000 tasks.

## If something breaks

Both servers log to the terminal you started them in: the API prints the failing request
and its error, and the browser console carries the interface side. Both are useful in a bug
report, along with which event and which user you were.

`scripts/smoke.sh` (the automated browser check) drives the same seeded data and leaves it
changed — TRBK live, with a blocked task. Re-seed a clean database if you want the starting
state back.

To start over from an empty database:

```sh
docker compose down -v && scripts/dev.sh
```
