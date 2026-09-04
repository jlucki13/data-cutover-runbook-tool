/**
 * Channel rendering. Deterministic text only — an LLM may add a summary elsewhere, but
 * the facts a recipient acts on are rendered here from engine output.
 */
import type { Channel, Notification } from "./types.js";

export interface RenderedMessage {
  channel: Channel;
  subject: string;
  /** Plain text for email; Slack mrkdwn for slack. */
  body: string;
}

const EMOJI: Record<Notification["severity"], string> = { critical: "🔴", warning: "🟠", info: "🔵" };

export interface RenderContext {
  eventName: string;
  /** Absolute link to the task/gate in the web app, when the deployment knows its own URL. */
  link?: string;
  /** Optional plain-language paragraph (may come from an LLM). Never replaces the facts. */
  summary?: string;
}

export function renderEmail(n: Notification, ctx: RenderContext): RenderedMessage {
  const lines = [n.body];
  if (ctx.summary) lines.push("", ctx.summary);
  const facts = Object.entries(n.facts)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `  ${humanKey(k)}: ${formatValue(v)}`);
  if (facts.length > 0) lines.push("", "Details:", ...facts);
  if (ctx.link) lines.push("", ctx.link);
  lines.push("", `— ${ctx.eventName} cutover runbook`);
  return { channel: "email", subject: `[${ctx.eventName}] ${n.title}`, body: lines.join("\n") };
}

export function renderSlack(n: Notification, ctx: RenderContext): RenderedMessage {
  const head = `${EMOJI[n.severity]} *${escapeMrkdwn(n.title)}*`;
  const lines = [head, escapeMrkdwn(n.body)];
  if (ctx.summary) lines.push(`_${escapeMrkdwn(ctx.summary)}_`);
  if (ctx.link) lines.push(`<${ctx.link}|Open in the runbook>`);
  return { channel: "slack", subject: n.title, body: lines.join("\n") };
}

export function render(n: Notification, channel: Channel, ctx: RenderContext): RenderedMessage {
  return channel === "slack" ? renderSlack(n, ctx) : renderEmail(n, ctx);
}

function humanKey(k: string): string {
  return k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "number" && v > 1_000_000_000_000) return new Date(v).toISOString();
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/** Slack mrkdwn needs only these three escaped. */
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
