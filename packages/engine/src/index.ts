/**
 * @cutover/engine — deterministic CPM / impact-propagation engine.
 *
 * Pure module: no I/O, no clock, no dependencies. See types.ts for the contract.
 */
export const ENGINE_VERSION = "0.1.0";

export * from "./types.js";
export { buildGraph, validateGraph } from "./graph.js";
export { computeSchedule, timingOf } from "./cpm.js";
export { applyChanges, simulateChanges, diffSchedules, ChangeError } from "./simulate.js";
export { downstreamOf, upstreamOf, neighborhood, topologicalOrder, sources, sinks } from "./topology.js";
export { diffGraphInputs, toRefDependencies, type DiffOptions } from "./merge.js";
export { compareRef, minutesToMs, msToMinutes, MINUTE_MS } from "./util.js";
