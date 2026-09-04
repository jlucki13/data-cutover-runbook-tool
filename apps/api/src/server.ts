import { createDb } from "@cutover/db";
import { createAnthropicLlmClient } from "@cutover/ingest";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 4000);
const db = createDb();
// The prose parser is optional: enable it when credentials are present.
const llm = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? createAnthropicLlmClient() : undefined;

const app = await buildApp({ db, llm, logger: true, ...(process.env.PUBLIC_BASE_URL ? { baseUrl: process.env.PUBLIC_BASE_URL } : {}) });
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`prose import ${llm ? "enabled" : "disabled (no Anthropic credentials)"}`);
