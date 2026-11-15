import config from "../config.js";
import { pool, withTransaction } from "../db.js";
import { msToWib, HOUR_MS } from "../lib/validate.js";
import { getRole, hasAccess } from "../chain.js";
import { ApiError, forbidden } from "../lib/errors.js";
import { REGISTERED } from "../lib/roles.js";
import { verifySession, readCookie } from "../lib/session.js";

const unauthenticated = () => new ApiError(401, "UNAUTHENTICATED", "Belum login atau sesi sudah berakhir.");

/**
 * Wajib login: cookie berisi JWT yang valid (lib/session.js) DAN jti-nya ada di auth_sessions,
 * belum dicabut (logout), belum kedaluwarsa. Header lain (mis. wallet di header/body) diabaikan.
 * req.wallet = satu-satunya sumber identitas pengguna di route.
 */
export async function requireAuth(req, res, next) {
  const s = await verifySession(readCookie(req));
  if (!s) return next(unauthenticated());
  const [rows] = await pool.execute(
    "SELECT 1 FROM auth_sessions WHERE jti = ? AND wallet_address = ? AND revoked_at IS NULL AND expires_at > NOW()",
    [s.jti, s.wallet],
  );
  if (rows.length !== 1) return next(unauthenticated());
  req.wallet = s.wallet;
  req.jti = s.jti;
  next();
}

/**
 * Anti-CSRF: setiap request yang MENGUBAH data (selain GET/HEAD/OPTIONS) wajib membawa header
 * Origin yang sama persis dengan APP_ORIGIN. Browser selalu mengirim Origin untuk POST/PUT/PATCH/DELETE
 * dari fetch, dan halaman lain tidak bisa memalsukannya. Tidak ada/berbeda -> 403 BAD_ORIGIN.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export function checkOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method) || req.get("Origin") === config.APP_ORIGIN) return next();
  next(new ApiError(403, "BAD_ORIGIN", "Permintaan ditolak: asal (Origin) permintaan tidak dikenali."));
}

/**
 * Rate limit sederhana per IP (jendela tetap): maksimal `limit` request per `windowMs`.
 * Kelebihan -> 429 + header Retry-After (detik). Yang dibatasi IP, BUKAN wallet/akun:
 * wallet tidak pernah dikunci setelah gagal login (penyerang tidak bisa mengunci akun orang lain).
 * shortcut: penghitung di memori satu proses (hilang saat restart, tidak dibagi antar-instance);
 * pakai penyimpanan bersama (mis. Redis) bila backend dijalankan lebih dari satu instance.
 */
export function rateLimit({ limit = 10, windowMs = 60_000 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.resetAt <= now) hits.set(req.ip, (h = { count: 0, resetAt: now + windowMs }));
    if (++h.count > limit) {
      res.set("Retry-After", String(Math.ceil((h.resetAt - now) / 1000)));
      return next(new ApiError(429, "RATE_LIMITED", "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi."));
    }
    next();
  };
}

/**
 * Izinkan hanya role tertentu. Role dibaca dari KONTRAK (chain.js) setiap request,
 * bukan dari input client / JWT. Menyimpan role di req.role untuk dipakai route.
 * Fail closed: kontrak tidak terbaca -> 503, enum tak dikenal -> 403 (dilempar getRole).
 * Harus dipasang setelah requireAuth.
 */
export function requireRole(...roles) {
  return async (req, res, next) => {
    req.role = await getRole(req.wallet);
    if (!roles.includes(req.role)) return next(forbidden());
    next();
  };
}

// Semua role terdaftar (bukan "unregistered"); sumber: lib/roles.js.
export { REGISTERED };

// Appointment kedaluwarsa
// Jam SERVER dalam WIB (sama dengan aturan H-1 di routes/appointments.js), bukan jam MySQL/browser.
// Parameter SQL = cutoffs(): [sekarang, sekarang - 24 jam] sebagai DATETIME WIB.
//   requested / rescheduled_by_doctor: lewat jika jadwal <= sekarang;
//   accepted: lewat jika jadwal + 24 jam < sekarang (dokter masih boleh complete s.d. jadwal + 24 jam).
export const SYSTEM_ACTOR = "0x0000000000000000000000000000000000000000"; // pelaku 'expire' (schema.sql)
const cutoffs = (now = Date.now()) => [msToWib(now), msToWib(now - 24 * HOUR_MS)];
const OVERDUE_SQL = `((a.status IN ('requested', 'rescheduled_by_doctor') AND a.scheduled_at <= ?)
  OR (a.status = 'accepted' AND a.scheduled_at < ?))`;

/**
 * Ubah appointment aktif yang sudah lewat menjadi 'expired' (lazy: dipanggil endpoint yang membaca/menulis
 * appointment & cek akses dokter, tanpa cron). `where` = konstanta dari kode (alias tabel a), nilainya lewat
 * `params`. Kuota & slot bebas otomatis: active_quota_no/active_slot = NULL untuk status selain aktif
 * (mekanisme yang sama dengan cancel). Setiap perubahan dicatat di appointment_changes (pelaku sistem).
 * Baris dikunci & syaratnya dicek ulang di dalam transaksi -> dua pemanggil bersamaan tidak mencatat dobel.
 */
export async function expireOverdueAppointments(where, params) {
  const [now, dayAgo] = cutoffs();
  const [due] = await pool.execute(`SELECT a.id FROM appointments a WHERE ${where} AND ${OVERDUE_SQL}`, [...params, now, dayAgo]);
  if (!due.length) return;
  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        `SELECT a.id, a.scheduled_at FROM appointments a WHERE a.id IN (?) AND ${OVERDUE_SQL} ORDER BY a.id FOR UPDATE`,
        [due.map((r) => r.id), now, dayAgo],
      );
      if (!rows.length) return;
      await conn.query("UPDATE appointments SET status = 'expired' WHERE id IN (?)", [rows.map((r) => r.id)]);
      for (const a of rows) {
        await conn.execute(
          "INSERT INTO appointment_changes (appointment_id, changed_by, change_type, old_scheduled_at) VALUES (?, ?, 'expire', ?)",
          [a.id, SYSTEM_ACTOR, a.scheduled_at],
        );
      }
    });
  } catch (err) {
    // Deadlock / tunggu kunci: pemanggil lain sedang mengerjakan baris yang sama. isTreating tetap benar
    // karena syarat waktunya dihitung di query-nya sendiri.
    if (err.errno !== 1213 && err.errno !== 1205) throw err;
  }
}

/**
 * Satu-satunya aturan "appointment ini SEDANG memberi akses perawatan" (alias tabel a). Setiap appointment
 * dinilai dalam jendela waktunya SENDIRI, tidak pernah dari masa akses on-chain:
 *   accepted & completed: sampai jadwal + 24 jam;
 *   rescheduled_by_doctor: sampai jadwal barunya (lalu expired), hanya jika SEBELUM diubah dokter sudah
 *   disepakati — perubahan "kesepakatan" terakhirnya accept/confirm, bukan patient_reschedule.
 * requested, rejected, cancelled, expired tidak pernah memberi akses. Waktu = jam server WIB, dihitung di query
 * (baris yang lewat tetapi belum di-update expireOverdueAppointments tetap tidak dihitung).
 * Parameter: careParams() = [sekarang - 24 jam, sekarang].
 */
const CARE_GRANTING_SQL = `((a.status IN ('accepted', 'completed') AND a.scheduled_at >= ?)
  OR (a.status = 'rescheduled_by_doctor' AND a.scheduled_at > ? AND (
    SELECT c.change_type FROM appointment_changes c
    WHERE c.appointment_id = a.id AND c.change_type IN ('accept', 'confirm', 'patient_reschedule')
    ORDER BY c.id DESC LIMIT 1) IN ('accept', 'confirm')))`;
const careParams = () => { const [now, dayAgo] = cutoffs(); return [dayAgo, now]; };

/**
 * Akses PERAWATAN dokter ke pasien = (a) role pasien on-chain = Patient, (b) hasAccess(patient, dokter)
 * di kontrak (masa berlaku dinilai waktu blok), DAN (c) ada appointment yang sedang memberi akses (di atas).
 * Booking saja (requested) memberi akses on-chain, tetapi BELUM membuka data off-chain apa pun.
 */
export async function isTreating(patient, doctor) {
  if ((await getRole(patient)) !== "patient" || !(await hasAccess(patient, doctor))) return false;
  await expireOverdueAppointments("a.patient_wallet = ? AND a.doctor_wallet = ?", [patient, doctor]);
  return hasCareAppointment(patient, doctor);
}
/** Syarat (c) saja, TANPA mengubah data: dipakai isTreating & diuji langsung pada baris yang belum di-expire. */
export async function hasCareAppointment(patient, doctor) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM appointments a WHERE a.patient_wallet = ? AND a.doctor_wallet = ? AND ${CARE_GRANTING_SQL} LIMIT 1`,
    [patient, doctor, ...careParams()],
  );
  return rows.length === 1;
}
export const noAccess = () => new ApiError(403, "NO_ACCESS",
  "Anda belum merawat pasien ini: aksesnya belum diberikan/sudah kedaluwarsa/dicabut, atau belum ada appointment yang Anda terima.");

/**
 * Boleh membaca/menulis data medis (rekam medis, resep, profil) pasien `patient`?
 *   Patient: hanya dirinya.
 *   Doctor: hanya jika isTreating(patient, dokter) — dicek tiap request.
 *   Admin & lainnya: ditolak.
 * Dokter tanpa akses mendapat kode NO_ACCESS agar frontend bisa menampilkan "Akses dicabut".
 * Dipanggil setelah requireRole (butuh req.role).
 */
export async function assertPatientAccess(req, patient) {
  if (req.role === "patient" && patient === req.wallet) return;
  if (req.role === "doctor") {
    if (await isTreating(patient, req.wallet)) return;
    throw noAccess();
  }
  throw forbidden("Anda tidak memiliki akses ke data medis pasien ini.");
}
