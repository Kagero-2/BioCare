// config.js — baca & validasi .env SAAT START. Gagal cepat (exit) jika ada yang salah,
// supaya server tidak pernah berjalan dengan konfigurasi setengah jadi.
import { isAddress } from "ethers";

// .env di root proyek. Variabel yang sudah ada di environment TIDAK ditimpa.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch (err) {
  if (err.code !== "ENOENT") throw err; // .env boleh tidak ada jika variabel diset dari luar
}

const env = process.env;
const errors = [];
const required = (name) => {
  const v = env[name];
  if (v === undefined || v.trim() === "") errors.push(`${name} wajib diisi`);
  return v?.trim();
};
const port = (name, fallback) => {
  const v = Number(env[name] ?? fallback);
  if (!Number.isInteger(v) || v < 1 || v > 65535) errors.push(`${name} harus nomor port 1–65535`);
  return v;
};

const NODE_ENV = env.NODE_ENV === "development" ? "development" : "production"; // default aman: production

// Placeholder di .env.example. HARUS sama persis dengan baris JWT_SECRET di .env.example:
// server menolak start jika secret masih placeholder (secret publik = siapa pun bisa memalsukan JWT).
// Nilai apa pun yang diawali GANTI_DENGAN dianggap placeholder (termasuk placeholder versi lama).
export const JWT_SECRET_PLACEHOLDER = "GANTI_DENGAN_SECRET_ACAK";
export const JWT_SECRET_PLACEHOLDER_PREFIX = "GANTI_DENGAN";

const config = {
  NODE_ENV,
  isDev: NODE_ENV === "development",
  PORT: port("PORT", 3000),
  RPC_URL: required("RPC_URL"),
  CHAIN_ID: 31337, // Hardhat Network
  CONTRACT_ADDRESS: required("CONTRACT_ADDRESS"),
  // Origin tempat aplikasi dibuka, mis. http://127.0.0.1:3000. Dipakai untuk cek header Origin
  // (anti-CSRF) dan sebagai domain/URI pesan login SIWE.
  APP_ORIGIN: required("APP_ORIGIN"),
  JWT_SECRET: env.JWT_SECRET ?? "", // TIDAK di-trim: dipakai apa adanya sebagai kunci HMAC
  DB: {
    host: required("DB_HOST"),
    port: port("DB_PORT", 3306),
    user: required("DB_USER"),
    password: env.DB_PASSWORD ?? "",
    database: required("DB_NAME"),
  },
};

if (config.CONTRACT_ADDRESS && !isAddress(config.CONTRACT_ADDRESS)) errors.push("CONTRACT_ADDRESS bukan alamat Ethereum yang valid");
if (config.RPC_URL && !/^https?:\/\//.test(config.RPC_URL)) errors.push("RPC_URL harus diawali http:// atau https://");
if (config.APP_ORIGIN) {
  let origin = null;
  try { origin = new URL(config.APP_ORIGIN).origin; } catch { /* ditolak di bawah */ }
  // Harus origin murni (skema + host + port, tanpa "/" di akhir) agar sama persis dengan header Origin browser.
  if (origin !== config.APP_ORIGIN || !/^https?:\/\//.test(origin)) errors.push("APP_ORIGIN harus origin murni, mis. http://127.0.0.1:3000 (tanpa / di akhir)");
}
if (config.JWT_SECRET.startsWith(JWT_SECRET_PLACEHOLDER_PREFIX)) errors.push("JWT_SECRET masih placeholder dari .env.example; buat secret acak (lihat README bagian Konfigurasi (.env))");
else if (Buffer.byteLength(config.JWT_SECRET, "utf8") < 32) errors.push("JWT_SECRET wajib diisi, minimal 32 byte (lihat README bagian Konfigurasi (.env))");
if (env.DB_PASSWORD === undefined) errors.push("DB_PASSWORD wajib ada (boleh kosong hanya di development)");
else if (!config.isDev && config.DB.password === "") errors.push("DB_PASSWORD tidak boleh kosong di production");
if (!config.isDev && config.DB.user === "root") errors.push("DB_USER tidak boleh root di production (pakai hospital_app)");

if (errors.length) {
  console.error("Konfigurasi .env tidak valid:\n - " + errors.join("\n - "));
  process.exit(1);
}

config.CONTRACT_ADDRESS = config.CONTRACT_ADDRESS.toLowerCase();
export default Object.freeze(config);
