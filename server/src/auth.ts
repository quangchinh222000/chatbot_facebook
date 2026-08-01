import type { FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { config, isProduction } from "./config.js";
import { query } from "./db.js";
import type { SessionUser } from "./types.js";

const secret = new TextEncoder().encode(config.SESSION_SECRET);
export const SESSION_COOKIE = "tm_session";

export async function createSession(user: SessionUser) {
  return new SignJWT({
    org: user.organizationId,
    email: user.email,
    name: user.displayName,
    permissions: user.permissions,
    roles: user.roles
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret);
}

export async function parseSession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.org !== "string") return null;
    return {
      id: payload.sub,
      organizationId: payload.org,
      email: String(payload.email ?? ""),
      displayName: String(payload.name ?? ""),
      permissions: Array.isArray(payload.permissions) ? payload.permissions.map(String) : [],
      roles: Array.isArray(payload.roles) ? payload.roles.map(String) : []
    };
  } catch {
    return null;
  }
}

export async function authenticateRequest(request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  request.user = token ? await parseSession(token) : null;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: 60 * 60 * 12
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function loginWithPassword(email: string, password: string): Promise<SessionUser | null> {
  const result = await query<{
    id: string;
    organization_id: string;
    email: string;
    display_name: string;
    permissions: unknown;
    roles: unknown;
  }>(
    `SELECT u.id, u.organization_id, u.email::text, u.display_name,
            COALESCE(jsonb_agg(DISTINCT permission.value) FILTER (WHERE permission.value IS NOT NULL), '[]'::jsonb) AS permissions,
            COALESCE(jsonb_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '[]'::jsonb) AS roles
     FROM iam.users u
     LEFT JOIN iam.user_roles ur ON ur.user_id = u.id
     LEFT JOIN iam.roles r ON r.id = ur.role_id
     LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(r.permissions, '[]'::jsonb)) AS permission(value) ON true
     WHERE u.email = $1 AND u.status = 'active' AND u.password_hash = crypt($2, u.password_hash)
     GROUP BY u.id`,
    [email, password]
  );
  const row = result.rows[0];
  if (!row) return null;
  await query("UPDATE iam.users SET last_login_at = now() WHERE id = $1", [row.id]);
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    displayName: row.display_name,
    permissions: Array.isArray(row.permissions) ? row.permissions.map(String) : [],
    roles: Array.isArray(row.roles) ? row.roles.map(String) : []
  };
}

export function requirePermission(request: FastifyRequest, permission?: string) {
  if (!request.user) {
    const error = new Error("Sign in to continue.") as Error & { statusCode?: number; code?: string };
    error.statusCode = 401;
    error.code = "UNAUTHENTICATED";
    throw error;
  }
  if (permission && !request.user.permissions.includes(permission)) {
    const error = new Error(`Permission required: ${permission}`) as Error & { statusCode?: number; code?: string };
    error.statusCode = 403;
    error.code = "FORBIDDEN";
    throw error;
  }
  return request.user;
}
