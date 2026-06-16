import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { query } from "./db";

const TOKEN_TTL_SECONDS = 60 * 60 * 12;
const JWT_SECRET = process.env.JWT_SECRET || "cambiar-esta-clave-en-produccion";

type AuthPayload = {
  sub: string;
  email: string;
  fullName: string;
  role: "SUPERADMIN" | "ADMIN" | "OPERADOR" | "LECTOR";
  exp: number;
};

export type AuthUser = Omit<AuthPayload, "sub" | "exp"> & { id: string };

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string) {
  return crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64url");
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120_000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(candidate));
}

export function createToken(user: AuthUser) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    sub: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  } satisfies AuthPayload));
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign(unsigned)}`;
}

export function verifyToken(token: string): AuthUser | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthPayload;
  if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
  return { id: decoded.sub, email: decoded.email, fullName: decoded.fullName, role: decoded.role };
}

export function tokenFromRequest(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  const token = (request.query as Record<string, unknown> | undefined)?.token;
  return token ? String(token) : null;
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const token = tokenFromRequest(request);
  if (!token) return reply.status(401).send({ message: "Debe iniciar sesión para continuar." });
  const user = verifyToken(token);
  if (!user) return reply.status(401).send({ message: "Sesión vencida o inválida. Inicie sesión nuevamente." });

  const result = await query(
    `SELECT id, email, full_name, role, is_active FROM app_users WHERE id = $1`,
    [user.id],
  );
  const dbUser = result.rows[0];
  if (!dbUser?.is_active) return reply.status(401).send({ message: "Usuario inactivo o inexistente." });
  request.user = {
    id: dbUser.id,
    email: dbUser.email,
    fullName: dbUser.full_name,
    role: dbUser.role,
  };
}

export async function requireRunAccess(runId: string, user: AuthUser) {
  const result = await query(
    `SELECT id, user_id FROM reconciliation_runs WHERE id = $1`,
    [runId],
  );
  const run = result.rows[0];
  if (!run) return false;
  if (["SUPERADMIN", "ADMIN"].includes(String(user.role || "").toUpperCase()) || !run.user_id || run.user_id === user.id) return true;

  try {
    const permissionResult = await query(
      `SELECT bool_or(enabled) AS enabled
       FROM role_permissions
       WHERE role_key = $1 AND permission_key = 'OPEN_RUNS'`,
      [user.role],
    );
    return Boolean(permissionResult.rows[0]?.enabled);
  } catch {
    return false;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}
