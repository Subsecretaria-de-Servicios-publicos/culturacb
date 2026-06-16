import type { ReconciliationSummary } from "../types/reconciliation";

function money(value: number): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value || 0);
}

export function SummaryCards({ summary }: { summary: ReconciliationSummary }) {
  const provinceAmount = summary.totalProvincia ?? summary.totalEntrada / 1.10;
  const entradaUnoAmount = summary.totalEntradaUno ?? summary.totalEntrada - provinceAmount;
  const cards = [
    ["Entrada UNO", summary.entradaRows.toLocaleString("es-AR")],
    ["Pago UNO", summary.pagoRows.toLocaleString("es-AR")],
    ["QR", (summary.qrRows ?? 0).toLocaleString("es-AR")],
    ["Conciliadas", summary.matchedRows.toLocaleString("es-AR")],
    ["Sin pago", summary.unmatchedRows.toLocaleString("es-AR")],
    ["QR conciliadas", (summary.qrMatchedRows ?? 0).toLocaleString("es-AR")],
    ["Total venta 110%", money(summary.totalEntrada)],
    ["Provincia 100%", money(provinceAmount)],
    ["Entrada UNO 10%", money(entradaUnoAmount)],
    ["Total Pago conciliado", money(summary.totalPagoConciliado)],
    ["Total QR conciliado", money(summary.totalQrConciliado ?? 0)],
    ["Diferencia", money(summary.diferenciaTotal)],
    ["Diferencia QR", money(summary.diferenciaQrTotal ?? 0)],
    ["Claves Pago duplicadas", summary.duplicatePagoKeys.toLocaleString("es-AR")],
    ["Claves QR duplicadas", (summary.duplicateQrKeys ?? 0).toLocaleString("es-AR")],
  ];

  return (
    <section className="summary-grid">
      {cards.map(([label, value]) => (
        <article className="summary-card" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </article>
      ))}
    </section>
  );
}
