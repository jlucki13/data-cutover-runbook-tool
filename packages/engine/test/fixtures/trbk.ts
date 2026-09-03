/**
 * TRBK-style mock cutover event: freeze → migrate (per workstream) → reconcile →
 * go/no-go gate (point of no return) → switch → rollback-eligible window → close.
 *
 * Times are minutes after T0 (Friday 22:00 UTC). Window: 32 hours.
 * Shared by the engine tests and, later, the database seed.
 */
import { at, dep, gate, input, task } from "../helpers.js";
import type { GraphInput } from "../../src/index.js";

export const OWNERS = {
  ops: "u-ops",
  accounts: "u-accounts",
  balances: "u-balances",
  statements: "u-statements",
  notices: "u-notices",
  recon: "u-recon",
} as const;

export const WS = { core: "ws-core", accounts: "ws-accounts", balances: "ws-balances", statements: "ws-statements", notices: "ws-notices", recon: "ws-recon" } as const;

export function trbkEvent(): GraphInput {
  return input(
    [
      task("FRZ-1", 30, { name: "Declare freeze on source system", ownerId: OWNERS.ops, workstreamId: WS.core, plannedStart: at(0) }),
      task("FRZ-2", 120, { name: "Final source extract", ownerId: OWNERS.ops, workstreamId: WS.core }),
      task("MIG-ACC", 180, { name: "Migrate accounts", ownerId: OWNERS.accounts, workstreamId: WS.accounts }),
      task("MIG-BAL", 150, { name: "Migrate balances", ownerId: OWNERS.balances, workstreamId: WS.balances }),
      task("MIG-STM", 240, { name: "Migrate statements", ownerId: OWNERS.statements, workstreamId: WS.statements }),
      task("MIG-NOT", 90, { name: "Generate customer notices", ownerId: OWNERS.notices, workstreamId: WS.notices }),
      task("REC-ACC", 60, { name: "Reconcile accounts", ownerId: OWNERS.recon, workstreamId: WS.recon }),
      task("REC-BAL", 90, { name: "Reconcile balances", ownerId: OWNERS.recon, workstreamId: WS.recon, windowDeadline: at(14 * 60) }),
      task("REC-STM", 60, { name: "Reconcile statements", ownerId: OWNERS.recon, workstreamId: WS.recon }),
      task("SWI-1", 60, { name: "Switch routing to target platform", ownerId: OWNERS.ops, workstreamId: WS.core }),
      task("SWI-2", 45, { name: "Smoke test target platform", ownerId: OWNERS.ops, workstreamId: WS.core }),
      task("RBK-1", 240, { name: "Rollback-eligible window monitoring", ownerId: OWNERS.ops, workstreamId: WS.core }),
      task("CLS-1", 30, { name: "Close event and release comms", ownerId: OWNERS.ops, workstreamId: WS.core }),
    ],
    [
      dep("FRZ-1", "FRZ-2"),
      dep("FRZ-2", "MIG-ACC"),
      dep("MIG-ACC", "MIG-BAL"),
      dep("MIG-ACC", "MIG-STM"),
      dep("MIG-BAL", "MIG-NOT"),
      dep("MIG-STM", "MIG-NOT"),
      dep("MIG-ACC", "REC-ACC"),
      dep("MIG-BAL", "REC-BAL"),
      dep("MIG-STM", "REC-STM"),
      dep("SWI-1", "SWI-2"),
      dep("SWI-2", "RBK-1"),
    ],
    [
      gate("G1", ["REC-ACC", "REC-BAL", "REC-STM", "MIG-NOT"], ["SWI-1"], {
        name: "Go/No-Go: switch to target",
        targetDecisionAt: at(16 * 60),
        isPointOfNoReturn: true,
      }),
      gate("G2", ["RBK-1"], ["CLS-1"], { name: "Rollback window closed", targetDecisionAt: at(24 * 60) }),
    ],
    { windowStart: at(0), windowEnd: at(32 * 60), defaultBlockedRecoveryMinutes: 30 },
  );
}
