import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { pool, query } from "./db";
import { hashPassword } from "./auth";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = await fs.readFile(path.join(__dirname, "database.sql"), "utf8");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase(maxAttempts = 40) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      if (attempt > 1) console.log("PostgreSQL listo.");
      return;
    } catch (error) {
      lastError = error;
      console.log(`Esperando PostgreSQL... intento ${attempt}/${maxAttempts}`);
      await sleep(1000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No se pudo conectar a PostgreSQL.");
}

try {
  await waitForDatabase();
  await pool.query(sql);

  const adminEmail = process.env.ADMIN_EMAIL || "admin@conciliacion.local";
  const adminPassword = process.env.ADMIN_PASSWORD || "Admin1234";
  const adminName = process.env.ADMIN_NAME || "Administrador";

  const existing = await query(`SELECT id FROM app_users WHERE email = $1`, [adminEmail.toLowerCase()]);
  if (!existing.rowCount) {
    await query(
      `INSERT INTO app_users (id, email, full_name, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'ADMIN', TRUE)`,
      [crypto.randomUUID(), adminEmail.toLowerCase(), adminName, hashPassword(adminPassword)],
    );
    console.log(`Usuario administrador creado: ${adminEmail} / ${adminPassword}`);
  } else {
    console.log(`Usuario administrador existente: ${adminEmail}`);
  }

  console.log("Base de datos inicializada correctamente.");
} finally {
  await pool.end();
}
