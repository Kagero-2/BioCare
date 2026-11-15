// server.js — Express: API /api/* + file statis frontend/ (same-origin, TANPA CORS).
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import config from "./config.js";
import { pool } from "./db.js";
import { checkContractDeployed } from "./chain.js";
import { ApiError } from "./lib/errors.js";
import { requireAuth, checkOrigin, rateLimit } from "./middleware/auth.js";
import authRouter from "./routes/auth.js";
import usersRouter, { adminPatientsRouter } from "./routes/users.js";
import recordsRouter, { prescriptionsRouter } from "./routes/records.js";
import { activityRouter, txLogRouter, statsRouter } from "./routes/activity.js";
import appointmentsRouter, { adminRouter } from "./routes/appointments.js";
import accessRouter from "./routes/access.js";

const app = express();

// Security headers. connect-src = 'self' + RPC lokal saja (login.js memanggil node Hardhat langsung
// lewat config.js checkContractDeployed); tidak ada domain eksternal.
// upgrade-insecure-requests dimatikan di development: aplikasi lokal berjalan di http://127.0.0.1,
// dan direktif itu membuat browser meminta https://127.0.0.1 (aset & RPC gagal dimuat).
// script-src/style-src/font-src hanya 'self' (tanpa unsafe-inline/unsafe-eval/https:): semua aset lokal
// (frontend/vendor), dan gaya dinamis di JS memakai CSSOM (element.style), bukan atribut style.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      "script-src": ["'self'"],
      "style-src": ["'self'"],
      "font-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'", new URL(config.RPC_URL).origin],
      "frame-ancestors": ["'none'"], // tidak boleh dibingkai siapa pun (clickjacking)
      "upgrade-insecure-requests": config.isDev ? null : [],
    },
  },
  frameguard: { action: "deny" },          // X-Frame-Options untuk browser lama
  referrerPolicy: { policy: "no-referrer" },
}));
// Fitur browser yang tidak dipakai aplikasi dimatikan (helmet tidak mengatur header ini).
app.use((req, res, next) => {
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()");
  next();
});

// Rate limit GLOBAL /api per IP (selain limit login di routes/auth.js): membatasi beban RPC & DB
// dari satu klien (endpoint seperti /api/activity membaca semua event tiap request).
app.use("/api", rateLimit({ limit: 300, windowMs: 60_000 }));
// Respons API berisi data pribadi/medis: jangan disimpan cache browser/proxy.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
// Anti-CSRF: request pengubah data ke /api wajib Origin == APP_ORIGIN (dicek sebelum body dibaca).
app.use("/api", checkOrigin);
app.use(express.json({ limit: "50kb" }));

// Login wallet (SIWE) + sesi. Endpoint lain di bawah butuh sesi valid (cookie JWT + auth_sessions).
app.use("/api/auth", authRouter);
app.use("/api/users", requireAuth, usersRouter);
app.use("/api/records", requireAuth, recordsRouter);
app.use("/api/prescriptions", requireAuth, prescriptionsRouter);
app.use("/api/appointments", requireAuth, appointmentsRouter);
app.use("/api/admin/patients", requireAuth, adminPatientsRouter);
app.use("/api/admin", requireAuth, adminRouter);
app.use("/api/access", requireAuth, accessRouter);
app.use("/api/activity", requireAuth, activityRouter);
app.use("/api/tx-log", requireAuth, txLogRouter);
app.use("/api/stats", requireAuth, statsRouter);
app.use("/api", (req, res, next) => next(new ApiError(404, "NOT_FOUND", "Endpoint tidak ditemukan.")));

// Frontend statis
app.use(express.static(fileURLToPath(new URL("../frontend", import.meta.url)), { index: "index.html" }));

// Error handler terpusat: detail hanya di log server; client menerima pesan umum + kode.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let e = err;
  if (err.type === "entity.parse.failed") e = new ApiError(400, "BAD_JSON", "Body bukan JSON yang valid.");
  else if (err.type === "entity.too.large") e = new ApiError(413, "PAYLOAD_TOO_LARGE", "Body request terlalu besar.");
  else if (err.code === "ER_DUP_ENTRY") e = new ApiError(409, "CONFLICT", "Data sudah ada.");
  // CHECK MariaDB (4025) / MySQL (3819); strict mode: teks terlalu panjang (1406) / nilai ENUM/kolom tidak valid (1265)
  else if ([4025, 3819, 1406, 1265].includes(err.errno)) e = new ApiError(400, "VALIDATION_ERROR", "Data tidak valid.");
  // Error 4xx lain dari Express/body-parser (mis. URL %-encoding rusak, charset tidak didukung):
  // kesalahan klien, bukan 500. Pesan tetap umum (tanpa err.message internal).
  else if (!(err instanceof ApiError) && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    e = new ApiError(err.status, "BAD_REQUEST", "Permintaan tidak valid.");
  }

  if (!(e instanceof ApiError)) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    e = new ApiError(500, "INTERNAL_ERROR", "Terjadi kesalahan pada server.");
  } else if (e.status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, e.message);
  }
  res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.fields ? { fields: e.fields } : {}) } });
});

// Gagal cepat: database harus terhubung DAN kontrak versi terbaru harus ada.
// Tanpa kontrak, semua cek role/akses akan 503, jadi server lebih baik tidak start sama sekali.
try {
  // Sekaligus memastikan strict mode & zona waktu WIB terpasang di koneksi pool (db.js).
  const [[s]] = await pool.query("SELECT @@SESSION.sql_mode AS mode, @@SESSION.time_zone AS tz");
  if (!s.mode.includes("STRICT_ALL_TABLES") || s.tz !== "+07:00") throw new Error(`sql_mode/time_zone tidak sesuai: ${s.mode} ${s.tz}`);
} catch (err) {
  console.error("Tidak bisa terhubung ke database:", err.code ?? err.message);
  process.exit(1);
}
try {
  await checkContractDeployed();
} catch (err) {
  console.error("Kontrak tidak siap:", err.message);
  process.exit(1);
}

app.listen(config.PORT, "127.0.0.1", () => {
  console.log(`BioCare: http://127.0.0.1:${config.PORT} (${config.NODE_ENV}); buka lewat ${config.APP_ORIGIN}`);
});
