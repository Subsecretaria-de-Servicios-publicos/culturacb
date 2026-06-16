import { useState } from "react";
import type { ExcelValue, JoinedRow, ManualRowUpdate, TableFilters } from "../types/reconciliation";

interface DataTableProps {
  runId: string;
  rows: JoinedRow[];
  columns: string[];
  total: number;
  loading: boolean;
  filters: TableFilters;
  onFiltersChange: (filters: TableFilters) => void;
  onUpdateRow?: (rowId: number, payload: ManualRowUpdate) => Promise<void>;
  canEdit?: boolean;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(value);
  return String(value);
}

function labelColumn(column: string): string {
  return column
    .replace("__rowId", "ID Fila")
    .replace("__reviewStatus", "Estado Revisión")
    .replace("__reconciliationObservation", "Observación Conciliación")
    .replace("__reconciledAt", "Fecha Revisión")
    .replace("__matchStatus", "Estado Conciliación")
    .replace("__differenceAmount", "Diferencia")
    .replace("__pagoMatches", "Cantidad Pagos Pago UNO")
    .replace("__qrMatches", "Cantidad Pagos QR")
    .replace("__joinKey", "Clave de Unión")
    .replace("__paymentGroup", "Medio de Pago")
    .replace("__paymentChannel", "Canal")
    .replace("__paymentSubgroup", "Consulta")
    .replace("__saleAmount", "Total Venta 110%")
    .replace("__provinceAmount", "Provincia 100%")
    .replace("__entradaUnoAmount", "Entrada UNO 10%");
}

function isEditableColumn(column: string): boolean {
  return !["__rowId", "__reconciledAt"].includes(column);
}

function valueToDraft(value: ExcelValue): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function draftToValue(value: string): ExcelValue {
  const clean = value.trim();
  if (clean === "") return "";
  const numericCandidate = clean.replace(/\./g, "").replace(",", ".");
  if (/^-?\d+(?:[.,]\d+)?$/.test(clean) && Number.isFinite(Number(numericCandidate))) {
    return Number(numericCandidate);
  }
  return value;
}

export function DataTable({ runId, rows, columns, total, loading, filters, onFiltersChange, onUpdateRow, canEdit = false }: DataTableProps) {
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const from = total === 0 ? 0 : (filters.page - 1) * filters.pageSize + 1;
  const to = Math.min(filters.page * filters.pageSize, total);
  const [editingRowId, setEditingRowId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingRowId, setSavingRowId] = useState<number | null>(null);
  const [rowError, setRowError] = useState("");

  function patchFilters(patch: Partial<TableFilters>) {
    onFiltersChange({ ...filters, ...patch });
  }

  function startEdit(row: JoinedRow) {
    const rowId = Number(row.__rowId);
    const nextDraft: Record<string, string> = {};
    for (const column of columns) {
      if (isEditableColumn(column)) nextDraft[column] = valueToDraft(row[column]);
    }
    setEditingRowId(rowId);
    setDraft(nextDraft);
    setRowError("");
  }

  function cancelEdit() {
    setEditingRowId(null);
    setDraft({});
    setRowError("");
  }

  async function saveEdit(row: JoinedRow) {
    if (!onUpdateRow) return;
    const rowId = Number(row.__rowId);
    if (!rowId) return;

    const updates: Record<string, ExcelValue> = {};
    for (const column of columns) {
      if (!isEditableColumn(column)) continue;
      const previous = valueToDraft(row[column]);
      const next = draft[column] ?? "";
      if (next !== previous) updates[column] = draftToValue(next);
    }

    if (Object.keys(updates).length === 0) {
      cancelEdit();
      return;
    }

    setSavingRowId(rowId);
    setRowError("");
    try {
      await onUpdateRow(rowId, {
        updates,
        reviewStatus: String(updates.__reviewStatus ?? row.__reviewStatus ?? "PENDIENTE") as ManualRowUpdate["reviewStatus"],
        observation: String(updates.__reconciliationObservation ?? row.__reconciliationObservation ?? ""),
      });
      cancelEdit();
    } catch (error) {
      setRowError(error instanceof Error ? error.message : "No se pudo guardar la fila.");
    } finally {
      setSavingRowId(null);
    }
  }

  return (
    <div className="data-panel">
      <div className="filter-title-row">
        <div>
          <span>Archivo unificado completo</span>
          <h3>Entrada UNO + Pago UNO + Pagos QR</h3>
          <p className="table-help">Esta grilla muestra el archivo nuevo generado en el Paso 1. Incluye todas las columnas originales del archivo principal, las columnas incorporadas de Pago UNO, las columnas amarillas de QR y los campos contables calculados. La consulta está paginada para mantener buen rendimiento, pero el expediente guardado conserva todos los datos.</p>
          {canEdit && <p className="table-help edit-help"><strong>Edición SUPERADMIN activa:</strong> al guardar una fila se actualiza el archivo unificado guardado en base y el Excel exportado sale con esos cambios.</p>}
        </div>
        <button
          className="clear-filters"
          onClick={() => onFiltersChange({ ...filters, q: "", column: "", value: "", reviewStatus: "todos", page: 1, pageSize: filters.pageSize })}
        >
          Limpiar filtros
        </button>
      </div>

      <div className="filter-bar improved">
        <div className="filter-field wide">
          <label>Buscar en todos los campos</label>
          <input
            value={filters.q}
            onChange={(event) => patchFilters({ q: event.target.value, page: 1 })}
            placeholder="Orden, cliente, DNI, email, lote, tarjeta, monto, QR, cupón..."
          />
        </div>

        <div className="filter-field">
          <label>Filtrar por columna</label>
          <select value={filters.column} onChange={(event) => patchFilters({ column: event.target.value, value: "", page: 1 })}>
            <option value="">Seleccionar columna</option>
            {columns.map((column) => (
              <option key={column} value={column}>{labelColumn(column)}</option>
            ))}
          </select>
        </div>

        <div className="filter-field">
          <label>Valor de la columna</label>
          <input
            value={filters.value}
            onChange={(event) => patchFilters({ value: event.target.value, page: 1 })}
            placeholder="Ej: Visa, QR, Pagada..."
            disabled={!filters.column}
          />
        </div>

        <div className="filter-field compact">
          <label>Filas por página</label>
          <select value={filters.pageSize} onChange={(event) => patchFilters({ pageSize: Number(event.target.value), page: 1 })}>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
          </select>
        </div>
      </div>

      <div className="table-status enhanced">
        <div>
          {loading ? "Consultando base de datos..." : <>Mostrando <strong>{from.toLocaleString("es-AR")}</strong> a <strong>{to.toLocaleString("es-AR")}</strong> de <strong>{total.toLocaleString("es-AR")}</strong> registros del archivo unificado.</>}
        </div>
        <div className="pagination">
          <button disabled={loading || filters.page <= 1} onClick={() => patchFilters({ page: filters.page - 1 })}>Anterior</button>
          <span>Página {filters.page.toLocaleString("es-AR")} / {totalPages.toLocaleString("es-AR")}</span>
          <button disabled={loading || filters.page >= totalPages} onClick={() => patchFilters({ page: filters.page + 1 })}>Siguiente</button>
        </div>
      </div>

      {rowError && <div className="error">{rowError}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {canEdit && <th className="edit-action-col">Edición</th>}
              {columns.map((column) => <th key={column}>{labelColumn(column)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const rowId = Number(row.__rowId);
              const editing = canEdit && editingRowId === rowId;
              return (
                <tr key={`${runId}-${rowId || row.__joinKey}-${index}`} className={`${row.__matchStatus === "CONCILIADO" ? "ok" : "warn"} ${editing ? "editing-row" : ""}`}>
                  {canEdit && (
                    <td className="edit-action-cell">
                      {editing ? (
                        <div className="row-edit-actions">
                          <button className="tiny-action" type="button" disabled={savingRowId === rowId} onClick={() => saveEdit(row)}>{savingRowId === rowId ? "Guardando..." : "Guardar"}</button>
                          <button className="tiny-action secondary" type="button" disabled={savingRowId === rowId} onClick={cancelEdit}>Cancelar</button>
                        </div>
                      ) : (
                        <button className="tiny-action" type="button" onClick={() => startEdit(row)}>Editar</button>
                      )}
                    </td>
                  )}
                  {columns.map((column) => {
                    const editable = editing && isEditableColumn(column);
                    return (
                      <td key={column} className={editable ? "editable-cell" : ""}>
                        {editable ? (
                          column === "__reviewStatus" ? (
                            <select
                              value={draft[column] ?? "PENDIENTE"}
                              onChange={(event) => setDraft((current) => ({ ...current, [column]: event.target.value }))}
                            >
                              <option value="PENDIENTE">PENDIENTE</option>
                              <option value="REVISADO_OK">REVISADO_OK</option>
                              <option value="OBSERVADO">OBSERVADO</option>
                              <option value="AJUSTADO">AJUSTADO</option>
                            </select>
                          ) : (
                            <input
                              value={draft[column] ?? ""}
                              onChange={(event) => setDraft((current) => ({ ...current, [column]: event.target.value }))}
                            />
                          )
                        ) : formatCell(row[column])}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={(canEdit ? columns.length + 1 : columns.length) || 1} className="empty-cell">No hay registros para los filtros aplicados.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
