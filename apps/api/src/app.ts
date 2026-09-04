import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { serializerCompiler, validatorCompiler, hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import type { Db } from "@cutover/db";
import type { LlmClient } from "@cutover/ingest";
import type { Channels } from "./services/notifications.js";
import { resolveUser } from "./auth.js";
import { HttpError } from "./errors.js";
import { registerRoutes } from "./routes.js";

export interface AppOptions {
  db: Db;
  llm?: LlmClient;
  /** Notification delivery channels; defaults to whatever the environment configures. */
  channels?: Channels;
  /** Public base URL for deep links in notifications. */
  baseUrl?: string;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 50 * 1024 * 1024 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cors, { origin: true });

  app.addHook("onRequest", async (req) => {
    req.user = await resolveUser(opts.db, req);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.message, details: err.details ?? undefined });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: "validation failed", details: err.validation });
    }
    // Postgres unique / foreign-key / check violations are client errors, not crashes.
    const pgCode = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (pgCode === "23505") return reply.code(409).send({ error: "already exists", details: (err as { detail?: string }).detail ?? (err as { cause?: { detail?: string } }).cause?.detail });
    if (pgCode === "23503" || pgCode === "23514") return reply.code(400).send({ error: "constraint violated", details: (err as { detail?: string }).detail ?? (err as { cause?: { detail?: string } }).cause?.detail });
    const status = typeof (err as { statusCode?: number }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? "internal error" : (err as Error).message });
  });

  await registerRoutes(app, { db: opts.db, llm: opts.llm, channels: opts.channels, baseUrl: opts.baseUrl });
  return app;
}
