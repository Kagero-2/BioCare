// dev-db.js — reset database DEV untuk skrip uji (database/reset.sql + seed.sql), dipakai
// scripts/test-api.js & scripts/test-e2e-node.mjs. PERINGATAN: semua data di database itu terhapus.
// Kredensial reset = user khusus hospital_reset (database/users.sql: INSERT + DROP di hospital_dapp saja),
// BUKAN root. Pembangunan skema (schema.sql: DROP DATABASE, CREATE TRIGGER) tetap root, manual.
// Pengaman (menolak jalan, exit 1, fail-closed):
//   - NODE_ENV wajib "development";
//   - DB_NAME wajib "hospital_dapp" (nama DB dev yang ditulis tetap di reset.sql & seed.sql);
//   - DB_HOST wajib lokal (127.0.0.1 / localhost / ::1);
//   - DB_RESET_USER wajib diisi dan BUKAN root;
//   - DB_RESET_PASSWORD wajib diisi (tidak boleh kosong).
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";

export const DEV_DB = "hospital_dapp";
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** Alasan menolak reset (string), atau null jika aman dijalankan. */
export function resetRefusal(env) {
  if (env.NODE_ENV !== "development") return `NODE_ENV harus "development" (sekarang: ${env.NODE_ENV || "kosong"})`;
  if (env.DB_NAME !== DEV_DB) return `DB_NAME harus database dev "${DEV_DB}" (sekarang: ${env.DB_NAME || "kosong"})`;
  if (!LOCAL_HOSTS.includes(env.DB_HOST)) return `DB_HOST harus lokal (${LOCAL_HOSTS.join(" / ")})`;
  if (!env.DB_RESET_USER) return "DB_RESET_USER wajib diisi di .env (user hospital_reset dari database/users.sql)";
  if (env.DB_RESET_USER.trim().toLowerCase() === "root") return "DB_RESET_USER tidak boleh root: pakai hospital_reset (database/users.sql, hak INSERT + DROP di hospital_dapp saja)";
  if (!env.DB_RESET_PASSWORD) return "DB_RESET_PASSWORD wajib diisi (tidak boleh kosong)";
  return null;
}

/** Kosongkan & seed ulang database dev sebagai DB_RESET_USER. Menolak (exit 1) jika pengaman gagal. */
export async function resetDevDb(env = process.env) {
  const why = resetRefusal(env);
  if (why) {
    console.error(`Menolak reset database (uji ini MENGHAPUS semua data): ${why}.`);
    process.exit(1);
  }
  let conn;
  try {
    conn = await mysql.createConnection({
      host: env.DB_HOST, port: Number(env.DB_PORT ?? 3306), database: env.DB_NAME,
      user: env.DB_RESET_USER, password: env.DB_RESET_PASSWORD, multipleStatements: true,
    });
  } catch (err) {
    console.error(`Tidak bisa konek MySQL sebagai ${env.DB_RESET_USER} untuk reset DB (${err.code}). Periksa DB_RESET_USER/DB_RESET_PASSWORD di .env dan jalankan database/users.sql.`);
    process.exit(1);
  }
  for (const f of ["reset.sql", "seed.sql"]) await conn.query(readFileSync(new URL(`../database/${f}`, import.meta.url), "utf8"));
  await conn.end();
}
