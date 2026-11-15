// env-file.mjs — membuat & memeriksa .env untuk setup.mjs (fungsi murni, mudah diuji).
import { randomBytes } from "node:crypto";

export const JWT_PLACEHOLDER = "GANTI_DENGAN_SECRET_ACAK";
const PLACEHOLDER_PREFIX = "GANTI_DENGAN"; // placeholder lama dan variasi lain juga ditolak
export const REQUIRED = ["NODE_ENV", "PORT", "APP_ORIGIN", "JWT_SECRET", "RPC_URL", "CONTRACT_ADDRESS",
  "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME", "DB_RESET_USER", "DB_RESET_PASSWORD"];

const hex = (bytes) => randomBytes(bytes).toString("hex");

/** Isi .env baru dari template .env.example, dengan tiga secret acak. */
export function newEnvText(template, rnd = hex) {
  let text = template;
  for (const [key, bytes] of [["JWT_SECRET", 48], ["DB_PASSWORD", 24], ["DB_RESET_PASSWORD", 24]]) {
    const line = new RegExp(`^${key}=.*$`, "m");
    if (!line.test(text)) throw new Error(`.env.example tidak punya baris ${key}=`);
    text = text.replace(line, () => `${key}=${rnd(bytes)}`); // fungsi: "$" di nilai tidak ditafsirkan
  }
  return text;
}

/** Daftar masalah .env (hanya nama kunci, tidak pernah nilai). Kosong = siap dipakai. */
export function envProblems(env) {
  const out = [];
  const empty = REQUIRED.filter((k) => !env[k]?.trim());
  if (empty.length) out.push(`kunci kosong/hilang: ${empty.join(", ")}`);
  if (env.JWT_SECRET && (env.JWT_SECRET.startsWith(PLACEHOLDER_PREFIX) || Buffer.byteLength(env.JWT_SECRET) < 32)) out.push("JWT_SECRET masih placeholder atau kurang dari 32 byte (lihat README bagian Konfigurasi (.env))");
  for (const [key, want] of [["DB_USER", "hospital_app"], ["DB_RESET_USER", "hospital_reset"]]) {
    const v = env[key]?.trim();
    if (!v) continue;
    if (v.toLowerCase() === "root") out.push(`${key} tidak boleh root`);
    else if (v !== want) out.push(`${key} harus ${want} (user yang dibuat database/users.sql)`);
  }
  if (env.DB_NAME && env.DB_NAME !== "hospital_dapp") out.push("DB_NAME harus hospital_dapp");
  return out;
}

/** String literal SQL yang aman untuk nilai apa pun (escape \ dan '). */
export const sqlString = (s) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/**
 * users.sql dengan kedua placeholder password diganti nilai dari .env. ALTER USER ditambahkan di akhir karena
 * CREATE USER IF NOT EXISTS tidak mengubah password akun yang sudah ada (pemasangan ulang): .env acuannya.
 */
export function renderUsersSql(sql, env) {
  const app = "'GANTI_DENGAN_PASSWORD_KUAT'", reset = "'GANTI_DENGAN_PASSWORD_RESET_KUAT'";
  if (!sql.includes(app) || !sql.includes(reset)) throw new Error("placeholder password tidak ditemukan di users.sql");
  const out = sql.replaceAll(app, () => sqlString(env.DB_PASSWORD)).replaceAll(reset, () => sqlString(env.DB_RESET_PASSWORD));
  if (out.includes("GANTI_DENGAN")) throw new Error("masih ada placeholder di users.sql setelah diganti");
  const alter = [["hospital_app", env.DB_PASSWORD], ["hospital_reset", env.DB_RESET_PASSWORD]]
    .flatMap(([user, pw]) => ["localhost", "127.0.0.1"].map((host) => `ALTER USER '${user}'@'${host}' IDENTIFIED BY ${sqlString(pw)};`));
  return `${out}\n${alter.join("\n")}\n`;
}
