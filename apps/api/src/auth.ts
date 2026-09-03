/**
 * Development auth: the caller identifies itself with `x-user-id` (a UUID from app_user)
 * or `x-user-email`. There is no password or token yet — PRD §5 defers real auth beyond
 * basic RBAC, and Jordan confirmed a single org. Swap `resolveUser` for a session/JWT
 * lookup when that lands; the role checks below stay the same.
 *
 * Roles: admin (everything, incl. column config and users), builder (plan, import,
 * commit, gates), command_center (gate decisions, live updates), task_owner (own task
 * status), auditor (read only).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { appUser, type Db } from "@cutover/db";
import { forbidden, unauthorized } from "./errors.js";

export type Role = "admin" | "builder" | "task_owner" | "command_center" | "auditor";
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function resolveUser(db: Db, req: FastifyRequest): Promise<AuthUser | undefined> {
  const id = header(req, "x-user-id");
  const email = header(req, "x-user-email");
  if (!id && !email) return undefined;
  const rows = id
    ? await db.select().from(appUser).where(eq(appUser.id, id)).limit(1)
    : await db
        .select()
        .from(appUser)
        .where(sql`lower(${appUser.email}) = lower(${email!})`)
        .limit(1);
  const u = rows[0];
  if (!u || !u.isActive) return undefined;
  return { id: u.id, name: u.name, email: u.email, role: u.role as Role };
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() !== "" ? s.trim() : undefined;
}

/** Route guard. Admin passes every check. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw unauthorized("set x-user-id or x-user-email");
    if (req.user.role === "admin" || roles.length === 0 || roles.includes(req.user.role)) return;
    throw forbidden(`requires role ${roles.join(" or ")}`);
  };
}

export const requireAuth = requireRole();
