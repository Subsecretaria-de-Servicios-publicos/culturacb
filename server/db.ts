import dotenv from "dotenv";
import pg from "pg";
import type { QueryResultRow } from "pg";

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5441/conciliacion_cultura_uno",
});

export async function query<T extends QueryResultRow = any>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params as any[]);
}
