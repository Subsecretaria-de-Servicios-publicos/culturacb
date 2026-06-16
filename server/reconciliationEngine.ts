import * as XLSX from "xlsx";

export type MenuKey = "entrada1" | "bordereaux" | "conciliacionTC" | "archivoCompleto";
export type ExcelRow = Record<string, string | number | boolean | null | undefined>;

export interface PagoColumnMeta {
  columnKey: string;
  header: string;
  excelColumn: string;
  shouldAdd: boolean;
  isCommonValue: boolean;
  menuLabels: MenuKey[];
}

export interface QrColumnMeta {
  columnKey: string;
  header: string;
  excelColumn: string;
  shouldAdd: boolean;
  isCommonValue: boolean;
}

export interface JoinedRow extends ExcelRow {
  __matchStatus: "CONCILIADO" | "SIN_PAGO_UNO";
  __joinKey: string;
  __pagoMatches: number;
  __qrMatches?: number;
  __differenceAmount: number | null;
  __qrDifferenceAmount?: number | null;
  __paymentGroup: string;
  __paymentChannel: string;
  __paymentSubgroup: string;
  __saleAmount: number;
  __provinceAmount: number;
  __entradaUnoAmount: number;
  __ticketCount: number;
  __schAmount: number;
  __operationMonth: string;
}

export interface ReconciliationSummary {
  entradaRows: number;
  pagoRows: number;
  qrRows: number;
  matchedRows: number;
  unmatchedRows: number;
  qrMatchedRows: number;
  duplicatePagoKeys: number;
  duplicateQrKeys: number;
  totalEntrada: number;
  totalProvincia: number;
  totalEntradaUno: number;
  totalPagoConciliado: number;
  totalQrConciliado: number;
  diferenciaTotal: number;
  diferenciaQrTotal: number;
}

export interface ReconciliationResult {
  rows: JoinedRow[];
  pagoColumnsToAdd: PagoColumnMeta[];
  qrColumnsToAdd: QrColumnMeta[];
  allColumns: string[];
  summary: ReconciliationSummary;
}

const DEFAULT_ENTRADA_HEADER_ROW_INDEX = 3;
const DEFAULT_PAGO_MENU_TC_ROW_INDEX = 0;
const DEFAULT_PAGO_MENU_BORDEREAUX_ROW_INDEX = 1;
const DEFAULT_PAGO_MENU_ENTRADA_ROW_INDEX = 2;
const DEFAULT_PAGO_ACTION_ROW_INDEX = 3;
const DEFAULT_PAGO_HEADER_ROW_INDEX = 4;
const DEFAULT_QR_HEADER_ROW_INDEX = 0;

const QR_YELLOW_HEADERS = new Set([
  "id operacion",
  "confirmada",
  "devuelta",
  "fechadecompra",
  "fechadepago",
  "cliente",
  "dni",
  "billetera",
  "bruto",
  "descuento",
  "neto",
  "status",
  "devo_voucher_type",
  "devo_voucher_code",
  "devo_voucher_datetime",
]);

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeHeader(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, "");
}

function normalizeKey(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.replace(/\.0$/, "");
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").replace(/\./g, "").replace(",", ".").replace(/[^0-9.-]/g, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}


function getRowValueByHeaders(row: ExcelRow, headers: string[]): unknown {
  for (const header of headers) {
    if (Object.prototype.hasOwnProperty.call(row, header)) return row[header];
  }
  const normalizedTargets = new Set(headers.map((header) => normalizeHeader(header)));
  for (const [key, value] of Object.entries(row)) {
    if (normalizedTargets.has(normalizeHeader(key))) return value;
  }
  return undefined;
}

function getProvinceBaseAmount(row: ExcelRow): number {
  return toNumber(getRowValueByHeaders(row, [
    "Precio Final S/Interés",
    "Precio Final S/Interes",
    "Precio Final S Interés",
    "Precio Final S Interes",
    "Precio Final S/Int.",
    "Precio Final Sin Interés",
    "Precio Final Sin Interes",
  ]));
}

function getEntradaUnoAmount(row: ExcelRow): number {
  return toNumber(getRowValueByHeaders(row, [
    "Valor SCH",
    "ValorSCH",
    "SCH",
  ]));
}

function getTicketCount(row: ExcelRow): number {
  return toNumber(getRowValueByHeaders(row, [
    "Cant Ticket",
    "Cant Tickets",
    "Cant. Ticket",
    "Cant. Tickets",
    "Cantidad Ticket",
    "Cantidad Tickets",
    "Tickets",
  ]));
}

function getOperationMonth(row: ExcelRow): string {
  const raw = String(getRowValueByHeaders(row, [
    "Alta de Op.",
    "Alta de Op",
    "FechaDeCompra",
    "FechaDePago",
    "Fecha Funcion",
    "Fecha Función",
  ]) ?? "").trim();
  const direct = raw.match(/^(\d{4})[-/](\d{1,2})/);
  if (direct) return `${direct[1]}-${direct[2].padStart(2, "0")}`;
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}`;
  return "";
}

export function classifyPaymentGroup(value: unknown): string {
  const text = normalizeText(value);
  if (text.includes("efectivo")) return "EFECTIVO";
  if (text.includes("qr")) return "QR";
  if (text.includes("tarjeta") || text.includes("credito") || text.includes("debito")) return "TARJETA_CREDITO_DEBITO";
  if (text.includes("sin cargo")) return "SIN_CARGO";
  return text ? "OTRO" : "SIN_DEFINIR";
}

export function classifyPaymentChannel(row: ExcelRow): string {
  const canal = normalizeText(row["Canal"]);
  const usuario = normalizeText(row["Usuario De Alta"]);
  if (canal.includes("web") || usuario.includes("web")) return "WEB";
  if (canal.includes("boleteria")) return "BOLETERIA";
  return "SIN_DEFINIR";
}

export function buildPaymentSubgroup(group: string, channel: string): string {
  if (group === "TARJETA_CREDITO_DEBITO" && channel === "WEB") return "TARJETA_CREDITO_DEBITO_WEB";
  if (group === "TARJETA_CREDITO_DEBITO" && channel === "BOLETERIA") return "TARJETA_CREDITO_DEBITO_BOLETERIA";
  return group;
}

function worksheetRows(workbook: XLSX.WorkBook, sheetName: string): unknown[][] {
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false }) as unknown[][];
}

function firstSheetRows(workbook: XLSX.WorkBook): unknown[][] {
  return worksheetRows(workbook, workbook.SheetNames[0]);
}

function findHeaderRow(rows: unknown[][], requiredHeaders: string[], fallbackIndex: number): number {
  const normalizedRequired = requiredHeaders.map(normalizeHeader);
  const searchLimit = Math.min(rows.length, 25);

  for (let rowIndex = 0; rowIndex < searchLimit; rowIndex += 1) {
    const normalizedCells = (rows[rowIndex] ?? []).map(normalizeHeader);
    const matched = normalizedRequired.every((required) => normalizedCells.includes(required));
    if (matched) return rowIndex;
  }

  return fallbackIndex;
}

function findSheetRowsByHeader(workbook: XLSX.WorkBook, requiredHeaders: string[], preferredNames: string[] = []): unknown[][] {
  const normalizedPreferred = preferredNames.map(normalizeText);
  const orderedSheetNames = [
    ...workbook.SheetNames.filter((name) => normalizedPreferred.includes(normalizeText(name))),
    ...workbook.SheetNames.filter((name) => !normalizedPreferred.includes(normalizeText(name))),
  ];

  for (const sheetName of orderedSheetNames) {
    const rows = worksheetRows(workbook, sheetName);
    const headerIndex = findHeaderRow(rows, requiredHeaders, -1);
    if (headerIndex >= 0) return rows;
  }

  return firstSheetRows(workbook);
}

function excelColumnName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function rowToObjects(rows: unknown[][], headerIndex: number, startIndex: number): ExcelRow[] {
  const headerRow = rows[headerIndex] ?? [];
  const headers = headerRow.map((header, index) => String(header || `Columna ${excelColumnName(index)}`).trim());

  return rows
    .slice(startIndex)
    .filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""))
    .map((row) => {
      const item: ExcelRow = {};
      headers.forEach((header, index) => {
        item[header] = row[index] as string | number | boolean | null | undefined;
      });
      return item;
    });
}

function resolveMenuLabels(rows: unknown[][], columnIndex: number, headerIndex: number): MenuKey[] {
  const labels: MenuKey[] = [];
  if (normalizeText(rows[headerIndex - 2]?.[columnIndex]) === "entrada 1") labels.push("entrada1");
  if (normalizeText(rows[headerIndex - 3]?.[columnIndex]) === "bordereaux") labels.push("bordereaux");
  if (normalizeText(rows[headerIndex - 4]?.[columnIndex]) === "conciliacion tc") labels.push("conciliacionTC");

  // Fallback para archivos con el diseño original: filas 1, 2 y 3 antes del encabezado.
  if (!labels.length) {
    if (normalizeText(rows[DEFAULT_PAGO_MENU_ENTRADA_ROW_INDEX]?.[columnIndex]) === "entrada 1") labels.push("entrada1");
    if (normalizeText(rows[DEFAULT_PAGO_MENU_BORDEREAUX_ROW_INDEX]?.[columnIndex]) === "bordereaux") labels.push("bordereaux");
    if (normalizeText(rows[DEFAULT_PAGO_MENU_TC_ROW_INDEX]?.[columnIndex]) === "conciliacion tc") labels.push("conciliacionTC");
  }

  return labels;
}

function getPagoColumnsToAdd(rows: unknown[][], headerIndex: number): PagoColumnMeta[] {
  const headers = rows[headerIndex] ?? [];
  const actionRow = rows[headerIndex - 1] ?? rows[DEFAULT_PAGO_ACTION_ROW_INDEX] ?? [];

  return headers
    .map((header, index): PagoColumnMeta => {
      const action = normalizeText(actionRow[index]);
      const safeHeader = String(header || `Columna ${excelColumnName(index)}`).trim();
      return {
        columnKey: safeHeader,
        header: safeHeader,
        excelColumn: excelColumnName(index),
        shouldAdd: action === "sumar",
        isCommonValue: action === "valor comun",
        menuLabels: resolveMenuLabels(rows, index, headerIndex),
      };
    })
    .filter((meta) => meta.shouldAdd || meta.isCommonValue);
}

function getQrColumnsToAdd(rows: unknown[][], headerIndex: number): QrColumnMeta[] {
  const headers = rows[headerIndex] ?? [];
  return headers
    .map((header, index): QrColumnMeta => {
      const safeHeader = String(header || `Columna ${excelColumnName(index)}`).trim();
      const normalized = normalizeHeader(safeHeader);
      return {
        columnKey: safeHeader,
        header: safeHeader,
        excelColumn: excelColumnName(index),
        shouldAdd: QR_YELLOW_HEADERS.has(normalized),
        isCommonValue: normalized === "idoperacion",
      };
    })
    .filter((meta) => meta.shouldAdd || meta.isCommonValue);
}

function buildIndex(rows: ExcelRow[], keyField: string): Map<string, ExcelRow[]> {
  const index = new Map<string, ExcelRow[]>();
  for (const row of rows) {
    const key = normalizeKey(row[keyField]);
    if (!key) continue;
    const current = index.get(key) ?? [];
    current.push(row);
    index.set(key, current);
  }
  return index;
}

function sumRows(rows: ExcelRow[], field: string): number {
  return rows.reduce((acc, row) => acc + toNumber(row[field]), 0);
}

function joinRows(rows: ExcelRow[], field: string): string {
  return rows.map((row) => row[field]).filter((value) => String(value ?? "").trim() !== "").join(" | ");
}

function collectExportColumns(rows: JoinedRow[]): string[] {
  const priority = [
    "Orden#",
    "Estado",
    "Alta de Op.",
    "Cliente",
    "DNI",
    "Email",
    "Formas De Pago",
    "Producto",
    "Precio Final",
    "Código Operación",
    "__paymentGroup",
    "__paymentChannel",
    "__paymentSubgroup",
    "__saleAmount",
    "Resultado Conciliación Contable",
    "Observación Conciliación",
    "Provincia 100%",
    "Entrada UNO 10%",
    "Estado Revisión",
    "__matchStatus",
    "__joinKey",
    "__pagoMatches",
    "__qrMatches",
    "__differenceAmount",
    "__qrDifferenceAmount",
  ];
  const seen = new Set<string>();
  const columns: string[] = [];

  for (const column of priority) {
    if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, column))) {
      columns.push(column);
      seen.add(column);
    }
  }

  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (seen.has(column)) continue;
      columns.push(column);
      seen.add(column);
    }
  }

  return columns;
}

export function labelColumn(column: string): string {
  return column
    .replace("__matchStatus", "Estado Conciliación")
    .replace("__joinKey", "Clave de Unión")
    .replace("__pagoMatches", "Cantidad Pagos Pago UNO")
    .replace("__qrMatches", "Cantidad Pagos QR")
    .replace("__differenceAmount", "Diferencia Entrada vs Pago UNO")
    .replace("__qrDifferenceAmount", "Diferencia Entrada vs QR")
    .replace("__paymentGroup", "Medio de Pago")
    .replace("__paymentChannel", "Canal de Pago")
    .replace("__paymentSubgroup", "Tipo de Consulta")
    .replace("__saleAmount", "Total Venta 110%");
}

export function visibleColumnsByMenu(allColumns: string[], pagoColumns: PagoColumnMeta[], menu: MenuKey): string[] {
  if (menu === "archivoCompleto") return allColumns;

  const baseColumns = [
    "Orden#",
    "Estado",
    "Alta de Op.",
    "Cliente",
    "DNI",
    "Email",
    "Formas De Pago",
    "Producto",
    "Precio Final",
    "Código Operación",
    "__paymentGroup",
    "__paymentChannel",
    "__paymentSubgroup",
    "__saleAmount",
    "Resultado Conciliación Contable",
    "Observación Conciliación",
    "Provincia 100%",
    "Entrada UNO 10%",
    "Estado Revisión",
    "__matchStatus",
    "__joinKey",
    "__pagoMatches",
    "__qrMatches",
    "__differenceAmount",
    "__qrDifferenceAmount",
  ];

  const menuColumns = pagoColumns
    .filter((column) => column.shouldAdd && column.menuLabels.includes(menu))
    .map((column) => `Pago UNO - ${column.header}`);

  const qrColumns = allColumns.filter((column) => column.startsWith("QR - "));

  return Array.from(new Set([...baseColumns, ...menuColumns, ...qrColumns])).filter((column) => allColumns.includes(column));
}

export function processBuffers(entradaBuffer: Buffer, pagoBuffer: Buffer, qrBuffer?: Buffer): ReconciliationResult {
  const entradaWorkbook = XLSX.read(entradaBuffer, { type: "buffer", cellDates: true, raw: false });
  const pagoWorkbook = XLSX.read(pagoBuffer, { type: "buffer", cellDates: true, raw: false });
  const qrWorkbook = qrBuffer ? XLSX.read(qrBuffer, { type: "buffer", cellDates: true, raw: false }) : null;

  const entradaRowsRaw = findSheetRowsByHeader(entradaWorkbook, ["Orden#", "Estado", "Precio Final"], ["Enero a Mayo", "Sheet"]);
  const pagoRowsRaw = findSheetRowsByHeader(pagoWorkbook, ["ID de Operación", "Monto"], ["Pago UNO", "Sheet"]);
  const qrRowsRaw = qrWorkbook ? findSheetRowsByHeader(qrWorkbook, ["id Operacion", "Bruto", "Neto"], ["Sheet", "Datos", "Hoja2"]) : [];

  const entradaHeaderIndex = findHeaderRow(entradaRowsRaw, ["Orden#", "Estado", "Precio Final"], DEFAULT_ENTRADA_HEADER_ROW_INDEX);
  const pagoHeaderIndex = findHeaderRow(pagoRowsRaw, ["ID de Operación", "Monto"], DEFAULT_PAGO_HEADER_ROW_INDEX);
  const qrHeaderIndex = qrWorkbook ? findHeaderRow(qrRowsRaw, ["id Operacion", "Bruto", "Neto"], DEFAULT_QR_HEADER_ROW_INDEX) : DEFAULT_QR_HEADER_ROW_INDEX;

  const entradaRows = rowToObjects(entradaRowsRaw, entradaHeaderIndex, entradaHeaderIndex + 1);
  const pagoRows = rowToObjects(pagoRowsRaw, pagoHeaderIndex, pagoHeaderIndex + 1);
  const qrRows = qrWorkbook ? rowToObjects(qrRowsRaw, qrHeaderIndex, qrHeaderIndex + 1) : [];

  const pagoColumnsToAdd = getPagoColumnsToAdd(pagoRowsRaw, pagoHeaderIndex);
  const qrColumnsToAdd = qrWorkbook ? getQrColumnsToAdd(qrRowsRaw, qrHeaderIndex) : [];
  if (!entradaRows.length || !entradaRows.some((row) => normalizeKey(row["Orden#"]))) {
    throw new Error("No se detectó correctamente el encabezado de Entrada UNO. Verificar que exista la columna Orden#.");
  }

  if (!pagoRows.length || !pagoRows.some((row) => normalizeKey(row["ID de Operación"]))) {
    throw new Error("No se detectó correctamente el encabezado de Pago UNO. Verificar que exista la columna ID de Operación.");
  }

  if (qrWorkbook && qrRows.length && !qrRows.some((row) => normalizeKey(row["id Operacion"]))) {
    throw new Error("No se detectó correctamente la hoja de detalle QR. Verificar que exista la columna id Operacion.");
  }

  const pagoIndex = buildIndex(pagoRows, "ID de Operación");
  const qrIndex = buildIndex(qrRows, "id Operacion");

  let matchedRows = 0;
  let unmatchedRows = 0;
  let qrMatchedRows = 0;
  let totalEntrada = 0;
  let totalProvincia = 0;
  let totalEntradaUno = 0;
  let totalPagoConciliado = 0;
  let totalQrConciliado = 0;

  const rows: JoinedRow[] = entradaRows.map((entradaRow) => {
    const joinKey = normalizeKey(entradaRow["Orden#"]);
    const pagoMatches = pagoIndex.get(joinKey) ?? [];
    const qrMatches = qrIndex.get(joinKey) ?? [];
    const matched = pagoMatches.length > 0;
    const qrMatched = qrMatches.length > 0;
    const provinceBaseAmount = getProvinceBaseAmount(entradaRow);
    const entradaUnoAmount = getEntradaUnoAmount(entradaRow);
    const ticketCount = getTicketCount(entradaRow);
    const operationMonth = getOperationMonth(entradaRow);
    // Regla contable corregida:
    // Total Venta 110% = Provincia 100% + Entrada UNO 10%
    // Provincia 100% = Precio Final S/Interés
    // Entrada UNO 10% = Valor SCH
    const entradaAmount = provinceBaseAmount + entradaUnoAmount;
    const pagoAmount = sumRows(pagoMatches, "Monto");
    const qrGrossAmount = sumRows(qrMatches, "Bruto");
    const qrNetAmount = sumRows(qrMatches, "Neto");

    totalEntrada += entradaAmount;
    totalProvincia += provinceBaseAmount;
    totalEntradaUno += entradaUnoAmount;
    if (matched) totalPagoConciliado += pagoAmount;
    if (qrMatched) totalQrConciliado += qrGrossAmount || qrNetAmount;
    if (matched) matchedRows += 1;
    else unmatchedRows += 1;
    if (qrMatched) qrMatchedRows += 1;

    const paymentGroup = classifyPaymentGroup(entradaRow["Formas De Pago"]);
    const paymentChannel = classifyPaymentChannel(entradaRow);
    const paymentSubgroup = buildPaymentSubgroup(paymentGroup, paymentChannel);

    const output: JoinedRow = {
      ...entradaRow,
      __matchStatus: matched ? "CONCILIADO" : "SIN_PAGO_UNO",
      __joinKey: joinKey,
      __pagoMatches: pagoMatches.length,
      __qrMatches: qrMatches.length,
      __differenceAmount: matched ? entradaAmount - pagoAmount : null,
      __qrDifferenceAmount: qrMatched ? entradaAmount - (qrGrossAmount || qrNetAmount) : null,
      __paymentGroup: paymentGroup,
      __paymentChannel: paymentChannel,
      __paymentSubgroup: paymentSubgroup,
      __saleAmount: entradaAmount,
      __provinceAmount: provinceBaseAmount,
      __entradaUnoAmount: entradaUnoAmount,
      __ticketCount: ticketCount,
      __schAmount: entradaUnoAmount,
      __operationMonth: operationMonth,
    };

    for (const column of pagoColumnsToAdd) {
      if (!column.shouldAdd) continue;
      const value = column.header === "Monto"
        ? pagoAmount
        : joinRows(pagoMatches, column.header);
      output[`Pago UNO - ${column.header}`] = value;
    }

    for (const column of qrColumnsToAdd) {
      if (!column.shouldAdd) continue;
      let value: string | number = joinRows(qrMatches, column.header);
      if (["Bruto", "Descuento", "Neto"].includes(column.header)) value = sumRows(qrMatches, column.header);
      output[`QR - ${column.header}`] = value;
    }

    return output;
  });

  const duplicatePagoKeys = Array.from(pagoIndex.values()).filter((items) => items.length > 1).length;
  const duplicateQrKeys = Array.from(qrIndex.values()).filter((items) => items.length > 1).length;

  return {
    rows,
    pagoColumnsToAdd,
    qrColumnsToAdd,
    allColumns: collectExportColumns(rows),
    summary: {
      entradaRows: entradaRows.length,
      pagoRows: pagoRows.length,
      qrRows: qrRows.length,
      matchedRows,
      unmatchedRows,
      qrMatchedRows,
      duplicatePagoKeys,
      duplicateQrKeys,
      totalEntrada,
      totalProvincia,
      totalEntradaUno,
      totalPagoConciliado,
      totalQrConciliado,
      diferenciaTotal: totalEntrada - totalPagoConciliado,
      diferenciaQrTotal: totalEntrada - totalQrConciliado,
    },
  };
}

export function buildExcelBuffer(rows: JoinedRow[], columns: string[]): Buffer {
  const exportColumns = columns.length ? columns : collectExportColumns(rows);
  const headers = exportColumns.map(labelColumn);

  // Array-of-arrays evita crear objetos intermedios por cada fila (menor uso de RAM)
  const aoa: unknown[][] = [headers];
  for (const row of rows) {
    aoa.push(exportColumns.map((col) => row[col] ?? ""));
  }

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(worksheet["!ref"] ?? "A1:A1");
  worksheet["!autofilter"] = { ref: XLSX.utils.encode_range(range) };
  worksheet["!cols"] = exportColumns.map((column) => ({ wch: Math.min(Math.max(labelColumn(column).length + 4, 14), 42) }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Archivo Unificado Completo");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}
