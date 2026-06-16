export type MenuKey = "entrada1" | "bordereaux" | "conciliacionTC" | "archivoCompleto";

export type ExcelValue = string | number | boolean | null | undefined;

export type ExcelRow = Record<string, ExcelValue>;

export interface ReconciliationResult {
  rows: JoinedRow[];
  pagoColumnsToAdd: PagoColumnMeta[];
  qrColumnsToAdd?: PagoColumnMeta[];
  allColumns?: string[];
  summary: ReconciliationSummary;
}
export type ReviewStatus = "PENDIENTE" | "REVISADO_OK" | "OBSERVADO" | "AJUSTADO";

export interface ManualRowUpdate {
  reviewStatus?: ReviewStatus;
  observation?: string;
  saleAmount?: number;
  paymentAmount?: number;
  paymentGroup?: string;
  paymentChannel?: string;
  paymentSubgroup?: string;
  updates?: Record<string, ExcelValue>;
}

export type JoinedRow = Record<string, ExcelValue> & {
  __rowId?: number;
  __reviewStatus?: ReviewStatus;
  __reconciliationObservation?: string;
  __reconciledAt?: string;
  __matchStatus: "CONCILIADO" | "SIN_PAGO_UNO";
  __joinKey: string;
  __pagoMatches: number;
  __qrMatches?: number;
  __differenceAmount: number | null;
  __qrDifferenceAmount?: number | null;
  __paymentGroup?: string;
  __paymentChannel?: string;
  __paymentSubgroup?: string;
  __saleAmount?: number;
};

export interface PagoColumnMeta {
  columnKey: string;
  header: string;
  excelColumn: string;
  shouldAdd: boolean;
  isCommonValue: boolean;
  menuLabels: MenuKey[];
}

export interface ReconciliationSummary {
  entradaRows: number;
  pagoRows: number;
  qrRows?: number;
  matchedRows: number;
  unmatchedRows: number;
  qrMatchedRows?: number;
  duplicatePagoKeys: number;
  duplicateQrKeys?: number;
  totalEntrada: number;
  totalProvincia?: number;
  totalEntradaUno?: number;
  totalPagoConciliado: number;
  totalQrConciliado?: number;
  diferenciaTotal: number;
  diferenciaQrTotal?: number;
}

export interface DashboardBucket {
  key: string;
  label: string;
  count: number;
  total: number;
  tickets?: number;
  schAmount?: number;
  provinceAmount?: number;
  entradaUnoAmount?: number;
}

export interface PaymentMethodByChannelBucket {
  channelKey: string;
  channelLabel: string;
  groupKey: string;
  groupLabel: string;
  subgroupKey: string;
  subgroupLabel: string;
  count: number;
  tickets?: number;
  schAmount?: number;
  total: number;
  provinceAmount: number;
  entradaUnoAmount: number;
}

export interface PaymentMethodByEstablishmentBucket {
  establishmentKey: string;
  establishmentLabel: string;
  channelKey: string;
  channelLabel: string;
  groupKey: string;
  groupLabel: string;
  subgroupKey: string;
  subgroupLabel: string;
  count: number;
  tickets?: number;
  schAmount?: number;
  total: number;
  provinceAmount: number;
  entradaUnoAmount: number;
}

export interface MonthBucket {
  value: string;
  label: string;
  count: number;
}

export interface DashboardResponse {
  totalRows: number;
  totalSales: number;
  provinceAmount: number;
  entradaUnoAmount: number;
  totalPagoConciliado: number;
  totalDifference: number;
  paymentGroups: DashboardBucket[];
  paymentSubgroups: DashboardBucket[];
  paymentChannels: DashboardBucket[];
  paymentChannelsPaid?: DashboardBucket[];
  paymentMethodsByChannel: PaymentMethodByChannelBucket[];
  paymentMethodsByChannelPaid?: PaymentMethodByChannelBucket[];
  paymentMethodsByEstablishmentPaid?: PaymentMethodByEstablishmentBucket[];
  establishmentsPaid?: DashboardBucket[];
  operationStatuses: DashboardBucket[];
  pendingReview: number;
  reviewedOk: number;
  observed: number;
  adjusted: number;
  reviewStatuses: DashboardBucket[];
  topProducts: DashboardBucket[];
  availableMonths?: MonthBucket[];
}

export type AppRole = "SUPERADMIN" | "ADMIN" | "OPERADOR" | "LECTOR";

export interface UserSession {
  id: string;
  email: string;
  fullName: string;
  role: AppRole;
  permissions?: Record<string, boolean>;
}

export interface LoginResponse {
  token: string;
  user: UserSession;
}

export interface RunMetadata {
  id: string;
  created_at?: string;
  entrada_filename?: string;
  pago_filename?: string;
  qr_filename?: string;
  summary: ReconciliationSummary;
  all_columns?: string[];
  pago_columns_to_add?: PagoColumnMeta[];
  qr_columns_to_add?: PagoColumnMeta[];
  step_status?: string;
  notes?: string;
  imported_by?: string;
  reconciliation_stage?: string;
  last_reconciled_at?: string;
  last_reconciled_by_name?: string;
}

export interface RowsResponse {
  rows: JoinedRow[];
  columns: string[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ImportResponse {
  runId: string;
  summary: ReconciliationSummary;
  allColumns: string[];
  pagoColumnsToAdd: PagoColumnMeta[];
  qrColumnsToAdd?: PagoColumnMeta[];
  stepStatus?: string;
  notes?: string;
}

export interface TableFilters {
  q: string;
  status: "todos" | "CONCILIADO" | "SIN_PAGO_UNO";
  column: string;
  value: string;
  paymentGroup: string;
  paymentChannel: string;
  paymentSubgroup: string;
  operationStatus: string;
  reviewStatus: string;
  selectedMonths: string[];
  page: number;
  pageSize: number;
}


export interface ManagedUser {
  id: string;
  createdAt?: string;
  email: string;
  fullName: string;
  role: AppRole;
  isActive: boolean;
}

export interface UserAuditLog {
  id: number;
  targetUserId?: string;
  targetEmail?: string;
  adminUserId?: string;
  adminEmail?: string;
  createdAt?: string;
  action: string;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  observation?: string | null;
}

export interface CreateUserPayload {
  email: string;
  fullName: string;
  role: AppRole;
  password: string;
  isActive: boolean;
}

export interface UpdateUserPayload {
  email?: string;
  fullName?: string;
  role?: AppRole;
  isActive?: boolean;
}


export interface RolePermissionDefinition {
  key: string;
  label: string;
  description?: string;
  category: string;
  sortOrder?: number;
  enabled: boolean;
  locked?: boolean;
}

export interface RoleDefinition {
  key: AppRole;
  label: string;
  description: string;
  locked?: boolean;
  permissions: RolePermissionDefinition[];
}

export interface UpdateRolePermissionsPayload {
  permissions: Record<string, boolean>;
}
