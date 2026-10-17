import type { FastifyRequest } from "fastify";
import type { PrismaClient, UserRole } from "@prisma/client";
import { ForbiddenError, UnauthenticatedError } from "./errors.ts";

export interface Actor {
  id: string;
  role: UserRole;
}

/**
 * Returns the signed-in user's id from a verified session/token, or null.
 * This is the seam where real auth (session cookie, OIDC, etc.) plugs in.
 */
export type ResolveUserId = (request: FastifyRequest) => string | null | Promise<string | null>;

/**
 * DEVELOPMENT/TEST ONLY: trusts an `x-user-id` header. Anyone who can reach
 * the API could impersonate a broker with this, so server.ts refuses to use it
 * unless explicitly enabled.
 */
export const devHeaderResolver: ResolveUserId = (request) => {
  const value = request.headers["x-user-id"];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadActor(prisma: PrismaClient, userId: string | null): Promise<Actor> {
  if (!userId || !UUID.test(userId)) throw new UnauthenticatedError();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isActive: true } });
  if (!user || !user.isActive) throw new UnauthenticatedError();
  return { id: user.id, role: user.role };
}

export function requireRole(actor: Actor, allowed: readonly UserRole[], action: string): void {
  if (!allowed.includes(actor.role)) {
    throw new ForbiddenError(`${action} requires one of: ${allowed.join(", ")}`);
  }
}

/** Only the Broker of Record / managing broker can move trust money. */
export const TRUST_AUTHORIZERS: readonly UserRole[] = ["MANAGING_BROKER"];
export const TRUST_HOLD_FLAGGERS: readonly UserRole[] = ["ADMIN", "MANAGING_BROKER", "FILE_REVIEWER"];
export const TRUST_VIEWERS: readonly UserRole[] = ["ADMIN", "MANAGING_BROKER", "FILE_REVIEWER"];
