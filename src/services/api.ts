import type { DashboardResponse, ImportResponse, LoginResponse, CreateUserPayload, ManagedUser, ManualRowUpdate, MenuKey, RowsResponse, RunMetadata, TableFilters, UpdateRolePermissionsPayload, UpdateUserPayload, UserAuditLog, UserSession, RoleDefinition } from "../types/reconciliation";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4108";
const TOKEN_KEY = "conciliacion_cultura_uno_token";

export function getStoredToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setStoredToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const token = getStoredToken();
  return {
    ...(extra || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = "Error de comunicación con el servidor.";
    try {
      const payload = await response.json();
      message = payload.message || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function buildFilterParams(filters: TableFilters): URLSearchParams {
  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
    status: filters.status,
    paymentGroup: filters.paymentGroup,
    paymentChannel: filters.paymentChannel,
    paymentSubgroup: filters.paymentSubgroup,
    operationStatus: filters.operationStatus,
    reviewStatus: filters.reviewStatus,
  });

  for (const month of filters.selectedMonths || []) {
    if (month) params.append("months", month);
  }

  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.column && filters.value.trim()) {
    params.set("column", filters.column);
    params.set("value", filters.value.trim());
  }
  return params;
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const response = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = await parseResponse<LoginResponse>(response);
  setStoredToken(payload.token);
  return payload;
}

export async function fetchMe(): Promise<UserSession> {
  const response = await fetch(`${API_URL}/api/auth/me`, { headers: authHeaders() });
  const payload = await parseResponse<{ user: UserSession }>(response);
  return payload.user;
}

export async function importReconciliation(entrada: File, pago: File, qr?: File | null): Promise<ImportResponse> {
  const formData = new FormData();
  formData.append("entrada", entrada);
  formData.append("pago", pago);
  if (qr) formData.append("qr", qr);

  const response = await fetch(`${API_URL}/api/reconciliation/import`, {
    method: "POST",
    headers: authHeaders(),
    body: formData,
  });
  return parseResponse<ImportResponse>(response);
}

export async function appendMonthToRun(runId: string, entrada: File, pago: File, qr?: File | null): Promise<ImportResponse & { appendedRows: number; duplicateRowsSkipped: number }> {
  const formData = new FormData();
  formData.append("entrada", entrada);
  formData.append("pago", pago);
  if (qr) formData.append("qr", qr);

  const response = await fetch(`${API_URL}/api/runs/${runId}/append`, {
    method: "POST",
    headers: authHeaders(),
    body: formData,
  });
  return parseResponse<ImportResponse & { appendedRows: number; duplicateRowsSkipped: number }>(response);
}

export async function fetchRows(runId: string, menu: MenuKey, filters: TableFilters): Promise<RowsResponse> {
  const params = buildFilterParams(filters);
  params.set("menu", menu);
  const response = await fetch(`${API_URL}/api/runs/${runId}/rows?${params.toString()}`, { headers: authHeaders() });
  return parseResponse<RowsResponse>(response);
}

export async function fetchDashboard(runId: string, filters: TableFilters): Promise<DashboardResponse> {
  const params = buildFilterParams(filters);
  const response = await fetch(`${API_URL}/api/runs/${runId}/dashboard?${params.toString()}`, { headers: authHeaders() });
  return parseResponse<DashboardResponse>(response);
}

export async function fetchRuns(): Promise<RunMetadata[]> {
  const response = await fetch(`${API_URL}/api/runs`, { headers: authHeaders() });
  const payload = await parseResponse<{ runs: RunMetadata[] }>(response);
  return payload.runs;
}

export async function fetchRun(runId: string): Promise<RunMetadata> {
  const response = await fetch(`${API_URL}/api/runs/${runId}`, { headers: authHeaders() });
  return parseResponse<RunMetadata>(response);
}

export async function updateRunRow(runId: string, rowId: number, payload: ManualRowUpdate) {
  const response = await fetch(`${API_URL}/api/runs/${runId}/rows/${rowId}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return parseResponse<{ ok: boolean }>(response);
}

export async function updateRunNotes(runId: string, notes: string, stepStatus = "PASO_1_CONCILIACION_GUARDADA") {
  const response = await fetch(`${API_URL}/api/runs/${runId}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ notes, stepStatus }),
  });
  return parseResponse<{ ok: boolean }>(response);
}

export function exportRunUrl(runId: string): string {
  const token = encodeURIComponent(getStoredToken());
  return `${API_URL}/api/runs/${runId}/export?token=${token}`;
}


export async function fetchUsers(): Promise<ManagedUser[]> {
  const response = await fetch(`${API_URL}/api/users`, { headers: authHeaders() });
  const payload = await parseResponse<{ users: ManagedUser[] }>(response);
  return payload.users;
}

export async function createUser(payload: CreateUserPayload): Promise<ManagedUser> {
  const response = await fetch(`${API_URL}/api/users`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const result = await parseResponse<{ user: ManagedUser }>(response);
  return result.user;
}

export async function updateUser(userId: string, payload: UpdateUserPayload): Promise<ManagedUser> {
  const response = await fetch(`${API_URL}/api/users/${userId}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const result = await parseResponse<{ user: ManagedUser }>(response);
  return result.user;
}

export async function updateUserPassword(userId: string, password: string): Promise<{ ok: boolean }> {
  const response = await fetch(`${API_URL}/api/users/${userId}/password`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ password }),
  });
  return parseResponse<{ ok: boolean }>(response);
}

export async function fetchUserAuditLogs(): Promise<UserAuditLog[]> {
  const response = await fetch(`${API_URL}/api/users/audit`, { headers: authHeaders() });
  const payload = await parseResponse<{ logs: UserAuditLog[] }>(response);
  return payload.logs;
}


export async function fetchRoles(): Promise<RoleDefinition[]> {
  const response = await fetch(`${API_URL}/api/roles`, { headers: authHeaders() });
  const payload = await parseResponse<{ roles: RoleDefinition[] }>(response);
  return payload.roles;
}

export async function updateRolePermissions(roleKey: string, payload: UpdateRolePermissionsPayload): Promise<{ ok: boolean }> {
  const response = await fetch(`${API_URL}/api/roles/${encodeURIComponent(roleKey)}/permissions`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return parseResponse<{ ok: boolean }>(response);
}
