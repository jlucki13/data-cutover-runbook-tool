/**
 * @cutover/notify — deterministic notification rules and message rendering.
 * Pure: no I/O, no clock, no delivery. Delivery lives in the API.
 */
export const NOTIFY_VERSION = "0.1.0";
export * from "./types.js";
export { evaluateNotifications, newNotifications, fmtMinutes, fmtTime } from "./rules.js";
export { render, renderEmail, renderSlack, type RenderedMessage, type RenderContext } from "./render.js";
