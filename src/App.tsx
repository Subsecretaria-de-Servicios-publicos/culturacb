import { Fragment, FormEvent, useEffect, useState } from "react";
import { BarChart3, CheckCircle2, Database, FileSpreadsheet, Landmark, LogOut, RefreshCcw, ShieldCheck } from "lucide-react";
import { DataTable } from "./components/DataTable";
import { FileDrop } from "./components/FileDrop";
import { PowerBiFilters } from "./components/PowerBiFilters";
import { SummaryCards } from "./components/SummaryCards";
import { clearStoredToken, exportRunUrl, createUser, fetchDashboard, fetchMe, fetchRows, fetchRun, fetchRuns, fetchRoles, fetchUserAuditLogs, fetchUsers, getStoredToken, importReconciliation, login, updateRunNotes, updateRunRow, updateRolePermissions, updateUser, updateUserPassword } from "./services/api";
import type { AppRole, DashboardResponse, ImportResponse, ManagedUser, ManualRowUpdate, MenuKey, RowsResponse, RunMetadata, TableFilters, RoleDefinition, UserAuditLog, UserSession } from "./types/reconciliation";

type WorkTab = "expediente" | "conciliacionEntradaUno" | "calculadoraPrecios" | "auditoria" | "usuariosRoles" | "resumen" | "consultas" | "filtros";
type OperationalView = "entrada" | "pago" | "qr" | "conciliadas" | "sinPago";
import "./styles.css";

const MENUS: Array<{ key: MenuKey; label: string; description: string }> = [
  { key: "entrada1", label: "Entrada 1", description: "Conciliación Entrada UNO" },
  { key: "bordereaux", label: "Bordereaux", description: "Campos operativos y de lote" },
  { key: "conciliacionTC", label: "Conciliación TC", description: "Tarjeta, pago y diferencia" },
];

const FULL_FILE_MENU: MenuKey = "archivoCompleto";

const DEFAULT_FILTERS: TableFilters = {
  q: "",
  status: "todos",
  column: "",
  value: "",
  paymentGroup: "todos",
  paymentChannel: "todos",
  paymentSubgroup: "todos",
  operationStatus: "todos",
  reviewStatus: "todos",
  selectedMonths: [],
  page: 1,
  pageSize: 100,
};

function runToImportResponse(metadata: RunMetadata): ImportResponse {
  return {
    runId: metadata.id,
    summary: metadata.summary,
    allColumns: metadata.all_columns ?? [],
    pagoColumnsToAdd: metadata.pago_columns_to_add ?? [],
    qrColumnsToAdd: metadata.qr_columns_to_add ?? [],
    stepStatus: metadata.step_status,
    notes: metadata.notes,
  };
}

function formatDate(value?: string) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatNumber(value: number) {
  return value.toLocaleString("es-AR");
}

function money(value: number): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value || 0);
}

function formatMonthLabel(value: string): string {
  const [year, month] = String(value || '').split('-');
  const names = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const idx = Number(month) - 1;
  return idx >= 0 && idx < 12 ? `${names[idx]} ${year}` : value;
}

function normalizeKey(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function userHasPermission(user: UserSession | null, permissionKey: string): boolean {
  if (!user) return false;
  if (user.role === "SUPERADMIN") return true;
  return Boolean(user.permissions?.[permissionKey]);
}

function dedupeRolePermissions(role: RoleDefinition): RoleDefinition {
  const seen = new Set<string>();
  return {
    ...role,
    permissions: [...role.permissions]
      .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0) || a.label.localeCompare(b.label, "es"))
      .filter((permission) => {
        if (seen.has(permission.key)) return false;
        seen.add(permission.key);
        return true;
      }),
  };
}

function financialCostForBucket(subgroupKey: string, schAmount = 0): number {
  const key = normalizeKey(subgroupKey);
  if (key === "TARJETA_CREDITO_DEBITO_BOLETERIA") return schAmount * 0.05;
  if (key === "QR") return schAmount * 0.001;
  return 0;
}

function liquidationValueForBucket(subgroupKey: string, total = 0, entradaUnoAmount = 0, financialCost = 0): number {
  const key = normalizeKey(subgroupKey);
  const included = ["EFECTIVO", "TARJETA_CREDITO_DEBITO_BOLETERIA", "QR"].includes(key);
  if (!included) return 0;
  return entradaUnoAmount - financialCost;
}

function financialCostPercentage(financialCost = 0, entradaUnoAmount = 0): string {
  if (!entradaUnoAmount) return "0,00%";
  return new Intl.NumberFormat("es-AR", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(financialCost / entradaUnoAmount);
}


type ProvinceMatrixRowKey = "EFECTIVO" | "TC" | "QR";

function provinceMatrixGroup(subgroupKey: string, groupKey?: string): ProvinceMatrixRowKey | null {
  const subgroup = normalizeKey(subgroupKey || groupKey || "");
  if (subgroup === "EFECTIVO") return "EFECTIVO";
  if (subgroup === "QR") return "QR";
  // En este cuadro, TC debe tomar únicamente la tarjeta de Boletería.
  // La tarjeta WEB no forma parte de la fila TC.
  if (subgroup === "TARJETA_CREDITO_DEBITO_BOLETERIA") return "TC";
  return null;
}

function PieDonutChart({
  items,
  activeKey,
  onSelect,
  centerLabel,
}: {
  items: Array<{ key: string; label: string; count: number; total: number }>;
  activeKey: string;
  onSelect: (key: string) => void;
  centerLabel: string;
}) {
  const cleanItems = items.filter((item) => item.count > 0 || item.total > 0);
  const grandTotal = cleanItems.reduce((acc, item) => acc + Math.max(item.total || item.count, 0), 0);
  const fallbackTotal = cleanItems.reduce((acc, item) => acc + item.count, 0);
  const baseTotal = grandTotal > 0 ? grandTotal : Math.max(fallbackTotal, 1);
  const radius = 78;
  const circumference = 2 * Math.PI * radius;
  let accumulated = 0;

  if (cleanItems.length === 0) {
    return <div className="donut-empty">Sin datos para graficar.</div>;
  }

  return (
    <div className="donut-layout">
      <div className="donut-chart-wrap" aria-label={centerLabel}>
        <svg viewBox="0 0 220 220" className="donut-chart" role="img">
          <circle cx="110" cy="110" r={radius} className="donut-bg" />
          {cleanItems.map((item, index) => {
            const metric = Math.max(item.total || item.count, 0);
            const slice = metric / baseTotal;
            const dash = Math.max(slice * circumference, 0.1);
            const gap = circumference - dash;
            const offset = -accumulated * circumference;
            accumulated += slice;
            return (
              <circle
                key={item.key}
                cx="110"
                cy="110"
                r={radius}
                className={activeKey === item.key ? `donut-slice slice-${index % 8} active` : `donut-slice slice-${index % 8}`}
                strokeDasharray={`${dash} ${gap}`}
                strokeDashoffset={offset}
                onClick={() => onSelect(item.key)}
              />
            );
          })}
        </svg>
        <div className="donut-center">
          <strong>{formatNumber(cleanItems.reduce((acc, item) => acc + item.count, 0))}</strong>
          <span>{centerLabel}</span>
        </div>
      </div>
      <div className="donut-legend">
        {cleanItems.map((item, index) => {
          const active = activeKey === item.key;
          const percent = ((Math.max(item.total || item.count, 0) / baseTotal) * 100).toFixed(1);
          return (
            <button key={item.key} className={active ? "donut-legend-row active" : "donut-legend-row"} onClick={() => onSelect(item.key)}>
              <span className={`legend-dot slice-${index % 8}`} />
              <span className="legend-main">
                <strong>{item.label || item.key}</strong>
                <small>{formatNumber(item.count)} ops · {percent}%</small>
              </span>
              <span className="legend-money">{money(item.total)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}



function AllOperationsCircle({
  totalRows,
  totalSales,
  active,
  onSelectAll,
}: {
  totalRows: number;
  totalSales: number;
  active: boolean;
  onSelectAll: () => void;
}) {
  return (
    <article className={active ? "all-operations-card active" : "all-operations-card"}>
      <div className="chart-title">
        <span>Operaciones totales</span>
        <strong>Archivo Entrada UNO completo</strong>
      </div>
      <div className="all-operations-content">
        <button className="all-operations-donut" onClick={onSelectAll} aria-label="Ver todas las operaciones">
          <svg viewBox="0 0 220 220" className="donut-chart single-donut" role="img">
            <circle cx="110" cy="110" r="78" className="donut-bg" />
            <circle cx="110" cy="110" r="78" className="donut-slice slice-0 all-slice" strokeDasharray="490.09 0" strokeDashoffset="0" />
          </svg>
          <div className="donut-center all-center">
            <strong>{formatNumber(totalRows || 0)}</strong>
            <span>operaciones</span>
          </div>
        </button>
        <div className="all-operations-info">
          <span>Total general</span>
          <strong>{formatNumber(totalRows || 0)} operaciones</strong>
          <p>Representa el 100% de los registros procesados del archivo principal. Al presionar el gráfico se limpia la consulta y se vuelven a considerar todas las operaciones.</p>
          <div className="all-operations-total">
            <small>Total venta 110%</small>
            <b>{money(totalSales || 0)}</b>
          </div>
          <button className="tiny-action" onClick={onSelectAll}>{active ? "Vista completa activa" : "Ver todas"}</button>
        </div>
      </div>
    </article>
  );
}

function PaymentMethodsByChannelDetail({
  dashboard,
  filters,
  onSelect,
}: {
  dashboard: DashboardResponse | null;
  filters: TableFilters;
  onSelect: (patchValue: Partial<TableFilters>) => void;
}) {
  const rows = (dashboard?.paymentMethodsByChannel ?? [])
    .filter((item) => ["WEB", "BOLETERIA"].includes(normalizeKey(item.channelKey)))
    .sort((a, b) => {
      const channelOrder = normalizeKey(a.channelKey).localeCompare(normalizeKey(b.channelKey));
      if (channelOrder !== 0) return channelOrder;
      return (b.total || 0) - (a.total || 0);
    });

  const grouped = rows.reduce<Record<string, typeof rows>>((acc, item) => {
    const key = normalizeKey(item.channelKey) === "BOLETERIA" ? "BOLETERIA" : "WEB";
    acc[key] = acc[key] || [];
    acc[key].push(item);
    return acc;
  }, {});

  const channels = [
    { key: "BOLETERIA", label: "Boletería", rows: grouped.BOLETERIA ?? [] },
    { key: "WEB", label: "Web", rows: grouped.WEB ?? [] },
  ];

  return (
    <article className="payment-detail-card">
      <div className="chart-title">
        <span>Detalle de formas de pago</span>
        <strong>Boletería y Web</strong>
      </div>
      <p className="payment-detail-intro">
        Controla cómo se compone cada canal por forma de pago. Cada fila puede usarse como consulta para dejar activo el canal y la forma de pago correspondiente.
      </p>
      <div className="payment-channel-detail-grid">
        {channels.map((channel) => {
          const channelTotal = channel.rows.reduce((acc, item) => acc + (item.total || 0), 0);
          const channelOps = channel.rows.reduce((acc, item) => acc + (item.count || 0), 0);
          return (
            <section className="payment-channel-detail" key={channel.key}>
              <header>
                <div>
                  <span>Canal</span>
                  <strong>{channel.label}</strong>
                </div>
                <div className="channel-totals-mini">
                  <b>{formatNumber(channelOps)} ops</b>
                  <b>{money(channelTotal)}</b>
                </div>
              </header>
              <table className="payment-method-table">
                <thead>
                  <tr>
                    <th>Forma de pago</th>
                    <th>Tipo</th>
                    <th>Ops.</th>
                    <th>Total venta</th>
                    <th>Provincia</th>
                    <th>Entrada UNO</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {channel.rows.map((item) => {
                    const active = filters.paymentChannel === item.channelKey && filters.paymentSubgroup === item.subgroupKey;
                    return (
                      <tr key={`${item.channelKey}-${item.groupKey}-${item.subgroupKey}`} className={active ? "active" : ""}>
                        <td><strong>{item.groupLabel}</strong></td>
                        <td>{item.subgroupLabel}</td>
                        <td>{formatNumber(item.count)}</td>
                        <td>{money(item.total)}</td>
                        <td>{money(item.provinceAmount)}</td>
                        <td>{money(item.entradaUnoAmount)}</td>
                        <td>
                          <button
                            className="tiny-action"
                            onClick={() => onSelect(active
                              ? { paymentChannel: "todos", paymentGroup: "todos", paymentSubgroup: "todos" }
                              : { paymentChannel: item.channelKey, paymentGroup: item.groupKey, paymentSubgroup: item.subgroupKey })}
                          >
                            {active ? "Quitar" : "Ver"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {channel.rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="empty-payment-detail">Sin operaciones detectadas para este canal.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          );
        })}
      </div>
    </article>
  );
}

function EntradaUnoConciliacionTab({
  dashboard,
  filters,
  onFiltersChange,
}: {
  dashboard: DashboardResponse | null;
  rowsResponse: RowsResponse;
  loadingRows: boolean;
  filters: TableFilters;
  onFiltersChange: (filters: TableFilters) => void;
  onUpdateRow: (rowId: number, payload: ManualRowUpdate) => Promise<void>;
  runId: string;
}) {
  const statusBuckets = dashboard?.operationStatuses ?? [];
  const availableMonths = dashboard?.availableMonths ?? [];
  const [selectedEstablishment, setSelectedEstablishment] = useState("todos");

  // Los gráficos operativos deben tener la misma base: TODAS las operaciones del archivo principal.
  // La Tabla Operaciones Pagadas mantiene su propio criterio: solo Estado = Pagada.
  const allChannels = dashboard?.paymentChannels ?? [];
  const paidChannels = dashboard?.paymentChannelsPaid ?? [];

  const chartWeb = allChannels.find((item) => normalizeKey(item.key) === "WEB") ?? { key: "WEB", label: "Web", count: 0, total: 0, tickets: 0, schAmount: 0 };
  const chartBoleteria = allChannels.find((item) => normalizeKey(item.key) === "BOLETERIA") ?? { key: "BOLETERIA", label: "Boletería", count: 0, total: 0, tickets: 0, schAmount: 0 };
  const chartSinDefinir = allChannels.find((item) => normalizeKey(item.key) === "SIN_DEFINIR") ?? { key: "SIN_DEFINIR", label: "Sin definir", count: 0, total: 0, tickets: 0, schAmount: 0 };
  const channelChartRows = [chartBoleteria, chartWeb, chartSinDefinir];

  const paidWeb = paidChannels.find((item) => normalizeKey(item.key) === "WEB") ?? { key: "WEB", label: "Web", count: 0, total: 0, tickets: 0, schAmount: 0 };
  const paidBoleteria = paidChannels.find((item) => normalizeKey(item.key) === "BOLETERIA") ?? { key: "BOLETERIA", label: "Boletería", count: 0, total: 0, tickets: 0, schAmount: 0 };
  const paidSinDefinir = paidChannels.find((item) => normalizeKey(item.key) === "SIN_DEFINIR") ?? { key: "SIN_DEFINIR", label: "Sin definir", count: 0, total: 0, tickets: 0, schAmount: 0 };
  const channelPaidRows = [paidBoleteria, paidWeb, paidSinDefinir];

  const paymentDetailsByChannel = (dashboard?.paymentMethodsByChannelPaid ?? [])
    .filter((item) => ["BOLETERIA", "WEB"].includes(normalizeKey(item.channelKey)))
    .sort((a, b) => {
      const channelOrder = normalizeKey(a.channelKey).localeCompare(normalizeKey(b.channelKey));
      if (channelOrder !== 0) return channelOrder;
      return (b.total || 0) - (a.total || 0);
    })
    .reduce<Record<string, NonNullable<DashboardResponse["paymentMethodsByChannel"]>>>((acc, item) => {
      const key = normalizeKey(item.channelKey) === "BOLETERIA" ? "BOLETERIA" : "WEB";
      acc[key] = acc[key] || [];
      acc[key].push(item);
      return acc;
    }, {});

  const establishmentsPaid = dashboard?.establishmentsPaid ?? [];
  const establishmentRows = establishmentsPaid
    .filter((item) => selectedEstablishment === "todos" || String(item.key) === selectedEstablishment)
    .sort((a, b) => (b.total || 0) - (a.total || 0));

  const paymentDetailsByEstablishment = (dashboard?.paymentMethodsByEstablishmentPaid ?? [])
    .filter((item) => selectedEstablishment === "todos" || String(item.establishmentKey) === selectedEstablishment)
    .sort((a, b) => {
      const establishmentOrder = String(a.establishmentKey || "").localeCompare(String(b.establishmentKey || ""));
      if (establishmentOrder !== 0) return establishmentOrder;
      const channelOrder = normalizeKey(a.channelKey || "SIN_DEFINIR").localeCompare(normalizeKey(b.channelKey || "SIN_DEFINIR"));
      if (channelOrder !== 0) return channelOrder;
      return (b.total || 0) - (a.total || 0);
    })
    .reduce<Record<string, Record<string, NonNullable<DashboardResponse["paymentMethodsByEstablishmentPaid"]>>>>((acc, item) => {
      const establishmentKey = String(item.establishmentKey || "SIN_DEFINIR");
      const channelKey = normalizeKey(item.channelKey || "SIN_DEFINIR");
      acc[establishmentKey] = acc[establishmentKey] || {};
      acc[establishmentKey][channelKey] = acc[establishmentKey][channelKey] || [];
      acc[establishmentKey][channelKey].push(item);
      return acc;
    }, {});

  function patch(patchValue: Partial<TableFilters>) {
    onFiltersChange({ ...filters, ...patchValue, page: 1 });
  }

  function selectStatus(statusKey: string) {
    patch({ operationStatus: filters.operationStatus === statusKey ? "todos" : statusKey });
  }

  function selectChannel(channelKey: string) {
    patch({ paymentChannel: filters.paymentChannel === channelKey ? "todos" : channelKey });
  }

  function toggleMonth(monthValue: string) {
    const exists = filters.selectedMonths.includes(monthValue);
    patch({ selectedMonths: exists ? filters.selectedMonths.filter((item) => item !== monthValue) : [...filters.selectedMonths, monthValue] });
  }

  const tableTotals = channelPaidRows.reduce((acc, item) => {
    const channelKey = normalizeKey(item.key);
    const province = item.provinceAmount ?? 0;
    const entradaUno = item.entradaUnoAmount ?? 0;
    const details = paymentDetailsByChannel[channelKey] ?? [];
    const financialCost = details.reduce((sum, detail) => sum + financialCostForBucket(detail.subgroupKey, detail.schAmount || 0), 0);
    const valorLiquidar = details.reduce((sum, detail) => {
      const cost = financialCostForBucket(detail.subgroupKey, detail.schAmount || 0);
      return sum + liquidationValueForBucket(detail.subgroupKey, detail.total || 0, detail.entradaUnoAmount || 0, cost);
    }, 0);

    acc.count += item.count || 0;
    acc.tickets += item.tickets || 0;
    acc.total += item.total || 0;
    acc.province += province;
    acc.entradaUno += entradaUno;
    acc.sch += item.schAmount || 0;
    acc.financialCost += financialCost;
    acc.valorLiquidar += valorLiquidar;
    return acc;
  }, {
    count: 0,
    tickets: 0,
    total: 0,
    province: 0,
    entradaUno: 0,
    sch: 0,
    financialCost: 0,
    valorLiquidar: 0,
  });

  function summarizeEstablishmentChannel(details: NonNullable<DashboardResponse["paymentMethodsByEstablishmentPaid"]>) {
    return details.reduce((acc, detail) => {
      const financialCost = financialCostForBucket(detail.subgroupKey, detail.schAmount || 0);
      acc.count += detail.count || 0;
      acc.tickets += detail.tickets || 0;
      acc.total += detail.total || 0;
      acc.province += detail.provinceAmount || 0;
      acc.entradaUno += detail.entradaUnoAmount || 0;
      acc.financialCost += financialCost;
      acc.valorLiquidar += liquidationValueForBucket(detail.subgroupKey, detail.total || 0, detail.entradaUnoAmount || 0, financialCost);
      return acc;
    }, {
      count: 0,
      tickets: 0,
      total: 0,
      province: 0,
      entradaUno: 0,
      financialCost: 0,
      valorLiquidar: 0,
    });
  }

  const establishmentTotals = establishmentRows.reduce((acc, item) => {
    const establishmentKey = String(item.key || "SIN_DEFINIR");
    const channels = paymentDetailsByEstablishment[establishmentKey] ?? {};
    Object.values(channels).forEach((details) => {
      const summary = summarizeEstablishmentChannel(details);
      acc.count += summary.count;
      acc.tickets += summary.tickets;
      acc.total += summary.total;
      acc.province += summary.province;
      acc.entradaUno += summary.entradaUno;
      acc.financialCost += summary.financialCost;
      acc.valorLiquidar += summary.valorLiquidar;
    });
    return acc;
  }, {
    count: 0,
    tickets: 0,
    total: 0,
    province: 0,
    entradaUno: 0,
    financialCost: 0,
    valorLiquidar: 0,
  });


  const establishmentColumnOrder = [
    "Teatro Provincial Juan Carlos Saravia",
    "Museo Güemes",
    "Museo de la Vid y el Vino",
    "Museo de Arqueología de Alta Montaña",
    "Museo Arqueológico de Cachi",
    "Usina Cultural",
    "Complejo Museológico Explora Salta",
    "Casa de la Cultura",
    "Museo de Arte MAC",
    "Museo de Bellas Artes",
    "Museo Antropológico",
    "Camping y Parque Acuático EL PRÉSTAMO",
  ];

  function normalizeEstablishmentName(value: string): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
  }

  const establishmentOrderMap = new Map(
    establishmentColumnOrder.map((name, index) => [normalizeEstablishmentName(name), index])
  );

  const provinceMatrixColumns = establishmentRows
    .map((item) => ({
      key: String(item.key || "SIN_DEFINIR"),
      label: String(item.label || item.key || "Sin definir"),
    }))
    .sort((a, b) => {
      const orderA = establishmentOrderMap.get(normalizeEstablishmentName(a.label));
      const orderB = establishmentOrderMap.get(normalizeEstablishmentName(b.label));

      if (orderA !== undefined && orderB !== undefined) return orderA - orderB;
      if (orderA !== undefined) return -1;
      if (orderB !== undefined) return 1;
      return a.label.localeCompare(b.label, "es");
    });

  const provinceMatrixBase = provinceMatrixColumns.reduce<Record<string, Record<ProvinceMatrixRowKey, number>>>((acc, item) => {
    acc[item.key] = { EFECTIVO: 0, TC: 0, QR: 0 };
    return acc;
  }, {});

  (dashboard?.paymentMethodsByEstablishmentPaid ?? [])
    .filter((item) => selectedEstablishment === "todos" || String(item.establishmentKey) === selectedEstablishment)
    .forEach((item) => {
      const estKey = String(item.establishmentKey || "SIN_DEFINIR");
      if (!provinceMatrixBase[estKey]) return;
      const rowKey = provinceMatrixGroup(String(item.subgroupKey || ""), String(item.groupKey || ""));
      if (!rowKey) return;
      provinceMatrixBase[estKey][rowKey] += Number(item.provinceAmount || 0);
    });

  const provinceMatrixRows = [
    { key: "EFECTIVO", label: "Efectivo" },
    { key: "TC", label: "TC" },
    { key: "QR", label: "QR" },
    { key: "ENTRADAS", label: "Entradas" },
    { key: "DIEZ", label: "10%" },
  ].map((row) => {
    const values = provinceMatrixColumns.map((column) => {
      const base = provinceMatrixBase[column.key] ?? { EFECTIVO: 0, TC: 0, QR: 0 };
      const entradas = base.EFECTIVO + base.TC + base.QR;
      if (row.key === "EFECTIVO") return base.EFECTIVO;
      if (row.key === "TC") return base.TC;
      if (row.key === "QR") return base.QR;
      if (row.key === "ENTRADAS") return entradas;
      return entradas * 0.1;
    });
    return {
      ...row,
      values,
      total: values.reduce((acc, value) => acc + value, 0),
    };
  });

  return (
    <div className="work-tab-panel entrada-uno-panel">
      <div className="work-header compact-header">
        <div>
          <span>Conciliación Entrada UNO</span>
          <h2>Análisis operativo del archivo principal</h2>
          <p>Los gráficos de estados y canal muestran todas las operaciones del archivo principal. La tabla inferior analiza únicamente operaciones con estado Pagada para determinar totales, costo financiero y valor a liquidar.</p>
        </div>
      </div>

      <article className="month-filter-card">
        <div className="chart-title">
          <span>Análisis por mes</span>
          <strong>Seleccioná uno o varios meses</strong>
        </div>
        <div className="month-filter-actions">
          <button className="tiny-action" onClick={() => patch({ selectedMonths: [] })}>Todos los meses</button>
          {!!filters.selectedMonths.length && <button className="tiny-action" onClick={() => patch({ selectedMonths: [] })}>Limpiar selección</button>}
        </div>
        <div className="month-filter-list">
          {availableMonths.map((month) => {
            const active = filters.selectedMonths.includes(month.value);
            return (
              <button key={month.value} type="button" className={`month-chip ${active ? 'active' : ''}`} onClick={() => toggleMonth(month.value)}>
                <strong>{month.label || formatMonthLabel(month.value)}</strong>
                <span>{formatNumber(month.count)} ops</span>
              </button>
            );
          })}
          {availableMonths.length === 0 && <div className="month-chip-empty">No se detectaron meses para este expediente.</div>}
        </div>
      </article>

      <section className="entrada-uno-charts-grid entrada-uno-charts-first">
        <article className="chart-card state-chart-card circular-card">
          <div className="chart-title">
            <span>Gráfico circular de estados</span>
            <strong>Pagados, rechazados y otros estados</strong>
          </div>
          <PieDonutChart
            items={statusBuckets}
            activeKey={filters.operationStatus}
            onSelect={selectStatus}
            centerLabel="operaciones"
          />
        </article>

        <article className="chart-card state-chart-card circular-card">
          <div className="chart-title">
            <span>Gráfico circular por canal</span>
            <strong>Boletería / Web</strong>
          </div>
          <PieDonutChart
            items={channelChartRows}
            activeKey={filters.paymentChannel}
            onSelect={selectChannel}
            centerLabel="operaciones"
          />
        </article>
      </section>

      <article className="channel-summary-card channel-summary-card-top">
        <div className="chart-title">
          <span>Tabla Operaciones Pagadas</span>
          <strong>Boletería / Web</strong>
        </div>
        <div className="channel-summary-table-wrap">
          <table className="channel-summary-table channel-summary-table-large channel-summary-hierarchy-table">
          <thead>
            <tr>
              <th>Canal / forma de pago</th>
              <th>Operaciones</th>
              <th>Cant. Tickets</th>
              <th>Total venta 110%</th>
              <th>Provincia 100%</th>
              <th>Entrada UNO 10%</th>
              <th>Costo Financiero</th>
              <th>Valor a Liquidar</th>
              <th>% Costo Financiero</th>
              <th>Consulta</th>
            </tr>
          </thead>
          <tbody>
            {channelPaidRows.map((item) => {
              const channelKey = normalizeKey(item.key);
              const province = item.provinceAmount ?? (item.total || 0) / 1.1;
              const entradaUno = item.entradaUnoAmount ?? (item.total || 0) - province;
              const details = paymentDetailsByChannel[channelKey] ?? [];
              const financialCost = details.reduce((acc, detail) => acc + financialCostForBucket(detail.subgroupKey, detail.schAmount || 0), 0);
              const valorLiquidar = details.reduce((acc, detail) => {
                const cost = financialCostForBucket(detail.subgroupKey, detail.schAmount || 0);
                return acc + liquidationValueForBucket(detail.subgroupKey, detail.total || 0, detail.entradaUnoAmount || 0, cost);
              }, 0);
              return (
                <Fragment key={item.key}>
                  <tr key={item.key} className={`channel-parent-row ${filters.paymentChannel === item.key ? "active" : ""}`}>
                    <td><strong>{item.label || item.key}</strong></td>
                    <td>{formatNumber(item.count)}</td>
                    <td>{formatNumber(item.tickets || 0)}</td>
                    <td>{money(item.total)}</td>
                    <td>{money(province)}</td>
                    <td>{money(entradaUno)}</td>
                    <td>{money(financialCost)}</td>
                    <td>{money(valorLiquidar)}</td>
                    <td>{financialCostPercentage(financialCost, entradaUno)}</td>
                    <td><button className="tiny-action" onClick={() => selectChannel(item.key)}>{filters.paymentChannel === item.key ? "Quitar" : "Ver"}</button></td>
                  </tr>
                  {details.map((detail) => {
                    const active = filters.paymentChannel === detail.channelKey && filters.paymentSubgroup === detail.subgroupKey;
                    const detailFinancialCost = financialCostForBucket(detail.subgroupKey, detail.schAmount || 0);
                    const detailValorLiquidar = liquidationValueForBucket(detail.subgroupKey, detail.total || 0, detail.entradaUnoAmount || 0, detailFinancialCost);
                    return (
                      <tr key={`${detail.channelKey}-${detail.groupKey}-${detail.subgroupKey}`} className={`channel-child-row ${active ? "active" : ""}`}>
                        <td>
                          <span className="sublevel-marker">↳</span>
                          <strong>{detail.groupLabel}</strong>
                          <small>{detail.subgroupLabel}</small>
                        </td>
                        <td>{formatNumber(detail.count)}</td>
                        <td>{formatNumber(detail.tickets || 0)}</td>
                        <td>{money(detail.total)}</td>
                        <td>{money(detail.provinceAmount)}</td>
                        <td>{money(detail.entradaUnoAmount)}</td>
                        <td>{money(detailFinancialCost)}</td>
                        <td>{money(detailValorLiquidar)}</td>
                        <td>{financialCostPercentage(detailFinancialCost, detail.entradaUnoAmount || 0)}</td>
                        <td>
                          <button
                            className="tiny-action"
                            onClick={() => patch(active
                              ? { paymentChannel: "todos", paymentGroup: "todos", paymentSubgroup: "todos" }
                              : { paymentChannel: detail.channelKey, paymentGroup: detail.groupKey, paymentSubgroup: detail.subgroupKey })}
                          >
                            {active ? "Quitar" : "Ver"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {details.length === 0 && ["BOLETERIA", "WEB"].includes(channelKey) && (
                    <tr key={`${item.key}-empty`} className="channel-child-row channel-child-empty">
                      <td colSpan={10}>Sin detalle de formas de pago detectado para este canal.</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="channel-total-row">
              <td><strong>Total general</strong></td>
              <td>{formatNumber(tableTotals.count)}</td>
              <td>{formatNumber(tableTotals.tickets)}</td>
              <td>{money(tableTotals.total)}</td>
              <td>{money(tableTotals.province)}</td>
              <td>{money(tableTotals.entradaUno)}</td>
              <td>{money(tableTotals.financialCost)}</td>
              <td>{money(tableTotals.valorLiquidar)}</td>
              <td>{financialCostPercentage(tableTotals.financialCost, tableTotals.entradaUno)}</td>
              <td>—</td>
            </tr>
          </tfoot>
        </table>
        </div>
        <div className="channel-help">
          <strong>Criterio:</strong> los gráficos superiores muestran todas las operaciones del archivo principal. Esta tabla toma solo operaciones con estado “Pagada”. El costo financiero se calcula sobre Service Charge: 5% para TARJETA_CREDITO_DEBITO_BOLETERIA y 0,1% para QR. El valor a liquidar se calcula sobre efectivo, tarjeta boletería y QR.
        </div>
      </article>

      <article className="channel-summary-card channel-summary-card-top province-matrix-card">
        <div className="chart-title">
          <span>Resumen Provincia por establecimiento</span>
          <strong>Efectivo / TC / QR + 10% lineal</strong>
        </div>

        <div
          className="province-matrix-fixed-layout"
          style={{
            display: "grid",
            gridTemplateColumns: "220px minmax(0, 1fr)",
            overflow: "hidden",
            border: "1px solid #dbe7fb",
            borderRadius: "16px",
            background: "#ffffff",
            maxWidth: "100%",
          }}
        >
          <div
            className="province-matrix-fixed-col"
            style={{
              width: "220px",
              minWidth: "220px",
              maxWidth: "220px",
              background: "#f8fbff",
              borderRight: "1px solid #dbe7fb",
              boxShadow: "8px 0 14px rgba(15, 23, 42, 0.10)",
              zIndex: 10,
            }}
          >
            <div className="province-matrix-fixed-cell header" style={{ height: "44px", padding: "12px 14px", borderBottom: "1px solid #e5edf8", display: "flex", alignItems: "center", fontWeight: 800, color: "#0f172a", background: "#f1f5fb", whiteSpace: "nowrap" }}>
              Concepto
            </div>
            {provinceMatrixRows.map((row) => (
              <div
                key={`fixed-${row.key}`}
                className={`province-matrix-fixed-cell ${row.key === "ENTRADAS" || row.key === "DIEZ" ? "emphasis" : ""}`}
                style={{
                  height: "44px",
                  padding: "12px 14px",
                  borderBottom: "1px solid #e5edf8",
                  display: "flex",
                  alignItems: "center",
                  fontWeight: 800,
                  color: "#0f172a",
                  background: row.key === "ENTRADAS" || row.key === "DIEZ" ? "#eef5ff" : "#f8fbff",
                  whiteSpace: "nowrap",
                }}
              >
                {row.label}
              </div>
            ))}
          </div>

          <div
            className="province-matrix-scroll-area"
            style={{ overflowX: "auto", overflowY: "hidden", minWidth: 0, maxWidth: "100%" }}
          >
            <table
              className="province-matrix-table-scroll"
              style={{ borderCollapse: "separate", borderSpacing: 0, width: "max-content", minWidth: "100%" }}
            >
              <thead>
                <tr>
                  {provinceMatrixColumns.map((column) => (
                    <th
                      key={`province-col-${column.key}`}
                      style={{
                        height: "44px",
                        padding: "12px 14px",
                        borderBottom: "1px solid #e5edf8",
                        background: "#f1f5fb",
                        color: "#0f172a",
                        fontWeight: 800,
                        whiteSpace: "normal",
                        lineHeight: 1.2,
                        minWidth: "150px",
                        textAlign: "left",
                        position: "static",
                      }}
                    >
                      {column.label}
                    </th>
                  ))}
                  <th
                    style={{
                      height: "44px",
                      padding: "12px 14px",
                      borderBottom: "1px solid #e5edf8",
                      background: "#f1f5fb",
                      color: "#0f172a",
                      fontWeight: 800,
                      minWidth: "120px",
                      textAlign: "left",
                      position: "static",
                    }}
                  >
                    TOTAL
                  </th>
                </tr>
              </thead>
              <tbody>
                {provinceMatrixRows.map((row) => (
                  <tr key={`province-row-${row.key}`}>
                    {row.values.map((value, index) => (
                      <td
                        key={`province-cell-${row.key}-${provinceMatrixColumns[index]?.key || index}`}
                        style={{
                          height: "44px",
                          padding: "12px 14px",
                          borderBottom: "1px solid #e5edf8",
                          background: row.key === "ENTRADAS" || row.key === "DIEZ" ? "#eef5ff" : "#ffffff",
                          color: "#0f172a",
                          fontWeight: row.key === "ENTRADAS" || row.key === "DIEZ" ? 800 : 400,
                          whiteSpace: "nowrap",
                          minWidth: "150px",
                          position: "static",
                        }}
                      >
                        {money(value)}
                      </td>
                    ))}
                    <td
                      style={{
                        height: "44px",
                        padding: "12px 14px",
                        borderBottom: "1px solid #e5edf8",
                        background: row.key === "ENTRADAS" || row.key === "DIEZ" ? "#eef5ff" : "#ffffff",
                        color: "#0f172a",
                        fontWeight: 800,
                        whiteSpace: "nowrap",
                        minWidth: "120px",
                        position: "static",
                      }}
                    >
                      {money(row.total)}
                    </td>
                  </tr>
                ))}
                {provinceMatrixColumns.length === 0 && (
                  <tr>
                    <td
                      style={{
                        height: "44px",
                        padding: "12px 14px",
                        borderBottom: "1px solid #e5edf8",
                        color: "#0f172a",
                      }}
                    >
                      Sin establecimientos detectados para los filtros seleccionados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="channel-help">
          <strong>Criterio:</strong> se toma el valor de <strong>Provincia 100%</strong> por establecimiento y forma de pago. La fila <strong>TC</strong> toma solo <strong>TARJETA_CREDITO_DEBITO_BOLETERIA</strong>. La fila <strong>Entradas</strong> suma Efectivo + TC + QR, y la fila <strong>10%</strong> calcula el 10% lineal sobre esa suma.
        </div>
      </article>

      <div className="entrada-uno-current-query">
        <strong>Consulta activa:</strong>{" "}
        Estado {filters.operationStatus === "todos" ? "Todos" : filters.operationStatus} · Canal {filters.paymentChannel === "todos" ? "Todos" : filters.paymentChannel} · Meses {filters.selectedMonths.length ? filters.selectedMonths.map(formatMonthLabel).join(', ') : 'Todos'}.
        La grilla completa del archivo unificado queda en el tab <strong>Expediente de conciliación</strong>.
      </div>
    </div>
  );
}


function AuditoriaTab({
  dashboard,
}: {
  dashboard: DashboardResponse | null;
}) {
  const [selectedEstablishment, setSelectedEstablishment] = useState("todos");
  const establishmentsPaid = dashboard?.establishmentsPaid ?? [];
  const establishmentRows = establishmentsPaid
    .filter((item) => selectedEstablishment === "todos" || String(item.key) === selectedEstablishment)
    .sort((a, b) => (b.total || 0) - (a.total || 0));

  const paymentDetailsByEstablishment = (dashboard?.paymentMethodsByEstablishmentPaid ?? [])
    .filter((item) => selectedEstablishment === "todos" || String(item.establishmentKey) === selectedEstablishment)
    .sort((a, b) => {
      const establishmentOrder = String(a.establishmentKey || "").localeCompare(String(b.establishmentKey || ""));
      if (establishmentOrder !== 0) return establishmentOrder;
      const channelOrder = normalizeKey(a.channelKey || "SIN_DEFINIR").localeCompare(normalizeKey(b.channelKey || "SIN_DEFINIR"));
      if (channelOrder !== 0) return channelOrder;
      return (b.total || 0) - (a.total || 0);
    })
    .reduce<Record<string, Record<string, NonNullable<DashboardResponse["paymentMethodsByEstablishmentPaid"]>>>>((acc, item) => {
      const establishmentKey = String(item.establishmentKey || "SIN_DEFINIR");
      const channelKey = normalizeKey(item.channelKey || "SIN_DEFINIR");
      acc[establishmentKey] = acc[establishmentKey] || {};
      acc[establishmentKey][channelKey] = acc[establishmentKey][channelKey] || [];
      acc[establishmentKey][channelKey].push(item);
      return acc;
    }, {});

  function summarizeEstablishmentChannel(details: NonNullable<DashboardResponse["paymentMethodsByEstablishmentPaid"]>) {
    return details.reduce((acc, detail) => {
      const financialCost = financialCostForBucket(detail.subgroupKey, detail.schAmount || 0);
      acc.count += detail.count || 0;
      acc.tickets += detail.tickets || 0;
      acc.total += detail.total || 0;
      acc.province += detail.provinceAmount || 0;
      acc.entradaUno += detail.entradaUnoAmount || 0;
      acc.financialCost += financialCost;
      acc.valorLiquidar += liquidationValueForBucket(detail.subgroupKey, detail.total || 0, detail.entradaUnoAmount || 0, financialCost);
      return acc;
    }, {
      count: 0,
      tickets: 0,
      total: 0,
      province: 0,
      entradaUno: 0,
      financialCost: 0,
      valorLiquidar: 0,
    });
  }

  const establishmentTotals = establishmentRows.reduce((acc, item) => {
    const establishmentKey = String(item.key || "SIN_DEFINIR");
    const channels = paymentDetailsByEstablishment[establishmentKey] ?? {};
    Object.values(channels).forEach((details) => {
      const summary = summarizeEstablishmentChannel(details);
      acc.count += summary.count;
      acc.tickets += summary.tickets;
      acc.total += summary.total;
      acc.province += summary.province;
      acc.entradaUno += summary.entradaUno;
      acc.financialCost += summary.financialCost;
      acc.valorLiquidar += summary.valorLiquidar;
    });
    return acc;
  }, {
    count: 0,
    tickets: 0,
    total: 0,
    province: 0,
    entradaUno: 0,
    financialCost: 0,
    valorLiquidar: 0,
  });

  return (
    <div className="work-tab-panel entrada-uno-panel auditoria-panel">
      <div className="work-header compact-header">
        <div>
          <span>Auditoría</span>
          <h2>Operaciones pagadas por establecimiento</h2>
          <p>Esta pantalla concentra la tabla de auditoría por Establecimiento → Canal → Forma de pago.</p>
        </div>
      </div>
      <article className="channel-summary-card channel-summary-card-top establishment-summary-card">
        <div className="chart-title">
          <span>Tabla Operaciones Pagadas por establecimiento</span>
          <strong>Establecimientos</strong>
        </div>
        <div className="establishment-filter-row">
          <label>
            <span>Filtrar por establecimiento</span>
            <select value={selectedEstablishment} onChange={(event) => setSelectedEstablishment(event.target.value)}>
              <option value="todos">Todos los establecimientos</option>
              {establishmentsPaid.map((item) => (
                <option key={String(item.key)} value={String(item.key)}>
                  {item.label || item.key} · {formatNumber(item.count)} ops
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="channel-summary-table-wrap">
          <table className="channel-summary-table channel-summary-table-large channel-summary-hierarchy-table">
            <thead>
              <tr>
                <th>Establecimiento / forma de pago</th>
                <th>Operaciones</th>
                <th>Cant. Tickets</th>
                <th>Total venta 110%</th>
                <th>Provincia 100%</th>
                <th>Entrada UNO 10%</th>
                <th>Costo Financiero</th>
                <th>Valor a Liquidar</th>
                <th>% Costo Financiero</th>
              </tr>
            </thead>
            <tbody>
              {establishmentRows.map((item) => {
                const establishmentKey = String(item.key || "SIN_DEFINIR");
                const channels = paymentDetailsByEstablishment[establishmentKey] ?? {};
                const channelOrder = ["BOLETERIA", "WEB", "SIN_DEFINIR"];
                const channelsToRender = channelOrder
                  .map((channelKey) => ({ channelKey, details: channels[channelKey] ?? [] }))
                  .filter((entry) => entry.details.length > 0);
                const establishmentSummary = summarizeEstablishmentChannel(Object.values(channels).flat());

                return (
                  <Fragment key={`est-${establishmentKey}`}>
                    <tr className="channel-parent-row establishment-parent-row">
                      <td><strong>{item.label || item.key || "Sin definir"}</strong></td>
                      <td>{formatNumber(establishmentSummary.count || item.count || 0)}</td>
                      <td>{formatNumber(establishmentSummary.tickets || item.tickets || 0)}</td>
                      <td>{money(establishmentSummary.total || item.total || 0)}</td>
                      <td>{money(establishmentSummary.province || item.provinceAmount || 0)}</td>
                      <td>{money(establishmentSummary.entradaUno || item.entradaUnoAmount || 0)}</td>
                      <td>{money(establishmentSummary.financialCost)}</td>
                      <td>{money(establishmentSummary.valorLiquidar)}</td>
                      <td>{financialCostPercentage(establishmentSummary.financialCost, establishmentSummary.entradaUno || item.entradaUnoAmount || 0)}</td>
                    </tr>
                    {channelsToRender.map(({ channelKey, details }) => {
                      const channelSummary = summarizeEstablishmentChannel(details);
                      const channelLabel = channelKey === "BOLETERIA" ? "Boletería" : channelKey === "WEB" ? "Web" : "Sin definir";
                      return (
                        <Fragment key={`${establishmentKey}-${channelKey}`}>
                          <tr className="channel-parent-row establishment-channel-row">
                            <td>
                              <span className="sublevel-marker">↳</span>
                              <strong>{channelLabel}</strong>
                            </td>
                            <td>{formatNumber(channelSummary.count)}</td>
                            <td>{formatNumber(channelSummary.tickets)}</td>
                            <td>{money(channelSummary.total)}</td>
                            <td>{money(channelSummary.province)}</td>
                            <td>{money(channelSummary.entradaUno)}</td>
                            <td>{money(channelSummary.financialCost)}</td>
                            <td>{money(channelSummary.valorLiquidar)}</td>
                            <td>{financialCostPercentage(channelSummary.financialCost, channelSummary.entradaUno)}</td>
                          </tr>
                          {details.map((detail) => {
                            const detailFinancialCost = financialCostForBucket(detail.subgroupKey, detail.schAmount || 0);
                            const detailValorLiquidar = liquidationValueForBucket(detail.subgroupKey, detail.total || 0, detail.entradaUnoAmount || 0, detailFinancialCost);
                            return (
                              <tr key={`${detail.establishmentKey}-${detail.channelKey}-${detail.groupKey}-${detail.subgroupKey}`} className="channel-child-row establishment-payment-row">
                                <td>
                                  <span className="sublevel-marker sublevel-marker-deep">↳</span>
                                  <strong>{detail.groupLabel}</strong>
                                  <small>{detail.subgroupLabel}</small>
                                </td>
                                <td>{formatNumber(detail.count)}</td>
                                <td>{formatNumber(detail.tickets || 0)}</td>
                                <td>{money(detail.total)}</td>
                                <td>{money(detail.provinceAmount)}</td>
                                <td>{money(detail.entradaUnoAmount)}</td>
                                <td>{money(detailFinancialCost)}</td>
                                <td>{money(detailValorLiquidar)}</td>
                                <td>{financialCostPercentage(detailFinancialCost, detail.entradaUnoAmount || 0)}</td>
                              </tr>
                            );
                          })}
                          {details.length === 0 && (
                            <tr className="channel-child-row channel-child-empty">
                              <td colSpan={9}>Sin detalle de formas de pago para {channelLabel}.</td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    <tr className="channel-total-row establishment-subtotal-row">
                      <td><strong>Total {item.label || item.key || "Sin definir"}</strong></td>
                      <td>{formatNumber(establishmentSummary.count || item.count || 0)}</td>
                      <td>{formatNumber(establishmentSummary.tickets || item.tickets || 0)}</td>
                      <td>{money(establishmentSummary.total || item.total || 0)}</td>
                      <td>{money(establishmentSummary.province || item.provinceAmount || 0)}</td>
                      <td>{money(establishmentSummary.entradaUno || item.entradaUnoAmount || 0)}</td>
                      <td>{money(establishmentSummary.financialCost)}</td>
                      <td>{money(establishmentSummary.valorLiquidar)}</td>
                      <td>{financialCostPercentage(establishmentSummary.financialCost, establishmentSummary.entradaUno || item.entradaUnoAmount || 0)}</td>
                    </tr>
                  </Fragment>
                );
              })}
              {establishmentRows.length === 0 && (
                <tr className="channel-child-row channel-child-empty">
                  <td colSpan={9}>Sin establecimientos detectados para los filtros seleccionados.</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="channel-total-row">
                <td><strong>Total general establecimientos</strong></td>
                <td>{formatNumber(establishmentTotals.count)}</td>
                <td>{formatNumber(establishmentTotals.tickets)}</td>
                <td>{money(establishmentTotals.total)}</td>
                <td>{money(establishmentTotals.province)}</td>
                <td>{money(establishmentTotals.entradaUno)}</td>
                <td>{money(establishmentTotals.financialCost)}</td>
                <td>{money(establishmentTotals.valorLiquidar)}</td>
                <td>{financialCostPercentage(establishmentTotals.financialCost, establishmentTotals.entradaUno)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="channel-help">
          <strong>Criterio:</strong> esta tabla toma solo operaciones con estado “Pagada”, agrupadas por Establecimiento → Canal (Boletería/Web/Sin definir) → Forma de pago.
        </div>
      </article>


    </div>
  );
}

function PriceCalculatorTab() {
  const [basePrice, setBasePrice] = useState("0");
  const [totalPrice, setTotalPrice] = useState("0");

  const financialPercent = 5;
  const servicePercent = 10;
  const financialRate = financialPercent / 100;
  const serviceRate = servicePercent / 100;
  const multiplier = 1 + financialRate + serviceRate;
  const cleanBase = Number(String(basePrice).replace(/\./g, "").replace(",", ".")) || 0;
  const cleanTotal = Number(String(totalPrice).replace(/\./g, "").replace(",", ".")) || 0;
  const financialAmount = cleanBase * financialRate;
  const serviceAmount = cleanBase * serviceRate;
  const calculatedTotal = cleanBase + financialAmount + serviceAmount;
  const calculatedBase = multiplier ? cleanTotal / multiplier : 0;
  const reverseFinancial = calculatedBase * financialRate;
  const reverseService = calculatedBase * serviceRate;

  return (
    <div className="work-tab-panel price-calculator-panel">
      <div className="work-header compact-header">
        <div>
          <span>Calculadora de Precios</span>
          <h2>Cálculo directo e inverso del ticket</h2>
          <p>Permite calcular el precio final del ticket y también volver desde el precio final al precio base. El Costo Financiero y el Service Charge son parámetros fijos.</p>
        </div>
      </div>
      <section className="price-calculator-grid">
        <article className="price-calculator-card">
          <div className="chart-title">
            <span>Calculadora directa</span>
            <strong>Precio base → precio total</strong>
          </div>
          <div className="price-card-body">
            <label className="price-field price-field-main">
              <span>Precio Venta Ticket</span>
              <input value={basePrice} onChange={(event) => setBasePrice(event.target.value)} />
            </label>
            <div className="price-fixed-grid">
              <div className="price-fixed-box">
                <span>Costo Financiero</span>
                <strong>5%</strong>
              </div>
              <div className="price-fixed-box">
                <span>Service Charge</span>
                <strong>10%</strong>
              </div>
            </div>
            <div className="price-breakdown">
              <div><span>Base</span><strong>{money(cleanBase)}</strong></div>
              <div><span>Costo Financiero 5%</span><strong>{money(financialAmount)}</strong></div>
              <div><span>Service Charge 10%</span><strong>{money(serviceAmount)}</strong></div>
            </div>
            <div className="price-result price-result-total">
              <span>Precio venta total del ticket</span>
              <strong>{money(calculatedTotal)}</strong>
            </div>
          </div>
        </article>
        <article className="price-calculator-card">
          <div className="chart-title">
            <span>Calculadora inversa</span>
            <strong>Precio total → precio base</strong>
          </div>
          <div className="price-card-body">
            <label className="price-field price-field-main">
              <span>Precio de venta total del ticket</span>
              <input value={totalPrice} onChange={(event) => setTotalPrice(event.target.value)} />
            </label>
            <div className="price-fixed-grid">
              <div className="price-fixed-box">
                <span>Costo Financiero</span>
                <strong>5%</strong>
              </div>
              <div className="price-fixed-box">
                <span>Service Charge</span>
                <strong>10%</strong>
              </div>
            </div>
            <div className="price-breakdown">
              <div><span>Costo Financiero estimado</span><strong>{money(reverseFinancial)}</strong></div>
              <div><span>Service Charge estimado</span><strong>{money(reverseService)}</strong></div>
            </div>
            <div className="price-result price-result-total">
              <span>Precio Venta Ticket</span>
              <strong>{money(calculatedBase)}</strong>
            </div>
          </div>
        </article>
      </section>
    </div>
  );
}

function OperationalSummaryTab({
  summary,
  activeView,
  onSelectView,
  dashboard,
  rowsResponse,
  loadingRows,
  filters,
  onFiltersChange,
  onUpdateRow,
  runId,
}: {
  summary: ImportResponse["summary"];
  activeView: OperationalView;
  onSelectView: (view: OperationalView) => void;
  dashboard: DashboardResponse | null;
  rowsResponse: RowsResponse;
  loadingRows: boolean;
  filters: TableFilters;
  onFiltersChange: (filters: TableFilters) => void;
  onUpdateRow: (rowId: number, payload: ManualRowUpdate) => Promise<void>;
  runId: string;
}) {
  const cards: Array<{ key: OperationalView; label: string; value: string; help: string }> = [
    { key: "entrada", label: "Entrada UNO", value: formatNumber(summary.entradaRows), help: "Muestra todas las operaciones del archivo principal." },
    { key: "pago", label: "Pago UNO", value: formatNumber(summary.pagoRows), help: "Muestra las operaciones de Entrada que tienen datos asociados de Pago UNO." },
    { key: "qr", label: "QR", value: formatNumber(summary.qrRows ?? 0), help: "Muestra operaciones QR detectadas en el tercer archivo por id Operacion." },
    { key: "conciliadas", label: "Conciliadas", value: formatNumber(summary.matchedRows), help: "Muestra solo operaciones cruzadas por Orden# = ID de Operación." },
    { key: "sinPago", label: "Sin pago", value: formatNumber(summary.unmatchedRows), help: "Muestra operaciones de Entrada UNO sin pago asociado." },
  ];

  const activeLabel = cards.find((card) => card.key === activeView)?.label ?? "Entrada UNO";
  const paymentBuckets = dashboard?.paymentGroups ?? [];
  const maxPaymentTotal = Math.max(...paymentBuckets.map((item) => item.total), 1);
  const statusBuckets = [
    { key: "CONCILIADO", label: "Conciliadas", count: summary.matchedRows },
    { key: "SIN_PAGO_UNO", label: "Sin pago", count: summary.unmatchedRows },
  ];
  const maxStatusCount = Math.max(summary.matchedRows, summary.unmatchedRows, 1);

  return (
    <div className="work-tab-panel operational-panel">
      <div className="work-header compact-header">
        <div>
          <span>Resumen operativo</span>
          <h2>Control inicial de operaciones</h2>
          <p>Esta pantalla concentra los cuatro datos operativos principales del expediente para revisión rápida.</p>
        </div>
      </div>
      <section className="operational-grid clickable-operational-grid">
        {cards.map((card) => (
          <button className={activeView === card.key ? "operational-card active" : "operational-card"} key={card.key} onClick={() => onSelectView(card.key)}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.help}</small>
          </button>
        ))}
      </section>

      <section className="chart-grid">
        <article className="chart-card">
          <div className="chart-title">
            <span>Gráfico operativo</span>
            <strong>Conciliadas vs sin pago</strong>
          </div>
          <div className="bar-chart">
            {statusBuckets.map((item) => (
              <button key={item.key} className="bar-row" onClick={() => onSelectView(item.key === "CONCILIADO" ? "conciliadas" : "sinPago")}>
                <span className="bar-label">{item.label}</span>
                <span className="bar-track"><span style={{ width: `${Math.max((item.count / maxStatusCount) * 100, 2)}%` }} /></span>
                <strong>{formatNumber(item.count)}</strong>
              </button>
            ))}
          </div>
        </article>

        <article className="chart-card">
          <div className="chart-title">
            <span>Gráfico de ventas</span>
            <strong>Total por medio de pago</strong>
          </div>
          <div className="bar-chart">
            {paymentBuckets.slice(0, 6).map((item) => (
              <div key={item.key} className="bar-row readonly">
                <span className="bar-label">{item.label || item.key}</span>
                <span className="bar-track"><span style={{ width: `${Math.max((item.total / maxPaymentTotal) * 100, 2)}%` }} /></span>
                <strong>{new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(item.total || 0)}</strong>
              </div>
            ))}
            {paymentBuckets.length === 0 && <p className="empty-chart">Todavía no hay datos para graficar.</p>}
          </div>
        </article>
      </section>

      <div className="operational-note">
        <strong>Vista seleccionada:</strong> {activeLabel}. Al presionar una tarjeta se actualiza la consulta inferior con los registros correspondientes.
      </div>

      <DataTable
        runId={runId}
        rows={rowsResponse.rows}
        columns={rowsResponse.columns}
        total={rowsResponse.total}
        loading={loadingRows}
        filters={filters}
        onFiltersChange={onFiltersChange}
        onUpdateRow={onUpdateRow}
      />
    </div>
  );
}


function UsersRolesTab({ currentUser }: { currentUser: UserSession }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [auditLogs, setAuditLogs] = useState<UserAuditLog[]>([]);
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [rolesSavingKey, setRolesSavingKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [newUser, setNewUser] = useState({ email: "", fullName: "", password: "", role: "OPERADOR" as AppRole, isActive: true });
  const isCurrentSuperAdmin = currentUser.role === "SUPERADMIN";
  const [passwordByUser, setPasswordByUser] = useState<Record<string, string>>({});
  const [selectedRoleKey, setSelectedRoleKey] = useState("OPERADOR");

  async function loadUsersAndAudit() {
    setLoading(true);
    setError("");
    try {
      const usersPayload = await fetchUsers();
      setUsers(usersPayload);
    } catch (err) {
      setError(err instanceof Error ? `No se pudieron cargar usuarios: ${err.message}` : "No se pudieron cargar usuarios.");
    }

    try {
      const rolesPayload = await fetchRoles();
      setRoles(rolesPayload.map(dedupeRolePermissions));
    } catch (err) {
      setError(err instanceof Error ? `No se pudieron cargar roles/permisos: ${err.message}` : "No se pudieron cargar roles/permisos.");
    }

    try {
      const auditPayload = await fetchUserAuditLogs();
      setAuditLogs(auditPayload);
    } catch (err) {
      console.error(err);
      // La auditoría no debe romper el panel de usuarios ni el panel de permisos.
    } finally {
      setLoading(false);
    }
  }

  const canManageUsers = userHasPermission(currentUser, "MANAGE_USERS");
  const canManageRoles = userHasPermission(currentUser, "MANAGE_ROLES");
  const canViewUserAudit = userHasPermission(currentUser, "VIEW_USER_AUDIT");

  useEffect(() => {
    if (canManageUsers || canManageRoles || canViewUserAudit) loadUsersAndAudit();
  }, [canManageUsers, canManageRoles, canViewUserAudit]);

  async function handleCreateUser(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await createUser(newUser);
      setNewUser({ email: "", fullName: "", password: "", role: "OPERADOR", isActive: true });
      setSuccess("Usuario creado correctamente.");
      await loadUsersAndAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el usuario.");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdateUser(user: ManagedUser, patch: Partial<ManagedUser>) {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await updateUser(user.id, {
        email: patch.email ?? user.email,
        fullName: patch.fullName ?? user.fullName,
        role: patch.role ?? user.role,
        isActive: patch.isActive ?? user.isActive,
      });
      setSuccess("Usuario actualizado correctamente.");
      await loadUsersAndAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el usuario.");
    } finally {
      setSaving(false);
    }
  }

  async function handleChangePassword(user: ManagedUser) {
    const password = passwordByUser[user.id] || "";
    if (password.length < 8) {
      setError("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await updateUserPassword(user.id, password);
      setPasswordByUser((current) => ({ ...current, [user.id]: "" }));
      setSuccess(`Contraseña actualizada para ${user.email}.`);
      await loadUsersAndAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar la contraseña.");
    } finally {
      setSaving(false);
    }
  }


  function handleToggleRolePermission(role: RoleDefinition, permissionKey: string, enabled: boolean) {
    if (role.key === "ADMIN") {
      setError("El rol ADMIN es de sistema y conserva todos los permisos.");
      return;
    }

    setRoles((current) => current.map((item) => {
      if (item.key !== role.key) return item;
      return {
        ...item,
        permissions: item.permissions.map((permission) => permission.key === permissionKey ? { ...permission, enabled } : permission),
      };
    }));
    setSuccess("Cambios pendientes. Presioná Guardar permisos para aplicar el rol.");
  }

  async function handleSaveRolePermissions(role: RoleDefinition) {
    if (role.key === "ADMIN") {
      setError("El rol ADMIN es de sistema y conserva todos los permisos.");
      return;
    }

    const nextPermissions = Object.fromEntries(role.permissions.map((permission) => [permission.key, permission.enabled]));

    setRolesSavingKey(role.key);
    setError("");
    setSuccess("");
    try {
      await updateRolePermissions(role.key, { permissions: nextPermissions });
      setSuccess(`Permisos guardados para el rol ${role.label || role.key}.`);
      const rolesPayload = await fetchRoles();
      setRoles(rolesPayload.map(dedupeRolePermissions));
      try {
        setAuditLogs(await fetchUserAuditLogs());
      } catch (auditError) {
        console.error(auditError);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el rol.");
    } finally {
      setRolesSavingKey("");
    }
  }

  if (!canManageUsers && !canManageRoles && !canViewUserAudit) {
    return (
      <div className="work-tab-panel users-panel">
        <div className="work-header compact-header">
          <div>
            <span>Usuarios y roles</span>
            <h2>Acceso restringido</h2>
            <p>No tiene permisos asignados para administrar usuarios, roles o auditoría.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="work-tab-panel users-panel">
      <div className="work-header compact-header">
        <div>
          <span>Usuarios y roles</span>
          <h2>Administración de accesos</h2>
          <p>Alta de usuarios, asignación de roles, activación, desactivación y cambio de contraseña con auditoría administrativa.</p>
        </div>
        <button className="secondary button" onClick={loadUsersAndAudit} disabled={loading}>{loading ? "Actualizando..." : "Actualizar"}</button>
      </div>

      {error && <div className="error">{error}</div>}
      {success && <div className="success-message">{success}</div>}

      {canManageUsers && (
      <form className="user-create-card" onSubmit={handleCreateUser}>
        <div className="chart-title">
          <span>Nuevo usuario</span>
          <strong>Alta controlada por ADMIN</strong>
        </div>
        <div className="user-form-grid">
          <label>Email
            <input value={newUser.email} onChange={(event) => setNewUser((current) => ({ ...current, email: event.target.value }))} placeholder="usuario@dominio.com" />
          </label>
          <label>Nombre completo
            <input value={newUser.fullName} onChange={(event) => setNewUser((current) => ({ ...current, fullName: event.target.value }))} placeholder="Nombre y apellido" />
          </label>
          <label>Rol
            <select value={newUser.role} onChange={(event) => setNewUser((current) => ({ ...current, role: event.target.value as AppRole }))}>
              {isCurrentSuperAdmin && <option value="SUPERADMIN">SUPERADMIN</option>}
              <option value="ADMIN">ADMIN</option>
              <option value="OPERADOR">OPERADOR</option>
              <option value="LECTOR">LECTOR</option>
            </select>
          </label>
          <label>Contraseña inicial
            <input type="password" value={newUser.password} onChange={(event) => setNewUser((current) => ({ ...current, password: event.target.value }))} placeholder="Mínimo 8 caracteres" />
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={newUser.isActive} onChange={(event) => setNewUser((current) => ({ ...current, isActive: event.target.checked }))} />
            Usuario activo
          </label>
        </div>
        <button className="primary button" disabled={saving}>{saving ? "Guardando..." : "Crear usuario"}</button>
      </form>
      )}

      {canManageRoles && (
      <article className="users-table-card roles-permissions-card">
        <div className="chart-title">
          <span>Roles y permisos</span>
          <strong>Administración compacta por rol</strong>
        </div>
        <p className="role-help-text">
          {isCurrentSuperAdmin ? (
            <>Seleccioná un rol para ver sus permisos. <strong>SUPERADMIN</strong> es el rol superior y queda protegido; <strong>ADMIN</strong> también queda protegido.</>
          ) : (
            <>Seleccioná un rol para ver sus permisos. <strong>ADMIN</strong> queda protegido desde esta pantalla.</>
          )}
        </p>

        {roles.length === 0 ? (
          <div className="role-empty">No hay permisos de roles cargados. Ejecutá <strong>npm run db:init</strong> para inicializar la base.</div>
        ) : (() => {
          const cleanRoles = roles
            .filter((role) => isCurrentSuperAdmin || role.key !== "SUPERADMIN")
            .map(dedupeRolePermissions);
          const selectedRole = cleanRoles.find((role) => role.key === selectedRoleKey) || cleanRoles[0];
          const groupedPermissions = selectedRole.permissions.reduce<Record<string, typeof selectedRole.permissions>>((acc, permission) => {
            const category = permission.category || "General";
            acc[category] = acc[category] || [];
            acc[category].push(permission);
            return acc;
          }, {});
          const activePermissionsCount = selectedRole.permissions.filter((permission) => permission.enabled).length;

          return (
            <div className="roles-compact-panel" style={{ display: "grid", gap: 18 }}>
              <div
                className="role-selector-tabs"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                  gap: 12,
                }}
              >
                {cleanRoles.map((role) => {
                  const activeCount = role.permissions.filter((permission) => permission.enabled).length;
                  const active = selectedRole.key === role.key;
                  return (
                    <button
                      key={role.key}
                      type="button"
                      onClick={() => setSelectedRoleKey(role.key)}
                      className={active ? "active" : ""}
                      style={{
                        border: active ? "1px solid #2563eb" : "1px solid #dbe7fb",
                        background: active ? "#eef4ff" : "#ffffff",
                        borderRadius: 16,
                        padding: "14px 16px",
                        textAlign: "left",
                        cursor: "pointer",
                        boxShadow: active ? "0 0 0 3px rgba(37, 99, 235, 0.12)" : "0 8px 22px rgba(15, 23, 42, 0.05)",
                        color: "#0f172a",
                        minWidth: 0,
                      }}
                    >
                      <span style={{ display: "block", color: "#2563eb", fontSize: 11, fontWeight: 900, textTransform: "uppercase", letterSpacing: ".08em" }}>Rol</span>
                      <strong style={{ display: "block", fontSize: 17 }}>{role.label || role.key}</strong>
                      <small style={{ display: "block", color: "#64748b", marginTop: 4 }}>{activeCount} permisos activos</small>
                    </button>
                  );
                })}
              </div>

              <section
                className={selectedRole.key === "ADMIN" ? "role-card locked role-detail-card" : "role-card role-detail-card"}
                style={{
                  border: "1px solid #dbe7fb",
                  borderRadius: 18,
                  background: "#ffffff",
                  padding: 18,
                  overflow: "hidden",
                }}
              >
                <header
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: 16,
                    paddingBottom: 16,
                    borderBottom: "1px solid #e5edf8",
                    marginBottom: 16,
                  }}
                >
                  <div>
                    <span style={{ display: "block", color: "#2563eb", fontSize: 11, fontWeight: 900, textTransform: "uppercase", letterSpacing: ".08em" }}>Rol seleccionado</span>
                    <strong style={{ display: "block", fontSize: 24, color: "#0f172a" }}>{selectedRole.label || selectedRole.key}</strong>
                    <small style={{ display: "block", color: "#64748b", marginTop: 4 }}>{selectedRole.description}</small>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <div
                      style={{
                        border: "1px solid #dbe7fb",
                        borderRadius: 14,
                        padding: "9px 13px",
                        background: "#f8fbff",
                        minWidth: 130,
                      }}
                    >
                      <strong style={{ display: "block", fontSize: 20, color: "#0f172a" }}>{activePermissionsCount}</strong>
                      <span style={{ color: "#64748b", fontSize: 12 }}>permisos activos</span>
                    </div>

                    {selectedRole.locked ? (
                      <b className="role-lock-pill">Sistema</b>
                    ) : (
                      <button
                        type="button"
                        className="tiny-action"
                        disabled={rolesSavingKey === selectedRole.key}
                        onClick={() => handleSaveRolePermissions(selectedRole)}
                      >
                        {rolesSavingKey === selectedRole.key ? "Guardando..." : "Guardar permisos"}
                      </button>
                    )}
                  </div>
                </header>

                <div className="role-permission-groups" style={{ display: "grid", gap: 12 }}>
                  {Object.entries(groupedPermissions).map(([category, permissions]) => (
                    <details
                      className="role-permission-group"
                      key={`${selectedRole.key}-${category}`}
                      open
                      style={{
                        border: "1px solid #dbe7fb",
                        borderRadius: 16,
                        background: "#f8fbff",
                        overflow: "hidden",
                      }}
                    >
                      <summary
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          cursor: "pointer",
                          padding: "13px 15px",
                          fontWeight: 900,
                          color: "#0f172a",
                          listStyle: "none",
                        }}
                      >
                        <span>{category}</span>
                        <span style={{ color: "#2563eb", fontSize: 13 }}>
                          {permissions.filter((permission) => permission.enabled).length} / {permissions.length}
                        </span>
                      </summary>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                          gap: 10,
                          padding: "0 14px 14px",
                        }}
                      >
                        {permissions.map((permission) => {
                          const disabled = saving || Boolean(selectedRole.locked) || Boolean(permission.locked) || rolesSavingKey === selectedRole.key;
                          return (
                            <label
                              className={permission.enabled ? "permission-row enabled" : "permission-row"}
                              key={`${selectedRole.key}-${permission.key}`}
                              style={{
                                display: "grid",
                                gridTemplateColumns: "24px minmax(0, 1fr)",
                                gap: 10,
                                alignItems: "flex-start",
                                border: permission.enabled ? "1px solid #86efac" : "1px solid #dbe7fb",
                                borderRadius: 14,
                                background: permission.enabled ? "#ecfdf5" : "#ffffff",
                                padding: 12,
                                cursor: disabled ? "not-allowed" : "pointer",
                                minWidth: 0,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={permission.enabled}
                                disabled={disabled}
                                onChange={(event) => handleToggleRolePermission(selectedRole, permission.key, event.target.checked)}
                                style={{ marginTop: 3 }}
                              />
                              <span style={{ minWidth: 0 }}>
                                <strong style={{ display: "block", color: "#0f172a", fontSize: 14 }}>{permission.label}</strong>
                                <small style={{ display: "block", color: "#64748b", marginTop: 3, lineHeight: 1.35 }}>{permission.description}</small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            </div>
          );
        })()}
      </article>
      )}

      {canManageUsers && (
      <article className="users-table-card">
        <div className="chart-title">
          <span>Usuarios registrados</span>
          <strong>{users.filter((item) => isCurrentSuperAdmin || item.role !== "SUPERADMIN").length} usuarios</strong>
        </div>
        <div className="users-table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Email</th>
                <th>Rol</th>
                <th>Estado</th>
                <th>Cambiar contraseña</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {users
                .filter((item) => isCurrentSuperAdmin || item.role !== "SUPERADMIN")
                .map((item) => (
                <tr key={item.id} className={!item.isActive ? "inactive-user" : ""}>
                  <td>
                    <input value={item.fullName} onChange={(event) => setUsers((current) => current.map((u) => u.id === item.id ? { ...u, fullName: event.target.value } : u))} />
                  </td>
                  <td>
                    <input value={item.email} onChange={(event) => setUsers((current) => current.map((u) => u.id === item.id ? { ...u, email: event.target.value } : u))} />
                  </td>
                  <td>
                    <select
                      value={item.role}
                      disabled={item.id === currentUser.id || (item.role === "SUPERADMIN" && !isCurrentSuperAdmin)}
                      onChange={(event) => handleUpdateUser(item, { role: event.target.value as AppRole })}
                    >
                      {isCurrentSuperAdmin && <option value="SUPERADMIN">SUPERADMIN</option>}
                      {item.role === "SUPERADMIN" && !isCurrentSuperAdmin && <option value="SUPERADMIN">SUPERADMIN</option>}
                      <option value="ADMIN">ADMIN</option>
                      <option value="OPERADOR">OPERADOR</option>
                      <option value="LECTOR">LECTOR</option>
                    </select>
                  </td>
                  <td>
                    <button className={item.isActive ? "status-pill active" : "status-pill inactive"} disabled={item.id === currentUser.id || saving || (item.role === "SUPERADMIN" && !isCurrentSuperAdmin)} onClick={() => handleUpdateUser(item, { isActive: !item.isActive })}>
                      {item.isActive ? "Activo" : "Inactivo"}
                    </button>
                  </td>
                  <td>
                    <div className="password-inline">
                      <input type="password" value={passwordByUser[item.id] || ""} onChange={(event) => setPasswordByUser((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Nueva contraseña" />
                      <button className="tiny-action" disabled={saving || (item.role === "SUPERADMIN" && !isCurrentSuperAdmin)} onClick={() => handleChangePassword(item)}>Guardar</button>
                    </div>
                  </td>
                  <td>
                    <button className="tiny-action" disabled={saving || (item.role === "SUPERADMIN" && !isCurrentSuperAdmin)} onClick={() => handleUpdateUser(item, { email: item.email, fullName: item.fullName, role: item.role, isActive: item.isActive })}>Guardar cambios</button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={6}>No hay usuarios cargados.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </article>
      )}

      {canViewUserAudit && (
      <article className="users-table-card audit-log-card">
        <div className="chart-title">
          <span>Auditoría de usuarios</span>
          <strong>Últimos 200 movimientos</strong>
        </div>
        <div className="users-table-wrap">
          <table className="users-table audit-users-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Acción</th>
                <th>Usuario afectado</th>
                <th>Administrador</th>
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.map((item) => (
                <tr key={item.id}>
                  <td>{formatDate(item.createdAt)}</td>
                  <td><strong>{item.action}</strong></td>
                  <td>{item.targetEmail || item.targetUserId || "—"}</td>
                  <td>{item.adminEmail || item.adminUserId || "—"}</td>
                  <td><code>{JSON.stringify(item.newValue || {})}</code></td>
                </tr>
              ))}
              {auditLogs.length === 0 && (
                <tr><td colSpan={5}>Todavía no hay movimientos de usuarios.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </article>
      )}
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (user: UserSession) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const payload = await login(email, password);
      onLogin(payload.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar sesión.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <section className="login-layout">
        <div className="login-copy">
          <div className="brand large"><Landmark size={30} /> Conciliación Cultura UNO</div>
          <h1>Sistema contable con acceso protegido</h1>
          <p>
            Para procesar, guardar y continuar trabajando conciliaciones es obligatorio ingresar con usuario y contraseña. Cada importación queda persistida en PostgreSQL como un expediente de trabajo.
          </p>
          <div className="login-points">
            <div><ShieldCheck /> Autenticación por sesión segura</div>
            <div><Database /> Historial de documentos guardados</div>
            <div><BarChart3 /> Consultas sobre la base</div>
          </div>
        </div>
        <form className="login-card" onSubmit={submit}>
          <span>Ingreso al sistema</span>
          <h2>Usuario y contraseña</h2>
          <label>
            Usuario / email
            <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
          </label>
          <label>
            Contraseña
            <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="off"
                placeholder="Ingrese la contraseña"
              />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="primary button" disabled={loading}>{loading ? "Ingresando..." : "Ingresar"}</button>
        </form>
      </section>
    </main>
  );
}

export default function App() {
  const [user, setUser] = useState<UserSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [entradaFile, setEntradaFile] = useState<File | null>(null);
  const [pagoFile, setPagoFile] = useState<File | null>(null);
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [run, setRun] = useState<ImportResponse | null>(null);
  const [runs, setRuns] = useState<RunMetadata[]>([]);
  const [activeMenu, setActiveMenu] = useState<MenuKey>("entrada1");
  const [activeWorkTab, setActiveWorkTab] = useState<WorkTab>("expediente");
  const [activeOperationalView, setActiveOperationalView] = useState<OperationalView>("entrada");
  const [rowsResponse, setRowsResponse] = useState<RowsResponse>({ rows: [], columns: [], total: 0, page: 1, pageSize: 100 });
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [filters, setFilters] = useState<TableFilters>(DEFAULT_FILTERS);
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [loadingImport, setLoadingImport] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [loadingDashboard, setLoadingDashboard] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [runSearch, setRunSearch] = useState("");
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [hasAutoOpenedRun, setHasAutoOpenedRun] = useState(false);
  const [error, setError] = useState("");

  async function loadRuns(options: { autoOpenLatest?: boolean } = {}) {
    setLoadingRuns(true);
    try {
      const data = await fetchRuns();
      setRuns(data);

      const shouldAutoOpen = options.autoOpenLatest && !hasAutoOpenedRun && !run && data.length > 0;
      if (shouldAutoOpen) {
        setHasAutoOpenedRun(true);
        const latestRun = await fetchRun(data[0].id);
        setRun(runToImportResponse(latestRun));
        setNotes(latestRun.notes || "");
        setFilters(DEFAULT_FILTERS);
        setActiveMenu("entrada1");
        setActiveWorkTab("conciliacionEntradaUno");
        setShowHistoryPanel(false);
        setShowUploadPanel(false);
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "No se pudo cargar el historial.");
    } finally {
      setLoadingRuns(false);
    }
  }

  useEffect(() => {
    async function bootstrap() {
      if (!getStoredToken()) {
        setCheckingSession(false);
        return;
      }
      try {
        const session = await fetchMe();
        setUser(session);
      } catch {
        clearStoredToken();
      } finally {
        setCheckingSession(false);
      }
    }
    bootstrap();
  }, []);

  useEffect(() => {
    if (user) loadRuns({ autoOpenLatest: true });
  }, [user]);


  useEffect(() => {
    if (!user) return;
    if (activeWorkTab === "usuariosRoles" && !(userHasPermission(user, "MANAGE_USERS") || userHasPermission(user, "MANAGE_ROLES") || userHasPermission(user, "VIEW_USER_AUDIT"))) {
      setActiveWorkTab("conciliacionEntradaUno");
    }
    if (activeWorkTab === "conciliacionEntradaUno" && !userHasPermission(user, "VIEW_ENTRADA_UNO")) setActiveWorkTab("expediente");
    if (activeWorkTab === "calculadoraPrecios" && !userHasPermission(user, "VIEW_PRICE_CALCULATOR")) setActiveWorkTab("expediente");
    if (activeWorkTab === "auditoria" && !userHasPermission(user, "VIEW_AUDIT")) setActiveWorkTab("expediente");
  }, [user, activeWorkTab]);

  async function handleProcess() {
    if (!entradaFile || !pagoFile) {
      setError("Cargá primero el archivo principal Entrada UNO y el archivo complementario Pago UNO.");
      return;
    }
    setError("");
    setLoadingImport(true);
    try {
      const imported = await importReconciliation(entradaFile, pagoFile, qrFile);
      setRun(imported);
      setNotes("");
      setFilters(DEFAULT_FILTERS);
      setActiveMenu("entrada1");
      setActiveWorkTab("conciliacionEntradaUno");
      setShowHistoryPanel(false);
      setShowUploadPanel(false);
      setHasAutoOpenedRun(true);
      await loadRuns();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "No se pudo procesar la conciliación.");
    } finally {
      setLoadingImport(false);
    }
  }

  async function openRun(runId: string) {
    setError("");
    try {
      const metadata = await fetchRun(runId);
      setRun(runToImportResponse(metadata));
      setNotes(metadata.notes || "");
      setFilters(DEFAULT_FILTERS);
      setActiveMenu("entrada1");
      setActiveWorkTab("conciliacionEntradaUno");
      setShowHistoryPanel(false);
      setShowUploadPanel(false);
      document.getElementById("trabajo")?.scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo abrir la conciliación guardada.");
    }
  }

  async function saveNotes() {
    if (!run) return;
    setSavingNotes(true);
    setError("");
    try {
      await updateRunNotes(run.runId, notes, run.stepStatus || "PASO_1_CONCILIACION_GUARDADA");
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron guardar las notas.");
    } finally {
      setSavingNotes(false);
    }
  }

  async function handleUpdateRow(rowId: number, payload: ManualRowUpdate) {
    if (!run) return;
    setError("");
    try {
      await updateRunRow(run.runId, rowId, payload);
      const [nextRows, nextDashboard, nextRun] = await Promise.all([
        fetchRows(run.runId, activeMenu, filters),
        fetchDashboard(run.runId, filters),
        fetchRun(run.runId),
      ]);
      setRowsResponse(nextRows);
      setDashboard(nextDashboard);
      setRun(runToImportResponse(nextRun));
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar la conciliación manual del registro.");
      throw err;
    }
  }

  function logout() {
    clearStoredToken();
    setUser(null);
    setRun(null);
    setRuns([]);
    setShowHistoryPanel(false);
    setShowUploadPanel(false);
    setHasAutoOpenedRun(false);
  }

  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    setLoadingDashboard(true);
    fetchDashboard(run.runId, filters)
      .then((payload) => {
        if (!cancelled) setDashboard(payload);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudo cargar el panel de consultas.");
      })
      .finally(() => {
        if (!cancelled) setLoadingDashboard(false);
      });
    return () => { cancelled = true; };
  }, [filters, run]);

  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    setLoadingRows(true);
    fetchRows(run.runId, activeMenu, filters)
      .then((payload) => {
        if (!cancelled) setRowsResponse(payload);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudieron cargar los registros.");
      })
      .finally(() => {
        if (!cancelled) setLoadingRows(false);
      });
    return () => { cancelled = true; };
  }, [activeMenu, filters, run]);

  function handleMenuChange(menu: MenuKey) {
    setActiveMenu(menu);
    setFilters((current) => ({ ...current, column: "", value: "", page: 1 }));
  }

  function openExpediente() {
    setActiveWorkTab("expediente");
    setActiveMenu(FULL_FILE_MENU);
    setFilters((current) => ({
      ...current,
      q: "",
      status: "todos",
      paymentGroup: "todos",
      paymentChannel: "todos",
      paymentSubgroup: "todos",
      operationStatus: "todos",
      reviewStatus: "todos",
      selectedMonths: [],
      column: "",
      value: "",
      page: 1,
      pageSize: current.pageSize || 100,
    }));
  }

  function selectOperationalView(view: OperationalView) {
    setActiveOperationalView(view);
    setActiveMenu("entrada1");
    setFilters((current) => ({
      ...current,
      status: view === "sinPago" ? "SIN_PAGO_UNO" : view === "entrada" || view === "qr" ? "todos" : "CONCILIADO",
      paymentGroup: view === "qr" ? "QR" : "todos",
      paymentChannel: "todos",
      paymentSubgroup: "todos",
      operationStatus: "todos",
      reviewStatus: "todos",
      column: "",
      value: "",
      page: 1,
    }));
  }

  const visibleRuns = runs.filter((item) => {
    const query = runSearch.trim().toLowerCase();
    if (!query) return true;
    return [
      item.entrada_filename,
      item.pago_filename,
      item.qr_filename,
      item.step_status,
      item.reconciliation_stage,
      formatDate(item.created_at),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  if (checkingSession) return <main className="loading-screen">Verificando sesión...</main>;
  if (!user) return <LoginScreen onLogin={setUser} />;

  return (
    <main>
      <section className="app-shell-header">
        <nav className="topbar compact-topbar">
          <div className="brand"><Landmark size={26} /> Conciliación Cultura UNO</div>
          <div className="session-box">
            <span>{user.fullName} · {user.role}</span>
            <button onClick={logout}><LogOut size={16} /> Salir</button>
          </div>
        </nav>
        <div className="app-shell-title">
          <div>
            <span className="eyebrow system-eyebrow">Sistema contable de conciliación</span>
            <h1>Gestión de conciliaciones</h1>
            <p>Procesá nuevos documentos, abrí expedientes guardados y continuá el análisis contable desde una vista de trabajo limpia.</p>
          </div>
          <div className="app-shell-actions">
            <button
              className="primary"
              type="button"
              onClick={() => {
                setShowUploadPanel((value) => !value);
                setShowHistoryPanel(false);
                setTimeout(() => document.getElementById("sistema")?.scrollIntoView({ behavior: "smooth" }), 0);
              }}
            >
              {showUploadPanel ? "Ocultar carga" : "Nuevo expediente"}
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setShowHistoryPanel((value) => !value);
                setShowUploadPanel(false);
                setTimeout(() => document.getElementById("historial")?.scrollIntoView({ behavior: "smooth" }), 0);
              }}
            >
              {showHistoryPanel ? "Ocultar historial" : "Ver historial"}
            </button>
          </div>
        </div>
      </section>

      {showHistoryPanel && (
        <section id="historial" className="system-card history-panel">
        <div className="section-title horizontal-title history-title">
          <div>
            <span>Documentos guardados</span>
            <h2>Historial de conciliaciones</h2>
            <p>Seleccioná un expediente ya procesado sin volver a cargar los Excel. La lista queda contenida para evitar scroll vertical excesivo.</p>
          </div>
          <div className="history-actions">
            <input
              className="history-search"
              value={runSearch}
              onChange={(event) => setRunSearch(event.target.value)}
              placeholder="Buscar por archivo, fecha o estado..."
            />
            <button className="secondary button" onClick={() => loadRuns()} disabled={loadingRuns}>{loadingRuns ? "Actualizando..." : "Actualizar"}</button>
          </div>
        </div>

        <div className="history-summary-row">
          <div>
            <small>Total expedientes</small>
            <strong>{formatNumber(runs.length)}</strong>
          </div>
          <div>
            <small>Vista filtrada</small>
            <strong>{formatNumber(visibleRuns.length)}</strong>
          </div>
          <div>
            <small>Expediente activo</small>
            <strong>{run ? "Abierto" : "Sin seleccionar"}</strong>
          </div>
        </div>

        <div className="history-table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Archivo principal</th>
                <th>Estado</th>
                <th>Conciliadas</th>
                <th>Sin pago</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {visibleRuns.map((item) => (
                <tr key={item.id} className={run?.runId === item.id ? "active" : ""}>
                  <td><strong>{formatDate(item.created_at)}</strong></td>
                  <td className="history-file-cell">{item.entrada_filename}</td>
                  <td><span className="history-status">{item.reconciliation_stage || item.step_status || "PASO_1_CONCILIACION_GUARDADA"}</span></td>
                  <td>{formatNumber(item.summary?.matchedRows ?? 0)}</td>
                  <td>{formatNumber(item.summary?.unmatchedRows ?? 0)}</td>
                  <td><button className="tiny-action" onClick={() => openRun(item.id)}>{run?.runId === item.id ? "Abierto" : "Abrir"}</button></td>
                </tr>
              ))}
              {!loadingRuns && visibleRuns.length === 0 && (
                <tr>
                  <td colSpan={6} className="history-empty-cell">No hay conciliaciones guardadas para la búsqueda actual.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </section>
      )}

      {showUploadPanel && (
        <section id="sistema" className="system-card">
        <div className="section-title">
          <span>Paso 1</span>
          <h2>Cargar archivos y guardar conciliación</h2>
          <p>El navegador solo envía los archivos. El cruce, la unión completa y los filtros se ejecutan desde el backend contra PostgreSQL.</p>
        </div>

        <div className="upload-grid">
          <FileDrop
            label="Archivo 1: Entrada UNO"
            description="Documento principal. Se conserva completo y se le agregan columnas de Pago UNO y QR."
            file={entradaFile}
            onChange={setEntradaFile}
          />
          <FileDrop
            label="Archivo 2: Pago UNO"
            description="Documento complementario. Se toman columnas verdes marcadas como Sumar."
            file={pagoFile}
            onChange={setPagoFile}
          />
          <FileDrop
            label="Archivo 3: Pagos QR por fecha"
            description="Opcional. Se incorporan solo las columnas amarillas y se cruzan por id Operacion = Orden#."
            file={qrFile}
            onChange={setQrFile}
          />
        </div>

        {error && <div className="error">{error}</div>}

        <div className="button-row">
          <button className="primary button" onClick={handleProcess} disabled={loadingImport}>
            {loadingImport ? "Procesando y guardando en BD..." : "Procesar y guardar Paso 1"}
          </button>
          {run && (
            <a className="secondary button" href={exportRunUrl(run.runId)}>
              Exportar Excel completo con filtros
            </a>
          )}
        </div>
        </section>
      )}

      {run && (
        <section className="results" id="trabajo">
          <div className="work-tabs">
            {userHasPermission(user, "VIEW_ENTRADA_UNO") && (
              <button className={activeWorkTab === "conciliacionEntradaUno" ? "active" : ""} onClick={() => { setActiveWorkTab("conciliacionEntradaUno"); setActiveMenu("entrada1"); setFilters((current) => ({ ...current, status: "todos", paymentGroup: "todos", paymentChannel: "todos", paymentSubgroup: "todos", operationStatus: "todos", reviewStatus: "todos", selectedMonths: [], column: "", value: "", page: 1 })); }}>
                <strong>Conciliación Entrada UNO</strong>
                <span>Estados, Boletería y Web</span>
              </button>
            )}
            {userHasPermission(user, "VIEW_PRICE_CALCULATOR") && (
              <button className={activeWorkTab === "calculadoraPrecios" ? "active" : ""} onClick={() => setActiveWorkTab("calculadoraPrecios")}>
                <strong>Calculadora de Precios</strong>
                <span>Precio total y precio base</span>
              </button>
            )}
            {userHasPermission(user, "VIEW_AUDIT") && (
              <button className={activeWorkTab === "auditoria" ? "active" : ""} onClick={() => setActiveWorkTab("auditoria")}>
                <strong>Auditoría</strong>
                <span>Operaciones pagadas por establecimiento</span>
              </button>
            )}
            {userHasPermission(user, "VIEW_EXPEDIENTE") && (
              <button className={activeWorkTab === "expediente" ? "active" : ""} onClick={openExpediente}>
                <strong>Expediente de conciliación</strong>
                <span>Estado, notas y exportación</span>
              </button>
            )}
            {(userHasPermission(user, "MANAGE_USERS") || userHasPermission(user, "MANAGE_ROLES") || userHasPermission(user, "VIEW_USER_AUDIT")) && (
              <button className={activeWorkTab === "usuariosRoles" ? "active" : ""} onClick={() => setActiveWorkTab("usuariosRoles")}>
                <strong>Usuarios y roles</strong>
                <span>Alta, roles, estado y contraseñas</span>
              </button>
            )}
          </div>

          {activeWorkTab === "expediente" && (
            <div className="work-tab-panel">
              <div className="work-header">
                <div>
                  <span>Expediente de conciliación</span>
                  <h2>Documento abierto para trabajar</h2>
                  <p><strong>ID:</strong> {run.runId}</p>
                </div>
                <div className="step-badge">{run.stepStatus === "PASO_2_CONCILIACION_MANUAL" ? "PASO 2 · Conciliación manual en curso" : run.stepStatus === "PASO_2_CONCILIACION_CONTABLE_REALIZADA" ? "PASO 2 · Conciliación realizada" : run.stepStatus === "PASO_2_REVISION_CONCILIACION" ? "PASO 2 · Revisión de conciliación" : "PASO 1 · Conciliación guardada"}</div>
              </div>

              <SummaryCards summary={run.summary} />

              <div className="unified-file-note expediente-unified-note">
                <strong>Archivo unificado completo</strong>
                <p>Después de procesar el Paso 1, abajo se muestra el archivo nuevo completo: Entrada UNO + Pago UNO + Pagos QR. La vista está paginada para no perder rendimiento, pero contiene todos los registros y todas las columnas guardadas en PostgreSQL.</p>
              </div>

              <DataTable
                runId={run.runId}
                rows={rowsResponse.rows}
                columns={rowsResponse.columns}
                total={rowsResponse.total}
                loading={loadingRows}
                filters={filters}
                onFiltersChange={setFilters}
                onUpdateRow={handleUpdateRow}
                canEdit={userHasPermission(user, "EDIT_UNIFIED_FILE")}
              />

              <div className="notes-panel">
                <label>
                  Notas internas / observaciones contables
                  <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Ej: revisar diferencias de tarjeta web, separar ventas QR, controlar lote de boletería..." />
                </label>
                <button className="secondary button" onClick={saveNotes} disabled={savingNotes}>{savingNotes ? "Guardando..." : "Guardar notas"}</button>
              </div>

              <div className="expediente-actions">
                <a className="primary button" href={exportRunUrl(run.runId)}>
                  Exportar Excel completo con filtros
                </a>
                <button className="secondary button" onClick={() => setActiveWorkTab("conciliacionEntradaUno")}>
                  Ir a Conciliación Entrada UNO
                </button>
              </div>
            </div>
          )}

          {activeWorkTab === "conciliacionEntradaUno" && (
            <EntradaUnoConciliacionTab
              dashboard={dashboard}
              rowsResponse={rowsResponse}
              loadingRows={loadingRows}
              filters={filters}
              onFiltersChange={setFilters}
              onUpdateRow={handleUpdateRow}
              runId={run.runId}
            />
          )}

          {activeWorkTab === "calculadoraPrecios" && (
            <PriceCalculatorTab />
          )}

          {activeWorkTab === "auditoria" && (
            <AuditoriaTab dashboard={dashboard} />
          )}

          {activeWorkTab === "usuariosRoles" && (
            <UsersRolesTab currentUser={user} />
          )}

          {activeWorkTab === "resumen" && (
            <OperationalSummaryTab
              summary={run.summary}
              activeView={activeOperationalView}
              onSelectView={selectOperationalView}
              dashboard={dashboard}
              rowsResponse={rowsResponse}
              loadingRows={loadingRows}
              filters={filters}
              onFiltersChange={setFilters}
              onUpdateRow={handleUpdateRow}
              runId={run.runId}
            />
          )}

          {activeWorkTab === "consultas" && (
            <div className="work-tab-panel">
              <PowerBiFilters dashboard={dashboard} loading={loadingDashboard} filters={filters} onFiltersChange={setFilters} />
              <div className="consultas-footer">
                <button className="primary button" onClick={() => setActiveWorkTab("filtros")}>
                  Ver resultados filtrados abajo
                </button>
              </div>
            </div>
          )}

          {activeWorkTab === "filtros" && (
            <div className="work-tab-panel">
              <div className="tabs">
                {MENUS.map((menu) => (
                  <button key={menu.key} className={activeMenu === menu.key ? "active" : ""} onClick={() => handleMenuChange(menu.key)}>
                    <strong>{menu.label}</strong>
                    <span>{menu.description}</span>
                  </button>
                ))}
              </div>
              <div id="tabla-conciliacion-manual" />
              <DataTable
                runId={run.runId}
                rows={rowsResponse.rows}
                columns={rowsResponse.columns}
                total={rowsResponse.total}
                loading={loadingRows}
                filters={filters}
                onFiltersChange={setFilters}
                onUpdateRow={handleUpdateRow}
              />
            </div>
          )}
        </section>
      )}
    </main>
  );
}
