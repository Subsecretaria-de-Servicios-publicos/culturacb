import * as XLSX from "xlsx";
import type { ExcelRow, JoinedRow, MenuKey, PagoColumnMeta, ReconciliationResult } from "../types/reconciliation";

const ENTRADA_HEADER_ROW_INDEX = 3; // Excel row 4
const ENTRADA_DATA_START_INDEX = 4; // Excel row 5
const PAGO_MENU_TC_ROW_INDEX = 0; // Excel row 1
const PAGO_MENU_BORDEREAUX_ROW_INDEX = 1; // Excel row 2
const PAGO_MENU_ENTRADA_ROW_INDEX = 2; // Excel row 3
const PAGO_ACTION_ROW_INDEX = 3; // Excel row 4
const PAGO_HEADER_ROW_INDEX = 4; // Excel row 5
const PAGO_DATA_START_INDEX = 5; // Excel row 6

export const REQUIRED_FILES = {
  entrada: "Entrada UNO - Operaciones",
  pago: "Pago UNO Operaciones",
};

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeKey(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.replace(/\.0$/, "");
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").replace(/\./g, "").replace(",", ".").replace(/[^0-9.-]/g, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readWorkbook(file: File): Promise<XLSX.WorkBook> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = new Uint8Array(reader.result as ArrayBuffer);
        resolve(XLSX.read(data, { type: "array", cellDates: true, raw: false }));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function firstSheetRows(workbook: XLSX.WorkBook): unknown[][] {
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false }) as unknown[][];
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
  const headers = rows[headerIndex].map((header, index) => String(header || `Columna ${excelColumnName(index)}`).trim());
  return rows.slice(startIndex).filter((row) => row.some((cell) => String(cell ?? "").trim() !== "")).map((row) => {
    const item: ExcelRow = {};
    headers.forEach((header, index) => {
      item[header] = row[index] as string | number | boolean | null | undefined;
    });
    return item;
  });
}

function resolveMenuLabels(rows: unknown[][], columnIndex: number): MenuKey[] {
  const labels: MenuKey[] = [];
  if (normalizeText(rows[PAGO_MENU_ENTRADA_ROW_INDEX]?.[columnIndex]) === "entrada 1") labels.push("entrada1");
  if (normalizeText(rows[PAGO_MENU_BORDEREAUX_ROW_INDEX]?.[columnIndex]) === "bordereaux") labels.push("bordereaux");
  if (normalizeText(rows[PAGO_MENU_TC_ROW_INDEX]?.[columnIndex]) === "conciliacion tc") labels.push("conciliacionTC");
  return labels;
}

function getPagoColumnsToAdd(rows: unknown[][]): PagoColumnMeta[] {
  const headers = rows[PAGO_HEADER_ROW_INDEX];
  const actionRow = rows[PAGO_ACTION_ROW_INDEX];
  return headers.map((header, index): PagoColumnMeta => {
    const action = normalizeText(actionRow[index]);
    return {
      columnKey: String(header || `Columna ${excelColumnName(index)}`).trim(),
      header: String(header || `Columna ${excelColumnName(index)}`).trim(),
      excelColumn: excelColumnName(index),
      shouldAdd: action === "sumar",
      isCommonValue: action === "valor comun",
      menuLabels: resolveMenuLabels(rows, index),
    };
  }).filter((meta) => meta.shouldAdd || meta.isCommonValue);
}

function buildPagoIndex(pagoRows: ExcelRow[]): Map<string, ExcelRow[]> {
  const index = new Map<string, ExcelRow[]>();
  for (const row of pagoRows) {
    const key = normalizeKey(row["ID de Operación"]);
    if (!key) continue;
    const current = index.get(key) ?? [];
    current.push(row);
    index.set(key, current);
  }
  return index;
}

function sumPagoRows(rows: ExcelRow[], field: string): number {
  return rows.reduce((acc, row) => acc + toNumber(row[field]), 0);
}

export function filterRowsByMenu(rows: JoinedRow[], columns: PagoColumnMeta[], menu: MenuKey): { rows: JoinedRow[]; visibleColumns: string[] } {
  const baseColumns = ["Orden#", "Estado", "Alta de Op.", "Cliente", "DNI", "Email", "Formas De Pago", "Producto", "Precio Final", "Código Operación", "__matchStatus", "__joinKey", "__pagoMatches", "__differenceAmount"];
  const menuColumns = columns
    .filter((column) => column.shouldAdd && column.menuLabels.includes(menu))
    .map((column) => `Pago UNO - ${column.header}`);
  const visibleColumns = Array.from(new Set([...baseColumns, ...menuColumns]));
  return { rows, visibleColumns };
}

export async function processFiles(entradaFile: File, pagoFile: File): Promise<ReconciliationResult> {
  const [entradaWorkbook, pagoWorkbook] = await Promise.all([readWorkbook(entradaFile), readWorkbook(pagoFile)]);
  const entradaRowsRaw = firstSheetRows(entradaWorkbook);
  const pagoRowsRaw = firstSheetRows(pagoWorkbook);

  const entradaRows = rowToObjects(entradaRowsRaw, ENTRADA_HEADER_ROW_INDEX, ENTRADA_DATA_START_INDEX);
  const pagoRows = rowToObjects(pagoRowsRaw, PAGO_HEADER_ROW_INDEX, PAGO_DATA_START_INDEX);
  const pagoColumnsToAdd = getPagoColumnsToAdd(pagoRowsRaw);
  const pagoIndex = buildPagoIndex(pagoRows);

  let matchedRows = 0;
  let unmatchedRows = 0;
  let totalEntrada = 0;
  let totalPagoConciliado = 0;

  const rows: JoinedRow[] = entradaRows.map((entradaRow) => {
    const joinKey = normalizeKey(entradaRow["Orden#"]);
    const pagoMatches = pagoIndex.get(joinKey) ?? [];
    const matched = pagoMatches.length > 0;
    const entradaAmount = toNumber(entradaRow["Precio Final"]);
    const pagoAmount = sumPagoRows(pagoMatches, "Monto");

    totalEntrada += entradaAmount;
    if (matched) totalPagoConciliado += pagoAmount;
    if (matched) matchedRows += 1;
    else unmatchedRows += 1;

    const output: JoinedRow = {
      ...entradaRow,
      __matchStatus: matched ? "CONCILIADO" : "SIN_PAGO_UNO",
      __joinKey: joinKey,
      __pagoMatches: pagoMatches.length,
      __differenceAmount: matched ? entradaAmount - pagoAmount : null,
    };

    for (const column of pagoColumnsToAdd) {
      if (!column.shouldAdd) continue;
      const value = column.header === "Monto"
        ? pagoAmount
        : pagoMatches.map((row) => row[column.header]).filter((value) => String(value ?? "").trim() !== "").join(" | ");
      output[`Pago UNO - ${column.header}`] = value;
    }

    return output;
  });

  const duplicatePagoKeys = Array.from(pagoIndex.values()).filter((items) => items.length > 1).length;

  return {
    rows,
    pagoColumnsToAdd,
    summary: {
      entradaRows: entradaRows.length,
      pagoRows: pagoRows.length,
      matchedRows,
      unmatchedRows,
      duplicatePagoKeys,
      totalEntrada,
      totalPagoConciliado,
      diferenciaTotal: totalEntrada - totalPagoConciliado,
    },
  };
}


function exportHeaderName(column: string): string {
  return column
    .replace("__matchStatus", "Estado Conciliación")
    .replace("__joinKey", "Clave de Unión")
    .replace("__pagoMatches", "Cantidad Pagos Pago UNO")
    .replace("__differenceAmount", "Diferencia Entrada vs Pago UNO");
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
    "__matchStatus",
    "__joinKey",
    "__pagoMatches",
    "__differenceAmount",
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

export function exportRowsToExcel(rows: JoinedRow[], filename: string): void {
  const exportColumns = collectExportColumns(rows);
  const data = rows.map((row) => {
    const output: Record<string, unknown> = {};
    for (const column of exportColumns) {
      output[exportHeaderName(column)] = row[column];
    }
    return output;
  });

  const worksheet = XLSX.utils.json_to_sheet(data, { header: exportColumns.map(exportHeaderName) });
  const range = XLSX.utils.decode_range(worksheet["!ref"] ?? "A1:A1");

  worksheet["!autofilter"] = { ref: XLSX.utils.encode_range(range) };
  worksheet["!cols"] = exportColumns.map((column) => ({ wch: Math.min(Math.max(exportHeaderName(column).length + 4, 14), 38) }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Conciliacion Completa");
  XLSX.writeFile(workbook, filename);
}
