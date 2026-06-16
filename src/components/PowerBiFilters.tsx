import { BarChart3, CreditCard, QrCode, Banknote, RotateCcw } from "lucide-react";
import type { DashboardBucket, DashboardResponse, TableFilters } from "../types/reconciliation";

interface Props {
  dashboard: DashboardResponse | null;
  loading: boolean;
  filters: TableFilters;
  onFiltersChange: (filters: TableFilters) => void;
}

function money(value: number): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value || 0);
}

function number(value: number): string {
  return new Intl.NumberFormat("es-AR").format(value || 0);
}

function patch(filters: TableFilters, patchValue: Partial<TableFilters>): TableFilters {
  return { ...filters, ...patchValue, page: 1 };
}

function findBucket(items: DashboardBucket[] | undefined, key: string): DashboardBucket {
  return items?.find((item) => item.key === key) ?? { key, label: key, count: 0, total: 0 };
}

const MAIN_SLICERS = [
  { key: "EFECTIVO", label: "Efectivo", icon: Banknote, mode: "group" as const },
  { key: "TARJETA_CREDITO_DEBITO_WEB", label: "Tarjeta crédito/débito Web", icon: CreditCard, mode: "subgroup" as const },
  { key: "TARJETA_CREDITO_DEBITO_BOLETERIA", label: "Tarjeta crédito/débito Boletería", icon: CreditCard, mode: "subgroup" as const },
  { key: "QR", label: "QR", icon: QrCode, mode: "group" as const },
];

export function PowerBiFilters({ dashboard, loading, filters, onFiltersChange }: Props) {
  const clear = () => onFiltersChange({ ...filters, q: "", status: "todos", column: "", value: "", paymentGroup: "todos", paymentChannel: "todos", paymentSubgroup: "todos", operationStatus: "todos", reviewStatus: "todos", page: 1 });

  function applyMainSlicer(item: typeof MAIN_SLICERS[number]) {
    const isActive = item.mode === "group" ? filters.paymentGroup === item.key : filters.paymentSubgroup === item.key;
    if (isActive) {
      onFiltersChange(patch(filters, { paymentGroup: "todos", paymentSubgroup: "todos" }));
      return;
    }
    if (item.mode === "group") onFiltersChange(patch(filters, { paymentGroup: item.key, paymentSubgroup: "todos" }));
    else onFiltersChange(patch(filters, { paymentGroup: "todos", paymentSubgroup: item.key }));
  }

  return (
    <div className="bi-panel">
      <div className="bi-header">
        <div>
          <span>Panel de consultas</span>
          <h3>Filtros tipo Power BI</h3>
          <p>Seleccioná una forma de pago, canal o estado y abajo se actualizan los totales y el detalle.</p>
        </div>
        <button className="clear-filters" onClick={clear}><RotateCcw size={16} /> Limpiar todo</button>
      </div>

      <div className="bi-kpis">
        <div><span>Total venta 110%</span><strong>{money(dashboard?.totalSales ?? 0)}</strong></div>
        <div><span>Provincia 100%</span><strong>{money(dashboard?.provinceAmount ?? 0)}</strong></div>
        <div><span>Entrada UNO 10%</span><strong>{money(dashboard?.entradaUnoAmount ?? 0)}</strong></div>
        <div><span>Registros</span><strong>{number(dashboard?.totalRows ?? 0)}</strong></div>
        <div><span>Pago conciliado</span><strong>{money(dashboard?.totalPagoConciliado ?? 0)}</strong></div>
        <div><span>Diferencia</span><strong>{money(dashboard?.totalDifference ?? 0)}</strong></div>
        <div><span>Pendientes revisión</span><strong>{number(dashboard?.pendingReview ?? 0)}</strong></div>
        <div><span>Observados / ajustados</span><strong>{number((dashboard?.observed ?? 0) + (dashboard?.adjusted ?? 0))}</strong></div>
      </div>

      <div className="distribution-panel">
        <div>
          <span>Regla de distribución</span>
          <strong>Total venta = 110%</strong>
          <p>Provincia 100% se toma desde la columna Precio Final S/Interés. Entrada UNO 10% se toma desde la columna Valor SCH.</p>
        </div>
        <div className="distribution-bars">
          <div className="distribution-row"><span>Provincia</span><strong>{money(dashboard?.provinceAmount ?? 0)}</strong></div>
          <div className="distribution-row"><span>Entrada UNO</span><strong>{money(dashboard?.entradaUnoAmount ?? 0)}</strong></div>
        </div>
      </div>

      <div className="slicer-grid main-slicers">
        {MAIN_SLICERS.map((item) => {
          const bucket = item.mode === "group" ? findBucket(dashboard?.paymentGroups, item.key) : findBucket(dashboard?.paymentSubgroups, item.key);
          const active = item.mode === "group" ? filters.paymentGroup === item.key : filters.paymentSubgroup === item.key;
          const Icon = item.icon;
          return (
            <button key={item.key} className={active ? "slicer active" : "slicer"} onClick={() => applyMainSlicer(item)} disabled={loading}>
              <div className="slicer-top"><Icon size={20} /><strong>{item.label}</strong></div>
              <span>{number(bucket.count)} operaciones</span>
              <strong className="slicer-total">{money(bucket.total)}</strong>
            </button>
          );
        })}
      </div>

      <div className="bi-selectors">
        <label>
          Canal
          <select value={filters.paymentChannel} onChange={(event) => onFiltersChange(patch(filters, { paymentChannel: event.target.value }))}>
            <option value="todos">Todos</option>
            {(dashboard?.paymentChannels ?? []).map((item) => <option key={item.key} value={item.key}>{item.label} · {money(item.total)}</option>)}
          </select>
        </label>

        <label>
          Estado Entrada UNO
          <select value={filters.operationStatus} onChange={(event) => onFiltersChange(patch(filters, { operationStatus: event.target.value }))}>
            <option value="todos">Todos</option>
            {(dashboard?.operationStatuses ?? []).map((item) => <option key={item.key} value={item.key}>{item.label || item.key} · {money(item.total)}</option>)}
          </select>
        </label>

        <label>
          Estado conciliación
          <select value={filters.status} onChange={(event) => onFiltersChange(patch(filters, { status: event.target.value as TableFilters["status"] }))}>
            <option value="todos">Todos</option>
            <option value="CONCILIADO">Conciliado</option>
            <option value="SIN_PAGO_UNO">Sin Pago UNO</option>
          </select>
        </label>

        <label>
          Estado revisión del documento
          <select value={filters.reviewStatus} onChange={(event) => onFiltersChange(patch(filters, { reviewStatus: event.target.value }))}>
            <option value="todos">Todos</option>
            {(dashboard?.reviewStatuses ?? []).map((item) => <option key={item.key} value={item.key}>{item.label} · {number(item.count)}</option>)}
          </select>
        </label>
      </div>

      <div className="mini-bars">
        <div className="mini-card">
          <h4>Resumen por forma de pago</h4>
          {(dashboard?.paymentGroups ?? []).map((item) => (
            <button key={item.key} className={filters.paymentGroup === item.key ? "mini-row active" : "mini-row"} onClick={() => onFiltersChange(patch(filters, { paymentGroup: filters.paymentGroup === item.key ? "todos" : item.key, paymentSubgroup: "todos" }))}>
              <span>{item.label}</span><strong>{money(item.total)}</strong>
            </button>
          ))}
        </div>
        <div className="mini-card">
          <h4>Productos con mayor venta</h4>
          {(dashboard?.topProducts ?? []).slice(0, 8).map((item) => (
            <div key={item.key} className="mini-row readonly"><span>{item.label || "Sin producto"}</span><strong>{money(item.total)}</strong></div>
          ))}
        </div>
      </div>
    </div>
  );
}
