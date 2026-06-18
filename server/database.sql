CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'OPERADOR',
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id TEXT REFERENCES app_users(id),
  entrada_filename TEXT NOT NULL,
  pago_filename TEXT NOT NULL,
  qr_filename TEXT,
  pago_columns_to_add JSONB NOT NULL DEFAULT '[]'::jsonb,
  qr_columns_to_add JSONB NOT NULL DEFAULT '[]'::jsonb,
  all_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  step_status TEXT NOT NULL DEFAULT 'PASO_1_CONCILIACION_GUARDADA',
  notes TEXT,
  reconciliation_stage TEXT NOT NULL DEFAULT 'PASO_1_CONCILIACION_GUARDADA',
  last_reconciled_at TIMESTAMPTZ,
  last_reconciled_by TEXT REFERENCES app_users(id)
);

CREATE TABLE IF NOT EXISTS reconciliation_rows (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  join_key TEXT,
  match_status TEXT NOT NULL,
  pago_matches INTEGER NOT NULL DEFAULT 0,
  difference_amount NUMERIC,
  sale_amount NUMERIC NOT NULL DEFAULT 0,
  payment_group TEXT NOT NULL DEFAULT 'SIN_DEFINIR',
  payment_channel TEXT NOT NULL DEFAULT 'SIN_DEFINIR',
  payment_subgroup TEXT NOT NULL DEFAULT 'SIN_DEFINIR',
  establishment TEXT NOT NULL DEFAULT 'SIN_DEFINIR',
  province_amount NUMERIC NOT NULL DEFAULT 0,
  entrada_uno_amount NUMERIC NOT NULL DEFAULT 0,
  ticket_count NUMERIC NOT NULL DEFAULT 0,
  sch_amount NUMERIC NOT NULL DEFAULT 0,
  operation_month TEXT,
  operation_status TEXT,
  product TEXT,
  data JSONB NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'PENDIENTE',
  reconciliation_observation TEXT,
  reconciled_by TEXT REFERENCES app_users(id),
  reconciled_at TIMESTAMPTZ
);

ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS qr_filename TEXT;
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS qr_columns_to_add JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES app_users(id);
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS step_status TEXT NOT NULL DEFAULT 'PASO_1_CONCILIACION_GUARDADA';
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS reconciliation_stage TEXT NOT NULL DEFAULT 'PASO_1_CONCILIACION_GUARDADA';
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS last_reconciled_by TEXT REFERENCES app_users(id);

ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS sale_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS payment_group TEXT NOT NULL DEFAULT 'SIN_DEFINIR';
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS payment_channel TEXT NOT NULL DEFAULT 'SIN_DEFINIR';
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS payment_subgroup TEXT NOT NULL DEFAULT 'SIN_DEFINIR';
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS establishment TEXT NOT NULL DEFAULT 'SIN_DEFINIR';
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS province_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS entrada_uno_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS ticket_count NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS sch_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS operation_month TEXT;
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS operation_status TEXT;
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS product TEXT;
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'PENDIENTE';
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS reconciliation_observation TEXT;
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS reconciled_by TEXT REFERENCES app_users(id);
ALTER TABLE reconciliation_rows ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_user_created ON reconciliation_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_id ON reconciliation_rows(run_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_status ON reconciliation_rows(run_id, match_status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_join_key ON reconciliation_rows(run_id, join_key);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_payment_group ON reconciliation_rows(run_id, payment_group);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_payment_channel ON reconciliation_rows(run_id, payment_channel);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_payment_subgroup ON reconciliation_rows(run_id, payment_subgroup);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_establishment ON reconciliation_rows(run_id, establishment);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_operation_status ON reconciliation_rows(run_id, operation_status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_data_gin ON reconciliation_rows USING GIN (data jsonb_path_ops);


CREATE TABLE IF NOT EXISTS reconciliation_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  row_id BIGINT REFERENCES reconciliation_rows(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  observation TEXT
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_review_status ON reconciliation_rows(run_id, review_status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_audit_run_created ON reconciliation_audit_logs(run_id, created_at DESC);


-- Índices de performance para análisis operativo y filtros por mes.
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_month ON reconciliation_rows(run_id, operation_month);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_month_status ON reconciliation_rows(run_id, operation_month, operation_status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_month_channel ON reconciliation_rows(run_id, operation_month, payment_channel);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_month_channel_subgroup ON reconciliation_rows(run_id, operation_month, payment_channel, payment_subgroup);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_month_establishment ON reconciliation_rows(run_id, operation_month, establishment);
CREATE INDEX IF NOT EXISTS idx_reconciliation_rows_run_month_establishment_subgroup ON reconciliation_rows(run_id, operation_month, establishment, payment_subgroup);

-- Backfill liviano para expedientes existentes creados antes de operation_month.
UPDATE reconciliation_rows
SET operation_month = COALESCE(NULLIF(data->>'__operationMonth', ''), substring(COALESCE(data->>'Alta de Op.', data->>'Alta de Op', data->>'FechaDeCompra', data->>'FechaDePago', data->>'Fecha Funcion', '') from '^([0-9]{4}-[0-9]{2})'))
WHERE operation_month IS NULL OR operation_month = '';


-- Backfill para agrupación por establecimiento.
UPDATE reconciliation_rows
SET establishment = COALESCE(NULLIF(data->>'Establecimiento', ''), NULLIF(data->>'establecimiento', ''), 'SIN_DEFINIR')
WHERE establishment IS NULL OR establishment = '';


-- =========================================================
-- Usuarios, roles, permisos y auditoría administrativa
-- =========================================================
CREATE TABLE IF NOT EXISTS role_permission_catalog (
  permission_key TEXT,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_key TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS user_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  target_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  admin_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT NOT NULL,
  previous_value JSONB DEFAULT NULL,
  new_value JSONB DEFAULT NULL,
  observation TEXT
);

ALTER TABLE role_permission_catalog ADD COLUMN IF NOT EXISTS permission_key TEXT;
ALTER TABLE role_permission_catalog ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE role_permission_catalog ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE role_permission_catalog ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'General';
ALTER TABLE role_permission_catalog ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS role_key TEXT;
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS permission_key TEXT;
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE user_audit_logs ADD COLUMN IF NOT EXISTS target_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE user_audit_logs ADD COLUMN IF NOT EXISTS admin_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE user_audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE user_audit_logs ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE user_audit_logs ADD COLUMN IF NOT EXISTS previous_value JSONB DEFAULT NULL;
ALTER TABLE user_audit_logs ADD COLUMN IF NOT EXISTS new_value JSONB DEFAULT NULL;
ALTER TABLE user_audit_logs ADD COLUMN IF NOT EXISTS observation TEXT;

-- Limpieza de duplicados históricos antes de aplicar índices únicos.
DELETE FROM role_permission_catalog a
USING role_permission_catalog b
WHERE a.ctid < b.ctid
  AND a.permission_key = b.permission_key;

DELETE FROM role_permissions a
USING role_permissions b
WHERE a.ctid < b.ctid
  AND a.role_key = b.role_key
  AND a.permission_key = b.permission_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_role_permission_catalog_key_unique ON role_permission_catalog(permission_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_role_permissions_role_permission_unique ON role_permissions(role_key, permission_key);
CREATE INDEX IF NOT EXISTS idx_user_audit_logs_created ON user_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_audit_logs_target ON user_audit_logs(target_user_id);
CREATE INDEX IF NOT EXISTS idx_user_audit_logs_admin ON user_audit_logs(admin_user_id);

INSERT INTO role_permission_catalog (permission_key, label, description, category, sort_order) VALUES
('PROCESS_DOCUMENTS', 'Procesar documentos', 'Permite cargar Excel y generar expedientes de conciliación.', 'Conciliación', 10),
('OPEN_RUNS', 'Abrir expedientes', 'Permite abrir conciliaciones guardadas.', 'Conciliación', 20),
('EXPORT_EXCEL', 'Exportar Excel', 'Permite exportar archivos conciliados con filtros.', 'Conciliación', 30),
('VIEW_EXPEDIENTE', 'Ver expediente', 'Permite ver el archivo unificado completo y notas.', 'Vistas', 40),
('EDIT_UNIFIED_FILE', 'Editar archivo unificado', 'Permite editar filas del archivo unificado desde Expediente de conciliación.', 'Vistas', 45),
('VIEW_ENTRADA_UNO', 'Ver Conciliación Entrada UNO', 'Permite ver gráficos, tablas y resumen de Provincia por establecimiento.', 'Vistas', 50),
('VIEW_PRICE_CALCULATOR', 'Ver Calculadora de Precios', 'Permite acceder a la calculadora directa e inversa de tickets.', 'Vistas', 60),
('VIEW_AUDIT', 'Ver Auditoría', 'Permite ver la tabla de operaciones pagadas por establecimiento.', 'Auditoría', 70),
('MODIFY_ROW_STATUS', 'Modificar estado de registros', 'Permite modificar Estado, revisión y observaciones de filas.', 'Auditoría', 80),
('MANAGE_USERS', 'Administrar usuarios', 'Permite crear, editar, activar, desactivar usuarios y cambiar contraseñas.', 'Administración', 90),
('MANAGE_ROLES', 'Administrar roles', 'Permite ampliar o quitar permisos por rol.', 'Administración', 100),
('VIEW_USER_AUDIT', 'Ver auditoría de usuarios', 'Permite consultar movimientos administrativos de usuarios y roles.', 'Administración', 110)
ON CONFLICT (permission_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order;

-- SUPERADMIN: rol superior con todos los permisos.
INSERT INTO role_permissions (role_key, permission_key, enabled)
SELECT 'SUPERADMIN', permission_key, TRUE FROM role_permission_catalog
ON CONFLICT (role_key, permission_key) DO UPDATE SET enabled = TRUE;

-- ADMIN: administración general sin edición del archivo unificado por defecto.
INSERT INTO role_permissions (role_key, permission_key, enabled)
SELECT 'ADMIN', permission_key, permission_key <> 'EDIT_UNIFIED_FILE' FROM role_permission_catalog
ON CONFLICT (role_key, permission_key) DO UPDATE SET enabled = EXCLUDED.enabled;

INSERT INTO role_permissions (role_key, permission_key, enabled)
SELECT 'OPERADOR', permission_key,
  permission_key IN ('PROCESS_DOCUMENTS','OPEN_RUNS','EXPORT_EXCEL','VIEW_EXPEDIENTE','VIEW_ENTRADA_UNO','VIEW_PRICE_CALCULATOR')
FROM role_permission_catalog
ON CONFLICT (role_key, permission_key) DO NOTHING;

INSERT INTO role_permissions (role_key, permission_key, enabled)
SELECT 'LECTOR', permission_key,
  permission_key IN ('OPEN_RUNS','EXPORT_EXCEL','VIEW_EXPEDIENTE','VIEW_ENTRADA_UNO','VIEW_PRICE_CALCULATOR')
FROM role_permission_catalog
ON CONFLICT (role_key, permission_key) DO NOTHING;


-- Normalización puntual de establecimiento escrito sin acentos en los Excel originales.
UPDATE reconciliation_rows
SET establishment = 'Camping y Parque Acuático EL PRÉSTAMO'
WHERE establishment IN (
  'Camping y Parque Acuatico EL PRESTAMO',
  'Camping y Parque Acutico EL Prstamo',
  'El Camping y Parque Acuatico EL PRESTAMO',
  'El Camping y Parque Acutico el Prstamo'
);

UPDATE reconciliation_rows
SET data = jsonb_set(data, '{Establecimiento}', to_jsonb('Camping y Parque Acuático EL PRÉSTAMO'::text), true)
WHERE data->>'Establecimiento' IN (
  'Camping y Parque Acuatico EL PRESTAMO',
  'Camping y Parque Acutico EL Prstamo',
  'El Camping y Parque Acuatico EL PRESTAMO',
  'El Camping y Parque Acutico el Prstamo'
);
