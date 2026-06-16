import crypto from "node:crypto";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import dotenv from "dotenv";
import Fastify from "fastify";
import { pool, query } from "./db";
import { authenticate, createToken, hashPassword, requireRunAccess, verifyPassword } from "./auth";
import { buildExcelBuffer, labelColumn, processBuffers, visibleColumnsByMenu, type JoinedRow, type MenuKey } from "./reconciliationEngine";

dotenv.config();

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 * 200 });
const port = Number(process.env.API_PORT ?? 4108);
const VALID_MENUS: MenuKey[] = ["entrada1", "bordereaux", "conciliacionTC", "archivoCompleto"];

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5178",
  "http://127.0.0.1:5178",
  "http://localhost:4178",
  "http://127.0.0.1:4178",
];

function parseCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || "";
  const configured = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_CORS_ORIGINS;
}

const allowedCorsOrigins = parseCorsOrigins();

await app.register(cors, {
  origin: (origin, callback) => {
    // Permite llamadas server-to-server, curl y Postman que no envían Origin.
    if (!origin) return callback(null, true);

    if (allowedCorsOrigins.includes(origin)) return callback(null, true);

    return callback(new Error(`Origen CORS no permitido: ${origin}`), false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["Content-Disposition"],
  credentials: false,
  maxAge: 86400,
});

app.addHook("onRequest", async (request, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  reply.header("Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");

  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").toLowerCase();
  if (process.env.ENABLE_HSTS === "true" || forwardedProto === "https") {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
});

await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 150, files: 3 } });

app.addHook("preHandler", async (request, reply) => {
  const path = request.url.split("?")[0];
  if (path === "/api/health" || path === "/api/auth/login") return;
  if (path.startsWith("/api/")) return authenticate(request, reply);
});

app.post("/api/auth/login", async (request, reply) => {
  const body = request.body as { email?: string; password?: string };
  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");

  if (!email || !password) {
    return reply.status(400).send({ message: "Ingrese usuario y contraseña." });
  }

  const result = await query(
    `SELECT id, email, full_name, password_hash, role, is_active
     FROM app_users
     WHERE email = $1`,
    [email],
  );
  const user = result.rows[0];
  if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
    return reply.status(401).send({ message: "Usuario o contraseña incorrectos." });
  }

  const sessionUser = await mapSessionUser(user);
  return { token: createToken(sessionUser), user: sessionUser };
});

app.get("/api/auth/me", async (request) => {
  const result = await query(
    `SELECT id, email, full_name, role, is_active
     FROM app_users
     WHERE id = $1`,
    [request.user?.id],
  );
  const user = result.rows[0];
  if (!user?.is_active) return { user: request.user };
  return { user: await mapSessionUser(user) };
});


type UserRole = "SUPERADMIN" | "ADMIN" | "OPERADOR" | "LECTOR";
const VALID_USER_ROLES = new Set<UserRole>(["SUPERADMIN", "ADMIN", "OPERADOR", "LECTOR"]);
const SYSTEM_ROLES: Array<{ key: UserRole; label: string; description: string; locked?: boolean }> = [
  { key: "SUPERADMIN", label: "Superadministrador", description: "Rol superior. Acceso total, gestión de administradores y edición del archivo unificado.", locked: true },
  { key: "ADMIN", label: "Administrador", description: "Administración general del sistema. No puede modificar al SUPERADMIN ni editar archivo unificado salvo permiso superior.", locked: true },
  { key: "OPERADOR", label: "Operador", description: "Rol operativo para procesar y consultar conciliaciones." },
  { key: "LECTOR", label: "Lector", description: "Rol de consulta sin operación crítica." },
];

function isSuperAdminUser(user: any): boolean {
  return String(user?.role || "").toUpperCase() === "SUPERADMIN";
}

function visibleSystemRolesFor(user: any) {
  return isSuperAdminUser(user) ? SYSTEM_ROLES : SYSTEM_ROLES.filter((role) => role.key !== "SUPERADMIN");
}

const PERMISSION_CATALOG = [
  { key: "PROCESS_DOCUMENTS", label: "Procesar documentos", description: "Permite cargar Excel y generar expedientes de conciliación.", category: "Conciliación", sortOrder: 10 },
  { key: "OPEN_RUNS", label: "Abrir expedientes", description: "Permite abrir conciliaciones guardadas.", category: "Conciliación", sortOrder: 20 },
  { key: "EXPORT_EXCEL", label: "Exportar Excel", description: "Permite exportar archivos conciliados con filtros.", category: "Conciliación", sortOrder: 30 },
  { key: "VIEW_EXPEDIENTE", label: "Ver expediente", description: "Permite ver el archivo unificado completo y notas.", category: "Vistas", sortOrder: 40 },
  { key: "EDIT_UNIFIED_FILE", label: "Editar archivo unificado", description: "Permite editar filas del archivo unificado desde Expediente de conciliación.", category: "Vistas", sortOrder: 45 },
  { key: "VIEW_ENTRADA_UNO", label: "Ver Conciliación Entrada UNO", description: "Permite ver gráficos, tablas y resumen de Provincia por establecimiento.", category: "Vistas", sortOrder: 50 },
  { key: "VIEW_PRICE_CALCULATOR", label: "Ver Calculadora de Precios", description: "Permite acceder a la calculadora directa e inversa de tickets.", category: "Vistas", sortOrder: 60 },
  { key: "VIEW_AUDIT", label: "Ver Auditoría", description: "Permite ver la tabla de operaciones pagadas por establecimiento.", category: "Auditoría", sortOrder: 70 },
  { key: "MODIFY_ROW_STATUS", label: "Modificar estado de registros", description: "Permite modificar Estado, revisión y observaciones de filas.", category: "Auditoría", sortOrder: 80 },
  { key: "MANAGE_USERS", label: "Administrar usuarios", description: "Permite crear, editar, activar, desactivar usuarios y cambiar contraseñas.", category: "Administración", sortOrder: 90 },
  { key: "MANAGE_ROLES", label: "Administrar roles", description: "Permite ampliar o quitar permisos por rol.", category: "Administración", sortOrder: 100 },
  { key: "VIEW_USER_AUDIT", label: "Ver auditoría de usuarios", description: "Permite consultar movimientos administrativos de usuarios y roles.", category: "Administración", sortOrder: 110 },
] as const;

const CANONICAL_PERMISSION_KEYS: Set<string> = new Set(PERMISSION_CATALOG.map((permission) => permission.key));

type SessionUserWithPermissions = {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  permissions: Record<string, boolean>;
};

async function getRolePermissionMap(role: string): Promise<Record<string, boolean>> {
  const normalizedRole = String(role || "").trim().toUpperCase();
  const defaults: Record<string, boolean> = {};
  for (const permission of PERMISSION_CATALOG) {
    defaults[permission.key] = normalizedRole === "SUPERADMIN" || (normalizedRole === "ADMIN" && permission.key !== "EDIT_UNIFIED_FILE");
  }

  if (normalizedRole === "SUPERADMIN" || normalizedRole === "ADMIN") return defaults;

  try {
    const result = await query(
      `SELECT permission_key, bool_or(enabled) AS enabled
       FROM role_permissions
       WHERE role_key = $1
       GROUP BY permission_key`,
      [normalizedRole],
    );
    for (const row of result.rows) {
      const key = String(row.permission_key);
      if (CANONICAL_PERMISSION_KEYS.has(key)) defaults[key] = Boolean(row.enabled);
    }
  } catch (error) {
    // Si todavía no se inicializaron las tablas de roles, el sistema no debe romper.
    // ADMIN mantiene acceso total; el resto queda sin permisos hasta ejecutar npm run db:init.
    console.error("No se pudieron cargar permisos del rol:", error);
  }

  return defaults;
}

async function mapSessionUser(row: any): Promise<SessionUserWithPermissions> {
  const role = String(row.role || "LECTOR").toUpperCase() as UserRole;
  return {
    id: String(row.id),
    email: String(row.email),
    fullName: String(row.full_name ?? row.fullName ?? ""),
    role,
    permissions: await getRolePermissionMap(role),
  };
}

function roleHasPermission(user: any, permissions: Record<string, boolean>, permissionKey: string): boolean {
  return String(user?.role || "").toUpperCase() === "SUPERADMIN" || Boolean(permissions[permissionKey]);
}

async function currentUserPermissions(request: any): Promise<Record<string, boolean>> {
  return getRolePermissionMap(String(request.user?.role || ""));
}

async function requireAnyAdminAccess(request: any, reply: any) {
  const permissions = await currentUserPermissions(request);
  if (!roleHasPermission(request.user, permissions, "MANAGE_USERS") && !roleHasPermission(request.user, permissions, "MANAGE_ROLES")) {
    reply.status(403).send({ message: "No tiene permisos para administrar usuarios y roles." });
    return false;
  }
  return true;
}

async function requireUsersAccess(request: any, reply: any) {
  const permissions = await currentUserPermissions(request);
  if (!roleHasPermission(request.user, permissions, "MANAGE_USERS")) {
    reply.status(403).send({ message: "No tiene permisos para administrar usuarios." });
    return false;
  }
  return true;
}

async function requireRolesAccess(request: any, reply: any) {
  const permissions = await currentUserPermissions(request);
  if (!roleHasPermission(request.user, permissions, "MANAGE_ROLES")) {
    reply.status(403).send({ message: "No tiene permisos para administrar roles." });
    return false;
  }
  return true;
}

async function requireEditUnifiedFileAccess(request: any, reply: any) {
  const permissions = await currentUserPermissions(request);
  if (!roleHasPermission(request.user, permissions, "EDIT_UNIFIED_FILE")) {
    reply.status(403).send({ message: "No tiene permisos para editar el archivo unificado." });
    return false;
  }
  return true;
}

function requireAdmin(request: any, reply: any) {
  if (!["SUPERADMIN", "ADMIN"].includes(String(request.user?.role || "").toUpperCase())) {
    reply.status(403).send({ message: "Solo un usuario ADMIN puede administrar usuarios y roles." });
    return false;
  }
  return true;
}

function mapManagedUser(row: any) {
  return {
    id: String(row.id),
    createdAt: row.created_at,
    email: String(row.email),
    fullName: String(row.full_name),
    role: String(row.role) as UserRole,
    isActive: Boolean(row.is_active),
  };
}

function sanitizeUserPayload(body: any) {
  const email = String(body?.email ?? "").trim().toLowerCase();
  const fullName = String(body?.fullName ?? body?.full_name ?? "").trim();
  const role = String(body?.role ?? "OPERADOR").trim().toUpperCase() as UserRole;
  const isActive = body?.isActive === undefined ? true : Boolean(body.isActive);
  return { email, fullName, role, isActive };
}

async function auditUserChange(params: {
  targetUserId?: string | null;
  adminUserId?: string | null;
  action: string;
  previousValue?: unknown;
  newValue?: unknown;
  observation?: string;
}) {
  try {
    await query(
      `INSERT INTO user_audit_logs (target_user_id, admin_user_id, action, previous_value, new_value, observation)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [
        params.targetUserId || null,
        params.adminUserId || null,
        params.action,
        JSON.stringify(params.previousValue ?? null),
        JSON.stringify(params.newValue ?? null),
        params.observation || null,
      ],
    );
  } catch (error) {
    // La auditoría no debe bloquear altas, edición de usuarios, contraseñas ni permisos.
    // Si falta la tabla/columna, ejecutar npm run db:init con el database.sql actualizado.
    console.error("No se pudo registrar auditoría de usuarios:", error);
  }
}

app.get("/api/users", async (request, reply) => {
  if (!(await requireUsersAccess(request, reply))) return;

  const canSeeSuperAdmin = isSuperAdminUser(request.user);
  const result = await query(
    `SELECT id, created_at, email, full_name, role, is_active
     FROM app_users
     WHERE ($1::boolean = TRUE OR UPPER(role) <> 'SUPERADMIN')
     ORDER BY created_at DESC, email ASC`,
    [canSeeSuperAdmin],
  );
  return { users: result.rows.map(mapManagedUser) };
});

app.post("/api/users", async (request, reply) => {
  if (!(await requireUsersAccess(request, reply))) return;
  const body = request.body as any;
  const { email, fullName, role, isActive } = sanitizeUserPayload(body);
  const password = String(body?.password ?? "");

  if (!email || !email.includes("@")) return reply.status(400).send({ message: "Ingrese un email válido." });
  if (!fullName) return reply.status(400).send({ message: "Ingrese nombre y apellido." });
  if (!VALID_USER_ROLES.has(role)) return reply.status(400).send({ message: "Rol inválido." });
  if (role === "SUPERADMIN" && String(request.user?.role || "").toUpperCase() !== "SUPERADMIN") {
    return reply.status(403).send({ message: "Solo un SUPERADMIN puede crear usuarios SUPERADMIN." });
  }
  if (password.length < 8) return reply.status(400).send({ message: "La contraseña debe tener al menos 8 caracteres." });

  const id = crypto.randomUUID();
  try {
    await query(
      `INSERT INTO app_users (id, email, full_name, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, email, fullName, hashPassword(password), role, isActive],
    );
  } catch (error: any) {
    if (error?.code === "23505") return reply.status(409).send({ message: "Ya existe un usuario con ese email." });
    throw error;
  }

  await auditUserChange({
    targetUserId: id,
    adminUserId: request.user?.id,
    action: "CREATE_USER",
    newValue: { email, fullName, role, isActive },
  });

  const created = await query(`SELECT id, created_at, email, full_name, role, is_active FROM app_users WHERE id = $1`, [id]);
  return reply.status(201).send({ user: mapManagedUser(created.rows[0]) });
});

app.patch("/api/users/:userId", async (request, reply) => {
  if (!(await requireUsersAccess(request, reply))) return;
  const { userId } = request.params as { userId: string };
  const body = request.body as any;
  const currentResult = await query(`SELECT id, email, full_name, role, is_active FROM app_users WHERE id = $1`, [userId]);
  if (!currentResult.rowCount) return reply.status(404).send({ message: "Usuario no encontrado." });
  const current = currentResult.rows[0];

  const email = body?.email === undefined ? String(current.email) : String(body.email).trim().toLowerCase();
  const fullName = body?.fullName === undefined ? String(current.full_name) : String(body.fullName).trim();
  const role = (body?.role === undefined ? String(current.role) : String(body.role).trim().toUpperCase()) as UserRole;
  const isActive = body?.isActive === undefined ? Boolean(current.is_active) : Boolean(body.isActive);

  if (!email || !email.includes("@")) return reply.status(400).send({ message: "Ingrese un email válido." });
  if (!fullName) return reply.status(400).send({ message: "Ingrese nombre y apellido." });
  if (!VALID_USER_ROLES.has(role)) return reply.status(400).send({ message: "Rol inválido." });
  const currentRole = String(current.role || "").toUpperCase();
  const actorRole = String(request.user?.role || "").toUpperCase();
  if ((currentRole === "SUPERADMIN" || role === "SUPERADMIN") && actorRole !== "SUPERADMIN") {
    return reply.status(403).send({ message: "Solo un SUPERADMIN puede modificar o asignar el rol SUPERADMIN." });
  }
  if (userId === request.user?.id && !isActive) return reply.status(400).send({ message: "No puede desactivar su propio usuario." });
  if (userId === request.user?.id && role !== currentRole) return reply.status(400).send({ message: "No puede cambiar su propio rol." });

  try {
    await query(
      `UPDATE app_users
       SET email = $2, full_name = $3, role = $4, is_active = $5
       WHERE id = $1`,
      [userId, email, fullName, role, isActive],
    );
  } catch (error: any) {
    if (error?.code === "23505") return reply.status(409).send({ message: "Ya existe un usuario con ese email." });
    throw error;
  }

  await auditUserChange({
    targetUserId: userId,
    adminUserId: request.user?.id,
    action: "UPDATE_USER",
    previousValue: { email: current.email, fullName: current.full_name, role: current.role, isActive: current.is_active },
    newValue: { email, fullName, role, isActive },
  });

  const updated = await query(`SELECT id, created_at, email, full_name, role, is_active FROM app_users WHERE id = $1`, [userId]);
  return { user: mapManagedUser(updated.rows[0]) };
});

app.patch("/api/users/:userId/password", async (request, reply) => {
  if (!(await requireUsersAccess(request, reply))) return;

  const { userId } = request.params as { userId: string };
  const body = request.body as any;

  const password = String(
    body?.password ??
    body?.newPassword ??
    body?.new_password ??
    body?.plainPassword ??
    "",
  );

  if (password.length < 8) {
    return reply.status(400).send({ message: "La contraseña debe tener al menos 8 caracteres." });
  }

  try {
    const currentResult = await query(
      `SELECT id, email, full_name, role, is_active
       FROM app_users
       WHERE id = $1`,
      [userId],
    );

    if (!currentResult.rowCount) {
      return reply.status(404).send({ message: "Usuario no encontrado." });
    }

    if (String(currentResult.rows[0].role || "").toUpperCase() === "SUPERADMIN" && String(request.user?.role || "").toUpperCase() !== "SUPERADMIN") {
      return reply.status(403).send({ message: "Solo un SUPERADMIN puede cambiar la contraseña de otro SUPERADMIN." });
    }

    const passwordHash = hashPassword(password);

    const updatedResult = await query(
      `UPDATE app_users
       SET password_hash = $2
       WHERE id = $1
       RETURNING id, created_at, email, full_name, role, is_active, password_hash`,
      [userId, passwordHash],
    );

    const updatedUser = updatedResult.rows[0];

    if (!updatedResult.rowCount || !updatedUser) {
      return reply.status(500).send({ message: "No se pudo guardar la nueva contraseña." });
    }

    if (!verifyPassword(password, updatedUser.password_hash)) {
      return reply.status(500).send({ message: "La contraseña se guardó, pero no pudo validarse contra el hash generado." });
    }

    // La auditoría no debe bloquear el cambio de contraseña.
    await auditUserChange({
      targetUserId: userId,
      adminUserId: request.user?.id,
      action: "CHANGE_PASSWORD",
      previousValue: { email: currentResult.rows[0].email },
      newValue: { passwordChanged: true, email: currentResult.rows[0].email },
    });

    return reply.send({
      ok: true,
      user: mapManagedUser(updatedUser),
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      message: error instanceof Error ? error.message : "No se pudo cambiar la contraseña.",
    });
  }
});

app.get("/api/users/audit", async (request, reply) => {
  const permissions = await currentUserPermissions(request);
  if (!roleHasPermission(request.user, permissions, "VIEW_USER_AUDIT")) return reply.status(403).send({ message: "No tiene permisos para ver auditoría de usuarios." });

  try {
    const canSeeSuperAdmin = isSuperAdminUser(request.user);
    const result = await query(
      `SELECT l.id, l.target_user_id, target.email AS target_email, l.admin_user_id, admin.email AS admin_email,
              l.created_at, l.action, l.previous_value, l.new_value, l.observation
       FROM user_audit_logs l
       LEFT JOIN app_users target ON target.id = l.target_user_id
       LEFT JOIN app_users admin ON admin.id = l.admin_user_id
       WHERE ($1::boolean = TRUE OR (COALESCE(UPPER(target.role), '') <> 'SUPERADMIN' AND COALESCE(UPPER(admin.role), '') <> 'SUPERADMIN'))
       ORDER BY l.created_at DESC
       LIMIT 200`,
      [canSeeSuperAdmin],
    );
    return {
      logs: result.rows.map((row) => ({
        id: String(row.id),
        targetUserId: row.target_user_id,
        targetEmail: row.target_email,
        adminUserId: row.admin_user_id,
        adminEmail: row.admin_email,
        createdAt: row.created_at,
        action: row.action,
        previousValue: row.previous_value,
        newValue: row.new_value,
        observation: row.observation,
      })),
    };
  } catch (error) {
    request.log.error(error);
    // No romper Usuarios y roles si la auditoría todavía no fue inicializada.
    return { logs: [] };
  }
});


app.get("/api/roles", async (request, reply) => {
  if (!(await requireRolesAccess(request, reply))) return;

  const rolePermissionsResult = await query(
    `SELECT role_key, permission_key, bool_or(enabled) AS enabled
     FROM role_permissions
     GROUP BY role_key, permission_key`,
  ).catch(() => ({ rows: [] as any[] }));

  const permissionMap = new Map<string, Map<string, boolean>>();
  for (const row of rolePermissionsResult.rows) {
    const roleKey = String(row.role_key).toUpperCase();
    const permissionKey = String(row.permission_key);
    if (!CANONICAL_PERMISSION_KEYS.has(permissionKey)) continue;
    if (!permissionMap.has(roleKey)) permissionMap.set(roleKey, new Map());
    permissionMap.get(roleKey)!.set(permissionKey, Boolean(row.enabled));
  }

  const roles = visibleSystemRolesFor(request.user).map((role) => ({
    key: role.key,
    label: role.label,
    description: role.description,
    locked: Boolean(role.locked),
    permissions: PERMISSION_CATALOG.map((permission) => ({
      key: permission.key,
      label: permission.label,
      description: permission.description,
      category: permission.category,
      sortOrder: permission.sortOrder,
      enabled: role.key === "SUPERADMIN" ? true : role.key === "ADMIN" ? permission.key !== "EDIT_UNIFIED_FILE" : Boolean(permissionMap.get(role.key)?.get(permission.key)),
      locked: role.key === "SUPERADMIN" || role.key === "ADMIN",
    })),
  }));

  return { roles };
});

app.patch("/api/roles/:roleKey/permissions", async (request, reply) => {
  if (!(await requireRolesAccess(request, reply))) return;

  const { roleKey } = request.params as { roleKey: string };
  const normalizedRole = String(roleKey || "").trim().toUpperCase() as UserRole;
  const body = request.body as { permissions?: Record<string, boolean> };
  const permissions = body?.permissions || {};

  if (!VALID_USER_ROLES.has(normalizedRole)) {
    return reply.status(400).send({ message: "Rol inválido." });
  }

  if (normalizedRole === "SUPERADMIN" || normalizedRole === "ADMIN") {
    return reply.status(400).send({ message: "El rol SUPERADMIN/ADMIN es de sistema y mantiene permisos protegidos." });
  }

  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    return reply.status(400).send({ message: "Permisos inválidos." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const before = await client.query(
      `SELECT permission_key, enabled
       FROM role_permissions
       WHERE role_key = $1
       ORDER BY permission_key`,
      [normalizedRole],
    );

    await client.query(`DELETE FROM role_permissions WHERE role_key = $1`, [normalizedRole]);

    for (const permission of PERMISSION_CATALOG) {
      await client.query(
        `INSERT INTO role_permissions (role_key, permission_key, enabled)
         VALUES ($1, $2, $3)`,
        [normalizedRole, permission.key, Boolean(permissions[permission.key])],
      );
    }

    const after = await client.query(
      `SELECT permission_key, enabled
       FROM role_permissions
       WHERE role_key = $1
       ORDER BY permission_key`,
      [normalizedRole],
    );

    await client.query("COMMIT");

    await auditUserChange({
      targetUserId: null,
      adminUserId: (request as any).user?.id || null,
      action: "UPDATE_ROLE_PERMISSIONS",
      previousValue: { role: normalizedRole, permissions: before.rows },
      newValue: { role: normalizedRole, permissions: after.rows },
      observation: "Actualización de permisos del rol desde Usuarios y roles.",
    });

    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    request.log.error(err);
    return reply.status(500).send({
      message: err instanceof Error ? err.message : "No se pudieron guardar los permisos del rol.",
    });
  } finally {
    client.release();
  }
});

function parsePositiveInt(value: unknown, fallback: number, max = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function asMenu(value: unknown): MenuKey {
  return VALID_MENUS.includes(value as MenuKey) ? value as MenuKey : "entrada1";
}

function sanitizeLike(value: unknown): string {
  return `%${String(value ?? "").trim()}%`;
}

function parseMonthValues(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter((item) => /^\d{4}-\d{2}$/.test(item));
}

const operationDateRawSql = `COALESCE(data->>'Alta de Op.', data->>'Alta de Op', data->>'FechaDeCompra', data->>'FechaDePago', data->>'Fecha Funcion', '')`;
const operationMonthSql = `substring(${operationDateRawSql} from '^([0-9]{4}-[0-9]{2})')`;

function monthLabel(value: string): string {
  const [year, month] = value.split('-');
  const names = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const idx = Number(month) - 1;
  return idx >= 0 && idx < 12 ? `${names[idx]} ${year}` : value;
}

async function insertRows(runId: string, rows: JoinedRow[]) {
  const batchSize = 400;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values: string[] = [];
    const params: unknown[] = [];

    batch.forEach((row, index) => {
      const base = params.length;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17}, $${base + 18}, $${base + 19}::jsonb)`);
      params.push(
        runId,
        start + index,
        row.__joinKey,
        row.__matchStatus,
        row.__pagoMatches,
        row.__differenceAmount,
        row.__saleAmount ?? 0,
        row.__paymentGroup ?? "SIN_DEFINIR",
        row.__paymentChannel ?? "SIN_DEFINIR",
        row.__paymentSubgroup ?? "SIN_DEFINIR",
        String(row["Establecimiento"] ?? row["establecimiento"] ?? "SIN_DEFINIR") || "SIN_DEFINIR",
        row.__provinceAmount ?? 0,
        row.__entradaUnoAmount ?? 0,
        row.__ticketCount ?? 0,
        row.__schAmount ?? row.__entradaUnoAmount ?? 0,
        row.__operationMonth ?? "",
        String(row["Estado"] ?? ""),
        String(row["Producto"] ?? ""),
        JSON.stringify(row),
      );
    });

    await query(
      `INSERT INTO reconciliation_rows
       (run_id, row_index, join_key, match_status, pago_matches, difference_amount, sale_amount, payment_group, payment_channel, payment_subgroup, establishment, province_amount, entrada_uno_amount, ticket_count, sch_amount, operation_month, operation_status, product, data)
       VALUES ${values.join(",")}`,
      params,
    );
  }
}

function buildWhere(queryParams: Record<string, unknown>) {
  const where = ["run_id = $1"];
  const params: unknown[] = [String(queryParams.runId)];

  const status = String(queryParams.status ?? "todos");
  if (status !== "todos") {
    params.push(status);
    where.push(`match_status = $${params.length}`);
  }

  const paymentGroup = String(queryParams.paymentGroup ?? "todos");
  if (paymentGroup !== "todos") {
    params.push(paymentGroup);
    where.push(`payment_group = $${params.length}`);
  }

  const paymentChannel = String(queryParams.paymentChannel ?? "todos");
  if (paymentChannel !== "todos") {
    params.push(paymentChannel);
    where.push(`payment_channel = $${params.length}`);
  }

  const paymentSubgroup = String(queryParams.paymentSubgroup ?? "todos");
  if (paymentSubgroup !== "todos") {
    params.push(paymentSubgroup);
    where.push(`payment_subgroup = $${params.length}`);
  }

  const operationStatus = String(queryParams.operationStatus ?? "todos");
  if (operationStatus !== "todos") {
    params.push(operationStatus);
    where.push(`operation_status = $${params.length}`);
  }

  const reviewStatus = String(queryParams.reviewStatus ?? "todos");
  if (reviewStatus !== "todos") {
    params.push(reviewStatus);
    where.push(`review_status = $${params.length}`);
  }

  const selectedMonths = parseMonthValues(queryParams.months);
  if (selectedMonths.length) {
    params.push(selectedMonths);
    where.push(`operation_month = ANY($${params.length}::text[])`);
  }

  const q = String(queryParams.q ?? "").trim();
  if (q) {
    params.push(sanitizeLike(q));
    where.push(`data::text ILIKE $${params.length}`);
  }

  const column = String(queryParams.column ?? "").trim();
  const value = String(queryParams.value ?? "").trim();
  if (column && value) {
    params.push(column);
    params.push(sanitizeLike(value));
    where.push(`COALESCE(data ->> $${params.length - 1}, '') ILIKE $${params.length}`);
  }

  return { whereSql: where.join(" AND "), params };
}


function labelPayment(value: string): string {
  const labels: Record<string, string> = {
    EFECTIVO: "Efectivo",
    QR: "QR",
    TARJETA_CREDITO_DEBITO: "Tarjeta crédito/débito",
    TARJETA_CREDITO_DEBITO_WEB: "Tarjeta crédito/débito - Web",
    TARJETA_CREDITO_DEBITO_BOLETERIA: "Tarjeta crédito/débito - Boletería",
    SIN_CARGO: "Sin cargo",
    SIN_DEFINIR: "Sin definir",
    OTRO: "Otro",
    WEB: "Web",
    BOLETERIA: "Boletería",
    PENDIENTE: "Pendiente de revisión",
    REVISADO_OK: "Revisado OK",
    OBSERVADO: "Observado",
    AJUSTADO: "Ajustado",
  };
  return labels[value] ?? value;
}

const ticketCountSql = `COALESCE(SUM(ticket_count), 0)::float`;
const schAmountSql = `COALESCE(SUM(sch_amount), 0)::float`;
const entradaUnoAmountSql = `COALESCE(SUM(entrada_uno_amount), 0)::float`;
const provinceAmountSql = `COALESCE(SUM(province_amount), 0)::float`;
const totalVentaAmountSql = `COALESCE(SUM(province_amount + entrada_uno_amount), 0)::float`;

function paidOnlyWhere(queryParams: Record<string, unknown>) {
  return buildWhere({
    ...queryParams,
    status: "todos",
    paymentGroup: "todos",
    paymentChannel: "todos",
    paymentSubgroup: "todos",
    operationStatus: "Pagada",
  });
}

async function bucketQuery(whereSql: string, params: unknown[], field: string, limit = 30) {
  const sql = `
    SELECT ${field} AS key, COUNT(*)::int AS count, ${totalVentaAmountSql} AS total, ${provinceAmountSql} AS province_amount, ${entradaUnoAmountSql} AS entrada_uno_amount, ${ticketCountSql} AS tickets, ${schAmountSql} AS sch_amount
    FROM reconciliation_rows
    WHERE ${whereSql}
    GROUP BY ${field}
    ORDER BY total DESC, count DESC
    LIMIT ${limit}
  `;
  const result = await query(sql, params);
  return result.rows.map((row: any) => ({
    key: String(row.key ?? "SIN_DEFINIR"),
    label: labelPayment(String(row.key ?? "SIN_DEFINIR")),
    count: Number(row.count ?? 0),
    total: Number(row.total ?? 0),
    tickets: Number(row.tickets ?? 0),
    provinceAmount: Number(row.province_amount ?? 0),
    entradaUnoAmount: Number(row.entrada_uno_amount ?? 0),
    schAmount: Number(row.sch_amount ?? 0),
  }));
}

app.get("/api/health", async () => ({ ok: true }));

app.post("/api/reconciliation/import", async (request, reply) => {
  const files: Record<string, { filename: string; buffer: Buffer }> = {};

  for await (const part of request.parts()) {
    if (part.type !== "file") continue;
    const fieldname = part.fieldname;
    if (fieldname !== "entrada" && fieldname !== "pago" && fieldname !== "qr") continue;
    files[fieldname] = {
      filename: part.filename,
      buffer: await part.toBuffer(),
    };
  }

  if (!files.entrada || !files.pago) {
    return reply.status(400).send({ message: "Debe cargar como mínimo los archivos Entrada UNO y Pago UNO. El archivo QR es opcional para armar el unificado de 3 archivos." });
  }

  const client = await pool.connect();
  try {
    const processed = processBuffers(files.entrada.buffer, files.pago.buffer, files.qr?.buffer);
    const runId = crypto.randomUUID();

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO reconciliation_runs
       (id, user_id, entrada_filename, pago_filename, qr_filename, pago_columns_to_add, qr_columns_to_add, all_columns, summary, step_status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, 'PASO_1_CONCILIACION_GUARDADA')`,
      [
        runId,
        request.user?.id,
        files.entrada.filename,
        files.pago.filename,
        files.qr?.filename ?? null,
        JSON.stringify(processed.pagoColumnsToAdd),
        JSON.stringify(processed.qrColumnsToAdd),
        JSON.stringify(processed.allColumns),
        JSON.stringify(processed.summary),
      ],
    );
    await client.query("COMMIT");

    await insertRows(runId, processed.rows);

    return {
      runId,
      summary: processed.summary,
      allColumns: processed.allColumns,
      pagoColumnsToAdd: processed.pagoColumnsToAdd,
      qrColumnsToAdd: processed.qrColumnsToAdd,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error);
    const message = error instanceof Error ? error.message : "No se pudo importar y conciliar los archivos.";
    return reply.status(500).send({ message });
  } finally {
    client.release();
  }
});

app.get("/api/runs", async (request) => {
  const user = request.user!;
  const permissions = await currentUserPermissions(request);
  const canOpenRuns = roleHasPermission(user, permissions, "OPEN_RUNS");
  const where = canOpenRuns ? "TRUE" : "(user_id = $1 OR user_id IS NULL)";
  const params = canOpenRuns ? [] : [user.id];
  const result = await query(
    `SELECT r.id, r.created_at, r.entrada_filename, r.pago_filename, r.qr_filename, r.summary, r.step_status, r.notes, r.reconciliation_stage, r.last_reconciled_at, u.full_name AS imported_by, ur.full_name AS last_reconciled_by_name
     FROM reconciliation_runs r
     LEFT JOIN app_users u ON u.id = r.user_id
     LEFT JOIN app_users ur ON ur.id = r.last_reconciled_by
     WHERE ${where}
     ORDER BY r.created_at DESC
     LIMIT 50`,
    params,
  );
  return { runs: result.rows };
});

app.get("/api/runs/:runId", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  if (!(await requireRunAccess(runId, request.user!))) return reply.status(404).send({ message: "Conciliación no encontrada." });
  const result = await query(
    `SELECT r.id, r.created_at, r.entrada_filename, r.pago_filename, r.qr_filename, r.summary, r.all_columns, r.pago_columns_to_add, r.qr_columns_to_add, r.step_status, r.notes, r.reconciliation_stage, r.last_reconciled_at, u.full_name AS last_reconciled_by_name
     FROM reconciliation_runs r
     LEFT JOIN app_users u ON u.id = r.last_reconciled_by
     WHERE r.id = $1`,
    [runId],
  );
  if (!result.rowCount) return reply.status(404).send({ message: "Conciliación no encontrada." });
  return result.rows[0];
});



async function paymentMethodsByChannelQuery(whereSql: string, params: unknown[]) {
  const result = await query(
    `SELECT
       COALESCE(NULLIF(payment_channel, ''), 'SIN_DEFINIR') AS channel_key,
       COALESCE(NULLIF(payment_group, ''), 'SIN_DEFINIR') AS group_key,
       COALESCE(NULLIF(payment_subgroup, ''), 'SIN_DEFINIR') AS subgroup_key,
       COUNT(*)::int AS count,
       ${totalVentaAmountSql} AS total,
       ${provinceAmountSql} AS province_amount,
       ${entradaUnoAmountSql} AS entrada_uno_amount,
       ${ticketCountSql} AS tickets,
       ${schAmountSql} AS sch_amount
     FROM reconciliation_rows
     WHERE ${whereSql}
     GROUP BY payment_channel, payment_group, payment_subgroup
     ORDER BY channel_key, total DESC, count DESC`,
    params,
  );

  return result.rows.map((row) => {
    const total = Number(row.total ?? 0);
    const provinceAmount = Number(row.province_amount ?? 0);
    return {
      channelKey: String(row.channel_key ?? 'SIN_DEFINIR'),
      channelLabel: labelPaymentValue(row.channel_key),
      groupKey: String(row.group_key ?? 'SIN_DEFINIR'),
      groupLabel: labelPaymentValue(row.group_key),
      subgroupKey: String(row.subgroup_key ?? 'SIN_DEFINIR'),
      subgroupLabel: labelPaymentValue(row.subgroup_key),
      count: Number(row.count ?? 0),
      tickets: Number(row.tickets ?? 0),
      schAmount: Number(row.sch_amount ?? 0),
      total,
      provinceAmount,
      entradaUnoAmount: Number(row.entrada_uno_amount ?? 0),
    };
  });
}

async function paymentMethodsByEstablishmentQuery(whereSql: string, params: unknown[]) {
  const result = await query(
    `SELECT
       COALESCE(NULLIF(establishment, ''), 'SIN_DEFINIR') AS establishment_key,
       COALESCE(NULLIF(payment_channel, ''), 'SIN_DEFINIR') AS channel_key,
       COALESCE(NULLIF(payment_group, ''), 'SIN_DEFINIR') AS group_key,
       COALESCE(NULLIF(payment_subgroup, ''), 'SIN_DEFINIR') AS subgroup_key,
       COUNT(*)::int AS count,
       ${totalVentaAmountSql} AS total,
       ${provinceAmountSql} AS province_amount,
       ${entradaUnoAmountSql} AS entrada_uno_amount,
       ${ticketCountSql} AS tickets,
       ${schAmountSql} AS sch_amount
     FROM reconciliation_rows
     WHERE ${whereSql}
     GROUP BY establishment, payment_channel, payment_group, payment_subgroup
     ORDER BY establishment_key, channel_key, total DESC, count DESC`,
    params,
  );

  return result.rows.map((row) => ({
    establishmentKey: String(row.establishment_key ?? 'SIN_DEFINIR'),
    establishmentLabel: String(row.establishment_key ?? 'Sin definir'),
    channelKey: String(row.channel_key ?? 'SIN_DEFINIR'),
    channelLabel: labelPaymentValue(row.channel_key),
    groupKey: String(row.group_key ?? 'SIN_DEFINIR'),
    groupLabel: labelPaymentValue(row.group_key),
    subgroupKey: String(row.subgroup_key ?? 'SIN_DEFINIR'),
    subgroupLabel: labelPaymentValue(row.subgroup_key),
    count: Number(row.count ?? 0),
    tickets: Number(row.tickets ?? 0),
    schAmount: Number(row.sch_amount ?? 0),
    total: Number(row.total ?? 0),
    provinceAmount: Number(row.province_amount ?? 0),
    entradaUnoAmount: Number(row.entrada_uno_amount ?? 0),
  }));
}

function labelPaymentValue(value: unknown): string {
  const raw = String(value ?? 'SIN_DEFINIR');
  const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const labels: Record<string, string> = {
    BOLETERIA: 'Boletería',
    WEB: 'Web',
    EFECTIVO: 'Efectivo',
    QR: 'QR',
    TARJETA: 'Tarjeta crédito/débito',
    TARJETA_WEB: 'Tarjeta crédito/débito Web',
    TARJETA_BOLETERIA: 'Tarjeta crédito/débito Boletería',
    SIN_DEFINIR: 'Sin definir',
  };
  return labels[normalized] ?? raw;
}

app.get("/api/runs/:runId/dashboard", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  if (!(await requireRunAccess(runId, request.user!))) return reply.status(404).send({ message: "Conciliación no encontrada." });
  const queryString = request.query as Record<string, unknown>;
  const { whereSql, params } = buildWhere({ ...queryString, runId });

  const totalsResult = await query(
    `SELECT
       COUNT(*)::int AS total_rows,
       ${totalVentaAmountSql} AS total_sales,
       ${provinceAmountSql} AS province_amount,
       ${entradaUnoAmountSql} AS entrada_uno_amount,
       COALESCE(SUM(CASE WHEN match_status = 'CONCILIADO' THEN sale_amount - COALESCE(difference_amount, 0) ELSE 0 END), 0)::float AS total_pago_conciliado,
       COALESCE(SUM(COALESCE(difference_amount, 0)), 0)::float AS total_difference,
       COUNT(*) FILTER (WHERE review_status = 'PENDIENTE')::int AS pending_review,
       COUNT(*) FILTER (WHERE review_status = 'REVISADO_OK')::int AS reviewed_ok,
       COUNT(*) FILTER (WHERE review_status = 'OBSERVADO')::int AS observed,
       COUNT(*) FILTER (WHERE review_status = 'AJUSTADO')::int AS adjusted
     FROM reconciliation_rows
     WHERE ${whereSql}`,
    params,
  );

  // Regla contable vigente:
  // Total Venta 110% = Provincia 100% + Entrada UNO 10%.
  // Provincia 100% se toma de "Precio Final S/Interés".
  // Entrada UNO 10% se toma de "Valor SCH".
  const provinceAmount = Number(totalsResult.rows[0]?.province_amount ?? 0);
  const entradaUnoAmount = Number(totalsResult.rows[0]?.entrada_uno_amount ?? 0);
  const totalSales = provinceAmount + entradaUnoAmount;

  const monthsResult = await query(
    `SELECT operation_month AS month_value, COUNT(*)::int AS count
     FROM reconciliation_rows
     WHERE run_id = $1 AND operation_month IS NOT NULL AND operation_month <> ''
     GROUP BY operation_month
     ORDER BY operation_month`,
    [runId],
  );

  const paidWhere = paidOnlyWhere({ ...queryString, runId });

  const [
    reviewStatuses,
    paymentGroups,
    paymentSubgroups,
    paymentChannels,
    paymentChannelsPaid,
    paymentMethodsByChannel,
    paymentMethodsByChannelPaid,
    establishmentsPaid,
    paymentMethodsByEstablishmentPaid,
    operationStatuses,
    topProducts,
  ] = await Promise.all([
    bucketQuery(whereSql, params, "review_status"),
    bucketQuery(whereSql, params, "payment_group"),
    bucketQuery(whereSql, params, "payment_subgroup"),
    bucketQuery(whereSql, params, "payment_channel"),
    bucketQuery(paidWhere.whereSql, paidWhere.params, "payment_channel"),
    paymentMethodsByChannelQuery(whereSql, params),
    paymentMethodsByChannelQuery(paidWhere.whereSql, paidWhere.params),
    bucketQuery(paidWhere.whereSql, paidWhere.params, "establishment", 200),
    paymentMethodsByEstablishmentQuery(paidWhere.whereSql, paidWhere.params),
    bucketQuery(whereSql, params, "operation_status"),
    bucketQuery(whereSql, params, "NULLIF(product, '')", 12),
  ]);

  return {
    totalRows: Number(totalsResult.rows[0]?.total_rows ?? 0),
    totalSales,
    provinceAmount,
    entradaUnoAmount,
    totalPagoConciliado: Number(totalsResult.rows[0]?.total_pago_conciliado ?? 0),
    totalDifference: Number(totalsResult.rows[0]?.total_difference ?? 0),
    pendingReview: Number(totalsResult.rows[0]?.pending_review ?? 0),
    reviewedOk: Number(totalsResult.rows[0]?.reviewed_ok ?? 0),
    observed: Number(totalsResult.rows[0]?.observed ?? 0),
    adjusted: Number(totalsResult.rows[0]?.adjusted ?? 0),
    reviewStatuses,
    paymentGroups,
    paymentSubgroups,
    paymentChannels,
    paymentChannelsPaid,
    paymentMethodsByChannel,
    paymentMethodsByChannelPaid,
    establishmentsPaid,
    paymentMethodsByEstablishmentPaid,
    operationStatuses,
    topProducts,
    availableMonths: monthsResult.rows.map((row: any) => ({
      value: String(row.month_value),
      label: monthLabel(String(row.month_value)),
      count: Number(row.count ?? 0),
    })),
  };
});

app.get("/api/runs/:runId/rows", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  if (!(await requireRunAccess(runId, request.user!))) return reply.status(404).send({ message: "Conciliación no encontrada." });
  const queryString = request.query as Record<string, unknown>;
  const page = parsePositiveInt(queryString.page, 1, 100000);
  const pageSize = parsePositiveInt(queryString.pageSize, 100, 500);
  const menu = asMenu(queryString.menu);
  const offset = (page - 1) * pageSize;

  const runResult = await query(
    `SELECT all_columns, pago_columns_to_add FROM reconciliation_runs WHERE id = $1`,
    [runId],
  );
  if (!runResult.rowCount) return { rows: [], columns: [], total: 0, page, pageSize };

  const allColumns = runResult.rows[0].all_columns as string[];
  const pagoColumnsToAdd = runResult.rows[0].pago_columns_to_add as any[];
  const baseColumns = visibleColumnsByMenu(allColumns, pagoColumnsToAdd, menu);
  const columns = ["__rowId", "__reviewStatus", "__reconciliationObservation", "__reconciledAt", ...baseColumns.filter((column) => !["__rowId", "__reviewStatus", "__reconciliationObservation", "__reconciledAt"].includes(column))];

  const { whereSql, params } = buildWhere({ ...queryString, runId });
  const countResult = await query<{ total: string }>(`SELECT COUNT(*) AS total FROM reconciliation_rows WHERE ${whereSql}`, params);

  params.push(pageSize);
  params.push(offset);
  const rowsResult = await query(
    `SELECT id, data, review_status, reconciliation_observation, reconciled_at
     FROM reconciliation_rows
     WHERE ${whereSql}
     ORDER BY row_index ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    rows: rowsResult.rows.map((item: any) => ({
      __rowId: item.id,
      __reviewStatus: item.review_status,
      __reconciliationObservation: item.reconciliation_observation || "",
      __reconciledAt: item.reconciled_at || "",
      ...item.data,
    })),
    columns,
    total: Number(countResult.rows[0]?.total ?? 0),
    page,
    pageSize,
  };
});


function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function buildAccountingDecision(row: any) {
  const saleAmount = Number(row.sale_amount ?? 0);
  const difference = row.difference_amount === null ? null : Number(row.difference_amount ?? 0);
  const pagoMatches = Number(row.pago_matches ?? 0);
  const matchStatus = String(row.match_status ?? "");
  const provinceAmount = roundMoney(Number(row.data?.__provinceAmount ?? row.data?.["Precio Final S/Interés"] ?? row.data?.["Precio Final S/Interes"] ?? saleAmount / 1.10));
  const entradaUnoAmount = roundMoney(Number(row.data?.__entradaUnoAmount ?? row.data?.["Valor SCH"] ?? row.data?.["ValorSCH"] ?? row.data?.["SCH"] ?? 0));
  const tolerance = 0.01;

  let reviewStatus = "PENDIENTE";
  let result = "REQUIERE_REVISION_CONTABLE";
  let observation = "";

  if (matchStatus !== "CONCILIADO" || pagoMatches === 0) {
    reviewStatus = "OBSERVADO";
    result = "NO_CONCILIADO_SIN_PAGO_UNO";
    observation = `No se encontró movimiento equivalente en Pago UNO para la clave ${row.join_key || "sin clave"}. Corresponde controlar cobro pendiente, anulación o registración faltante.`;
  } else if (pagoMatches > 1) {
    reviewStatus = "OBSERVADO";
    result = "NO_CONCILIADO_PAGO_DUPLICADO";
    observation = `La operación tiene ${pagoMatches} movimientos asociados en Pago UNO. Requiere control de duplicidad, lote, cupón y liquidación antes de cerrar la conciliación.`;
  } else if (difference !== null && Math.abs(difference) > tolerance) {
    reviewStatus = "OBSERVADO";
    result = "NO_CONCILIADO_DIFERENCIA_IMPORTE";
    observation = `Diferencia de importe entre Entrada UNO y Pago UNO por ${roundMoney(difference).toLocaleString("es-AR")}. Verificar comisión, reverso, descuento, contracargo o imputación parcial.`;
  } else {
    reviewStatus = "REVISADO_OK";
    result = "CONCILIADO_CONTABLEMENTE";
    observation = `Conciliación automática correcta. Orden# coincide con ID de Operación, existe un único pago asociado y no hay diferencia de importe. Total 110%: ${roundMoney(saleAmount).toLocaleString("es-AR")}; Provincia 100%: ${provinceAmount.toLocaleString("es-AR")}; Entrada UNO 10%: ${entradaUnoAmount.toLocaleString("es-AR")}.`;
  }

  return { reviewStatus, result, observation, provinceAmount, entradaUnoAmount };
}

app.get("/api/runs/:runId/export", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  if (!(await requireRunAccess(runId, request.user!))) return reply.status(404).send({ message: "Conciliación no encontrada." });
  const runResult = await query(`SELECT all_columns FROM reconciliation_runs WHERE id = $1`, [runId]);
  if (!runResult.rowCount) return reply.status(404).send({ message: "Conciliación no encontrada." });

  const rowsResult = await query(
    `SELECT id, data, review_status, reconciliation_observation, reconciled_at
     FROM reconciliation_rows
     WHERE run_id = $1
     ORDER BY row_index ASC`,
    [runId],
  );
  const rows = rowsResult.rows.map((item: any) => ({
    "ID Fila Sistema": item.id,
    "Estado Revisión": item.review_status,
    "Observación Conciliación": item.reconciliation_observation || "",
    "Fecha Revisión": item.reconciled_at || "",
    ...item.data,
  })) as JoinedRow[];
  const columns = ["ID Fila Sistema", "Estado Revisión", "Observación Conciliación", "Fecha Revisión", ...(runResult.rows[0].all_columns as string[])];
  const buffer = buildExcelBuffer(rows, columns);

  reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  reply.header("Content-Disposition", `attachment; filename="conciliacion_entrada_uno_pago_uno_${runId}.xlsx"`);
  return reply.send(buffer);
});

app.patch("/api/runs/:runId", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  if (!(await requireRunAccess(runId, request.user!))) return reply.status(404).send({ message: "Conciliación no encontrada." });
  const body = request.body as { notes?: string; stepStatus?: string };
  const notes = String(body?.notes ?? "").slice(0, 3000);
  const stepStatus = String(body?.stepStatus || "PASO_1_CONCILIACION_GUARDADA");
  await query(
    `UPDATE reconciliation_runs SET notes = $2, step_status = $3 WHERE id = $1`,
    [runId, notes, stepStatus],
  );
  return { ok: true };
});



app.post("/api/runs/:runId/reconcile", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  if (!(await requireRunAccess(runId, request.user!))) return reply.status(404).send({ message: "Conciliación no encontrada." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rowsResult = await client.query(
      `SELECT id, join_key, match_status, pago_matches, difference_amount, sale_amount, data, review_status
       FROM reconciliation_rows
       WHERE run_id = $1
       ORDER BY row_index ASC`,
      [runId],
    );

    let ok = 0;
    let observed = 0;
    let duplicated = 0;
    let amountDifferences = 0;
    let missingPayments = 0;

    for (const row of rowsResult.rows) {
      const decision = buildAccountingDecision(row);
      if (decision.reviewStatus === "REVISADO_OK") ok += 1;
      else observed += 1;
      if (decision.result === "NO_CONCILIADO_PAGO_DUPLICADO") duplicated += 1;
      if (decision.result === "NO_CONCILIADO_DIFERENCIA_IMPORTE") amountDifferences += 1;
      if (decision.result === "NO_CONCILIADO_SIN_PAGO_UNO") missingPayments += 1;

      await client.query(
        `UPDATE reconciliation_rows
         SET review_status = $3,
             reconciliation_observation = $4,
             reconciled_by = $5,
             reconciled_at = NOW(),
             data = jsonb_set(
               jsonb_set(
                 jsonb_set(
                   jsonb_set(
                     jsonb_set(data, '{Resultado Conciliación Contable}', to_jsonb($6::text), true),
                     '{Observación Conciliación}', to_jsonb($4::text), true
                   ),
                   '{Provincia 100%}', to_jsonb($7::numeric), true
                 ),
                 '{Entrada UNO 10%}', to_jsonb($8::numeric), true
               ),
               '{Estado Revisión}', to_jsonb($3::text), true
             )
         WHERE id = $1 AND run_id = $2`,
        [row.id, runId, decision.reviewStatus, decision.observation, request.user?.id, decision.result, decision.provinceAmount, decision.entradaUnoAmount],
      );
    }

    const summary = { totalProcesadas: rowsResult.rowCount, conciliadasOk: ok, observadas: observed, sinPagoUno: missingPayments, conDiferenciaImporte: amountDifferences, pagosDuplicados: duplicated };
    const currentRun = await client.query(`SELECT all_columns FROM reconciliation_runs WHERE id = $1`, [runId]);
    const currentColumns = Array.isArray(currentRun.rows[0]?.all_columns) ? currentRun.rows[0].all_columns : [];
    const accountingColumns = ["Resultado Conciliación Contable", "Observación Conciliación", "Provincia 100%", "Entrada UNO 10%", "Estado Revisión"];
    const nextColumns = Array.from(new Set([...currentColumns, ...accountingColumns]));
    await client.query(
      `UPDATE reconciliation_runs
       SET reconciliation_stage = 'PASO_2_CONCILIACION_CONTABLE_REALIZADA',
           step_status = 'PASO_2_CONCILIACION_CONTABLE_REALIZADA',
           last_reconciled_at = NOW(),
           last_reconciled_by = $2,
           all_columns = $4::jsonb,
           notes = COALESCE(notes, '') || CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE E'\n\n' END || $3
       WHERE id = $1`,
      [runId, request.user?.id, `Conciliación contable automática realizada. OK: ${ok}. Observadas: ${observed}. Sin Pago UNO: ${missingPayments}. Diferencias de importe: ${amountDifferences}. Pagos duplicados: ${duplicated}.`, JSON.stringify(nextColumns)],
    );

    await client.query(
      `INSERT INTO reconciliation_audit_logs
       (run_id, user_id, action, previous_status, new_status, observation)
       VALUES ($1, $2, 'REALIZAR_CONCILIACION_CONTABLE', 'PASO_1_CONCILIACION_GUARDADA', 'PASO_2_CONCILIACION_CONTABLE_REALIZADA', $3)`,
      [runId, request.user?.id, JSON.stringify(summary)],
    );

    await client.query("COMMIT");
    return { ok: true, summary };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error);
    return reply.status(500).send({ message: "No se pudo realizar la conciliación contable." });
  } finally {
    client.release();
  }
});


function toOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/\./g, "").replace(",", ".").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeManualPaymentSubgroup(group: string, channel: string): string {
  if (group === "TARJETA_CREDITO_DEBITO" && channel === "WEB") return "TARJETA_CREDITO_DEBITO_WEB";
  if (group === "TARJETA_CREDITO_DEBITO" && channel === "BOLETERIA") return "TARJETA_CREDITO_DEBITO_BOLETERIA";
  return group || "SIN_DEFINIR";
}

app.patch("/api/runs/:runId/rows/:rowId", async (request, reply) => {
  const { runId, rowId } = request.params as { runId: string; rowId: string };
  if (!(await requireRunAccess(runId, request.user!))) return reply.status(404).send({ message: "Conciliación no encontrada." });
  if (!(await requireEditUnifiedFileAccess(request, reply))) return;

  const body = request.body as {
    reviewStatus?: string;
    observation?: string;
    saleAmount?: number | string;
    paymentAmount?: number | string;
    paymentGroup?: string;
    paymentChannel?: string;
    paymentSubgroup?: string;
    updates?: Record<string, unknown>;
  };

  const current = await query(
    `SELECT id, review_status, reconciliation_observation, sale_amount, difference_amount, payment_group, payment_channel, payment_subgroup, data
     FROM reconciliation_rows
     WHERE id = $1 AND run_id = $2`,
    [rowId, runId],
  );
  if (!current.rowCount) return reply.status(404).send({ message: "Registro no encontrado en esta conciliación." });

  const currentRow = current.rows[0];
  const currentData = currentRow.data || {};
  const rawUpdates = body?.updates && typeof body.updates === "object" ? body.updates : {};

  const allowedStatuses = new Set(["PENDIENTE", "REVISADO_OK", "OBSERVADO", "AJUSTADO"]);
  const requestedReviewStatus = String(body?.reviewStatus ?? rawUpdates.__reviewStatus ?? currentRow.review_status ?? "PENDIENTE").trim().toUpperCase();
  const reviewStatus = allowedStatuses.has(requestedReviewStatus) ? requestedReviewStatus : String(currentRow.review_status ?? "PENDIENTE").toUpperCase();

  const nextData: Record<string, unknown> = { ...currentData };
  const previousValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};

  for (const [column, value] of Object.entries(rawUpdates)) {
    if (["__rowId", "__reconciledAt"].includes(column)) continue;
    previousValues[column] = column.startsWith("__") ? (column === "__reviewStatus" ? currentRow.review_status : column === "__reconciliationObservation" ? currentRow.reconciliation_observation : currentData[column]) : currentData[column];
    newValues[column] = value;
    if (!column.startsWith("__")) nextData[column] = value;
  }

  const observation = String(body?.observation ?? rawUpdates.__reconciliationObservation ?? currentRow.reconciliation_observation ?? "").trim().slice(0, 2500);
  if (rawUpdates.__reconciliationObservation !== undefined) {
    previousValues.__reconciliationObservation = currentRow.reconciliation_observation || "";
    newValues.__reconciliationObservation = observation;
  }
  if (rawUpdates.__reviewStatus !== undefined || body?.reviewStatus !== undefined) {
    previousValues.__reviewStatus = currentRow.review_status;
    newValues.__reviewStatus = reviewStatus;
  }

  function firstDataNumber(keys: string[], fallback: number): number {
    for (const key of keys) {
      const parsed = toOptionalNumber(nextData[key]);
      if (parsed !== null) return parsed;
    }
    return fallback;
  }

  const saleAmount = toOptionalNumber(body.saleAmount)
    ?? firstDataNumber(["__saleAmount", "Total venta 110%", "Total Venta 110%", "Total venta", "Total Venta", "Precio Venta Total"], Number(currentRow.sale_amount ?? currentData.__saleAmount ?? 0));

  const paymentAmount = toOptionalNumber(body.paymentAmount);
  const calculatedDifference = paymentAmount === null ? Number(currentRow.difference_amount ?? currentData.__differenceAmount ?? 0) : saleAmount - paymentAmount;

  const provinceAmount = roundMoney(firstDataNumber(["__provinceAmount", "Provincia 100%", "Precio Final S/Interés", "Precio Final S/Interes"], Number(currentData?.__provinceAmount ?? currentRow.sale_amount ?? 0) / 1.10));

  const entradaUnoAmount = roundMoney(firstDataNumber(["__entradaUnoAmount", "Entrada UNO 10%", "Valor SCH", "ValorSCH", "SCH"], provinceAmount * 0.10));

  const paymentGroup = String(body.paymentGroup || rawUpdates.__paymentGroup || currentRow.payment_group || currentData.__paymentGroup || "SIN_DEFINIR").trim().toUpperCase();
  const paymentChannel = String(body.paymentChannel || rawUpdates.__paymentChannel || currentRow.payment_channel || currentData.__paymentChannel || "SIN_DEFINIR").trim().toUpperCase();
  const paymentSubgroup = String(body.paymentSubgroup || rawUpdates.__paymentSubgroup || currentRow.payment_subgroup || currentData.__paymentSubgroup || normalizeManualPaymentSubgroup(paymentGroup, paymentChannel)).trim().toUpperCase();

  const operationStatus = String(rawUpdates["Estado"] ?? rawUpdates["estado"] ?? currentData["Estado"] ?? currentData["estado"] ?? "").trim() || null;

  const result = reviewStatus === "REVISADO_OK" ? "CONCILIADO_MANUALMENTE" : reviewStatus === "AJUSTADO" ? "AJUSTADO_MANUALMENTE" : reviewStatus === "OBSERVADO" ? "OBSERVADO_MANUALMENTE" : "PENDIENTE_REVISION_MANUAL";

  Object.assign(nextData, {
    __saleAmount: saleAmount,
    __differenceAmount: calculatedDifference,
    __provinceAmount: provinceAmount,
    __entradaUnoAmount: entradaUnoAmount,
    __paymentGroup: paymentGroup,
    __paymentChannel: paymentChannel,
    __paymentSubgroup: paymentSubgroup,
    "Estado Revisión": reviewStatus,
    "Resultado Conciliación Contable": result,
    "Observación Conciliación": observation,
    "Fecha Revisión": new Date().toISOString(),
    "Provincia 100%": provinceAmount,
    "Entrada UNO 10%": entradaUnoAmount,
  });

  await query(
    `UPDATE reconciliation_rows
     SET review_status = $3,
         reconciliation_observation = $4,
         reconciled_by = $5,
         reconciled_at = NOW(),
         sale_amount = $6,
         difference_amount = $7,
         payment_group = $8,
         payment_channel = $9,
         payment_subgroup = $10,
         data = $11::jsonb,
         province_amount = $12,
         entrada_uno_amount = $13,
         operation_status = COALESCE($14, operation_status)
     WHERE id = $1 AND run_id = $2`,
    [rowId, runId, reviewStatus, observation, request.user?.id, saleAmount, calculatedDifference, paymentGroup, paymentChannel, paymentSubgroup, JSON.stringify(nextData), provinceAmount, entradaUnoAmount, operationStatus],
  );

  const manualColumns = [
    "Resultado Conciliación Contable",
    "Observación Conciliación",
    "Fecha Revisión",
    "Provincia 100%",
    "Entrada UNO 10%",
    "Estado Revisión",
  ];
  const runColumns = await query(`SELECT all_columns FROM reconciliation_runs WHERE id = $1`, [runId]);
  const currentColumns = Array.isArray(runColumns.rows[0]?.all_columns) ? runColumns.rows[0].all_columns : [];
  const nextColumns = Array.from(new Set([...currentColumns, ...manualColumns]));

  await query(
    `UPDATE reconciliation_runs
     SET reconciliation_stage = 'PASO_2_EDICION_ARCHIVO_UNIFICADO',
         step_status = 'PASO_2_EDICION_ARCHIVO_UNIFICADO',
         last_reconciled_at = NOW(),
         last_reconciled_by = $2,
         all_columns = $3::jsonb
     WHERE id = $1`,
    [runId, request.user?.id, JSON.stringify(nextColumns)],
  );

  await query(
    `INSERT INTO reconciliation_audit_logs
     (run_id, row_id, user_id, action, previous_status, new_status, observation)
     VALUES ($1, $2, $3, 'EDICION_ARCHIVO_UNIFICADO', $4, $5, $6)`,
    [runId, rowId, request.user?.id, currentRow.review_status, reviewStatus, JSON.stringify({ previousValues, newValues, observation })],
  );

  return { ok: true, updated: true, rowId: Number(rowId) };
});

app.get("/api/runs/:runId/audit", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  if (!(await requireRunAccess(runId, request.user!))) return reply.status(404).send({ message: "Conciliación no encontrada." });
  const result = await query(
    `SELECT a.id, a.created_at, a.row_id, a.action, a.previous_status, a.new_status, a.observation, u.full_name AS user_name
     FROM reconciliation_audit_logs a
     LEFT JOIN app_users u ON u.id = a.user_id
     WHERE a.run_id = $1
     ORDER BY a.created_at DESC
     LIMIT 80`,
    [runId],
  );
  return { audit: result.rows };
});

app.get("/api/columns/labels", async () => {
  return { labelColumn: "client-side-compatible", example: labelColumn("__matchStatus") };
});

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
