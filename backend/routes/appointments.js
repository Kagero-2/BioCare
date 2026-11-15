// /api/appointments — janji temu pasien–dokter (OFF-CHAIN saja).
// Status:
//   requested --accept--> accepted --complete (dokter, setelah jadwal dimulai)--> completed
//   requested --reject--> rejected
//   requested/accepted --patient reschedule (> 24 jam sebelum jadwal)--> requested
//   requested/accepted/rescheduled_by_doctor --doctor-reschedule (alasan wajib)--> rescheduled_by_doctor
//   rescheduled_by_doctor --confirm (pasien)--> accepted
//   requested/accepted --cancel (pasien, > 24 jam sebelum jadwal)--> cancelled
//   rescheduled_by_doctor --cancel (pasien, kapan saja sebelum jadwal baru)--> cancelled
//   requested/rescheduled_by_doctor --jadwal lewat--> expired      (otomatis saat dibaca:
//   accepted --jadwal + 24 jam lewat tanpa complete--> expired       expireOverdueAppointments)
//   requested/accepted/rescheduled_by_doctor --Admin, role Doctor sudah dicabut--> cancelled
// WAKTU: scheduled_at disimpan dalam WIB. Aturan H-1 (24 jam), slot, dan "masa lalu" dihitung
// di SERVER dengan jam server (lib/validate.js: wibToMs/parseSlot), bukan dari client.
// Masa AKSES dokter tetap mengikuti kontrak: detik Unix & WAKTU BLOK.
// AKSES DOKTER: appointment butuh akses on-chain s.d. accessExpiresAt(jadwal) = 00:00 WIB pertama setelah
// jadwal + 24 jam (dibulatkan agar jam appointment tidak terbaca on-chain). Endpoint yang menetapkan
// jadwal untuk pasien (booking, reschedule pasien, confirm) bekerja 2 langkah:
//   1. tanpa txHash -> server menghitung accessAction:
//        'none'   akses aktif sudah >= expiresAt -> langsung disimpan (201 / 200);
//        'extend' akses aktif tapi lebih pendek  \
//        'grant'  tidak ada / sudah kedaluwarsa   } -> BELUM disimpan: { saved: false, accessAction, expiresAt }
//   2. pasien mengirim grantDoctorAccess(doctor, expiresAt) lewat MetaMask (kontrak: akses aktif
//      hanya bisa DIPERPANJANG -> event AccessExtended; tidak aktif -> AccessGranted), lalu
//      memanggil endpoint yang sama + txHash -> server memverifikasi receipt (verifyReceipt),
//      mencatat tx_log, lalu menyimpan perubahan dalam SATU transaksi DB.
//   Respons langkah 1 juga membawa doctor_wallet: frontend menolak menandatangani jika berbeda dengan
//   dokter yang ditampilkan.
// Akses on-chain saja TIDAK cukup untuk membaca data pasien: dokter juga harus sudah MENERIMA appointment
// (middleware/auth.js isTreating). Setelah reject (dokter) / cancel (pasien) tanpa appointment aktif
// lain di pasangan itu sementara akses on-chain masih aktif -> respons shouldRevoke = true (pasien ditawari
// mencabut). complete -> shouldRenounce (dokter ditawari melepas).
// Setiap perubahan status/jadwal ditulis ke appointment_changes (append-only) dalam transaksi DB
// yang sama. Bentrok slot dicegah UNIQUE (doctor_wallet, active_slot) -> aman dari race condition.
// Maks 3 appointment aktif per pasien: UNIQUE (patient_wallet, active_quota_no) + CHECK quota_no 1..3.
// Booking paralel yang bertabrakan di nomor jatah diulang dengan nomor berikutnya.
// Admin TIDAK menerima daftar appointment: hanya agregat GET /summary (tanggal x dokter x status x
// jumlah), tanpa pasien, jam, atau alasan.
import { Router } from "express";
import { pool, withTransaction } from "../db.js";
import { getRole, getAccessExpiry, hasAccess, blockTime, verifyReceipt } from "../chain.js";
import { requireRole, expireOverdueAppointments } from "../middleware/auth.js";
import { ApiError, forbidden, notFound, conflict, badRequest } from "../lib/errors.js";
import {
  validateAppointment, validateReschedule, assertValid, idParam, enumParam, pagination, noteParam,
  hashParam, dateParam, todayWib, wibToMs, SLOT_TIMES, HOUR_MS, accessExpiresAt, walletParam, searchParam,
} from "../lib/validate.js";
import { activeDoctors, walletOfRef } from "./users.js";
import { adminHidden } from "./activity.js";
import { REF_RE } from "../lib/pseudonym.js";

const router = Router();
const STATUSES = ["requested", "accepted", "rejected", "cancelled", "rescheduled_by_doctor", "completed", "expired"];
const LOCKING = ["requested", "accepted", "rescheduled_by_doctor"]; // = active_slot di schema.sql
const DAY_S = 86400;
const MAX_ACCESS_S = 60 * DAY_S; // = MAX_ACCESS_DURATION di kontrak
const H1_MS = 24 * HOUR_MS;      // batas H-1: kurang dari 24 jam sebelum jadwal
// Maks appointment AKTIF (requested/accepted/rescheduled_by_doctor) per pasien, ke dokter mana pun:
// satu pasien tidak bisa menimbun slot sampai jadwal dokter habis. = CHECK chk_appt_quota di schema.sql.
const MAX_ACTIVE_PER_PATIENT = 3;

// Kolom untuk pasien & dokter pemilik (Admin tidak pernah menerima baris appointment).
// previous_scheduled_at: jadwal sebelum doctor-reschedule terakhir (hanya saat rescheduled_by_doctor), agar
// pasien melihat "jadwal lama -> jadwal baru". cancel_code: kode tetap pembatalan oleh Admin
// (DOCTOR_ROLE_REVOKED) atau null (dibatalkan pasien).
const COLS = `a.id, a.patient_wallet, a.doctor_wallet, a.scheduled_at, a.status, a.access_expires_at,
  a.created_at, a.updated_at, p.full_name AS patient_name, d.full_name AS doctor_name, d.specialization AS doctor_specialization,
  CASE WHEN a.status = 'rescheduled_by_doctor' THEN (SELECT c.old_scheduled_at FROM appointment_changes c
   WHERE c.appointment_id = a.id AND c.change_type = 'doctor_reschedule' ORDER BY c.id DESC LIMIT 1) END AS previous_scheduled_at,
  CASE WHEN a.status = 'cancelled' THEN (SELECT c.reason FROM appointment_changes c
   WHERE c.appointment_id = a.id AND c.change_type = 'cancel' ORDER BY c.id DESC LIMIT 1) END AS cancel_code,
  a.reason, a.doctor_note,
  (SELECT c.reason FROM appointment_changes c WHERE c.appointment_id = a.id AND c.change_type = 'doctor_reschedule'
   ORDER BY c.id DESC LIMIT 1) AS reschedule_reason`;
const FROM = `appointments a
  LEFT JOIN users p ON p.wallet_address = a.patient_wallet
  LEFT JOIN users d ON d.wallet_address = a.doctor_wallet`;
const DOCTOR_ROLE_REVOKED = "DOCTOR_ROLE_REVOKED"; // = chk_changes_cancel di schema.sql

async function loadAppointment(id) {
  const [[row]] = await pool.execute(`SELECT ${COLS} FROM ${FROM} WHERE a.id = ?`, [id]);
  if (!row) throw notFound("Appointment tidak ditemukan.");
  return { ...row, access_expires_at: Number(row.access_expires_at) };
}
const msUntil = (scheduledAt) => wibToMs(scheduledAt) - Date.now();
const limitReached = () => new ApiError(409, "APPOINTMENT_LIMIT",
  `Maksimal ${MAX_ACTIVE_PER_PATIENT} appointment aktif per pasien. Batalkan atau tunggu appointment lain selesai dulu.`);
const dupConflict = (err) => {
  if (err.code !== "ER_DUP_ENTRY") return err;
  const msg = err.sqlMessage ?? "";
  if (/uq_tx_hash/.test(msg)) return conflict("txHash ini sudah pernah dicatat.");
  if (isQuotaDup(err)) return limitReached(); // retry booking habis
  return conflict("Slot ini sudah dipesan. Pilih waktu lain.");
};
const isQuotaDup = (err) => err.code === "ER_DUP_ENTRY" && /uq_appt_patient_quota/.test(err.sqlMessage ?? "");
// Ulangan INSERT booking saat nomor jatah direbut request paralel. 3 ulangan = 4 percobaan: cukup untuk
// melewati 3 jatah; percobaan berikutnya pasti melihat jatah penuh (freeQuotaNo -> APPOINTMENT_LIMIT).
const QUOTA_RETRIES = 3;

/**
 * Nomor jatah appointment aktif (1..MAX) yang masih kosong untuk pasien, atau 409 APPOINTMENT_LIMIT.
 * Dicek sebelum langkah akses (pasien tidak diminta membayar gas lalu ditolak) dan lagi di dalam
 * transaksi INSERT; penjaga sebenarnya UNIQUE (patient_wallet, active_quota_no) di database.
 */
async function freeQuotaNo(db, patient) {
  const [rows] = await db.execute("SELECT active_quota_no AS n FROM appointments WHERE patient_wallet = ? AND active_quota_no IS NOT NULL", [patient]);
  const used = new Set(rows.map((r) => Number(r.n)));
  for (let n = 1; n <= MAX_ACTIVE_PER_PATIENT; n++) if (!used.has(n)) return n;
  throw limitReached();
}

// Akses dokter on-chain

/**
 * Rencana akses untuk jadwal `slot` (WIB): expiresAt = accessExpiresAt(slot) (detik Unix, dibulatkan ke 00:00 WIB).
 * Dinilai dengan WAKTU BLOK, sama persis dengan grantDoctorAccess di kontrak:
 *   aktif (current >= waktu blok) && current >= expiresAt -> 'none'
 *   aktif tapi current < expiresAt                        -> 'extend' (AccessExtended)
 *   tidak pernah diberi / dicabut / kedaluwarsa          -> 'grant'  (AccessGranted)
 * Kontrak menolak expiresAt > waktu blok + 60 hari -> ditolak di sini juga (pengaman; batas utama =
 * BOOKING_HORIZON_DAYS di parseSlot).
 */
async function accessPlan(patient, doctor, slot) {
  const expiresAt = accessExpiresAt(slot);
  const [current, now] = await Promise.all([getAccessExpiry(patient, doctor), blockTime()]);
  if (expiresAt <= now) throw badRequest("Data tidak valid.", { scheduled_at: "Jadwal sudah lewat menurut waktu blockchain." });
  if (expiresAt > now + MAX_ACCESS_S) throw badRequest("Data tidak valid.", { scheduled_at: "Jadwal terlalu jauh: akses dokter maksimal 60 hari ke depan." });
  const active = current >= now;
  const accessAction = active && current >= expiresAt ? "none" : active ? "extend" : "grant";
  return { accessAction, expiresAt };
}

/**
 * Verifikasi tx grantDoctorAccess yang dikirim pasien:
 *  - receipt sukses ke kontrak kita, tepat satu AccessGranted/AccessExtended(patient = saya, doctor),
 *    dikirim (from) oleh wallet sesi, dan expiresAt di event = accessExpiresAt(jadwal);
 *  - txHash belum pernah dicatat;
 *  - akses SEKARANG di kontrak memang >= expiresAt (tidak dicabut setelah tx itu).
 * Mengembalikan aksi tx_log: 'grant_access' | 'extend_access'.
 */
async function verifyAccessTx(conn, txHash, patient, doctor, expiresAt) {
  const [used] = await conn.execute(
    "SELECT 1 FROM tx_log WHERE tx_hash = ? UNION ALL SELECT 1 FROM medical_record_versions WHERE tx_hash = ? LIMIT 1",
    [txHash, txHash],
  );
  if (used.length) throw conflict("txHash ini sudah pernah dicatat.");
  const { name, args, from } = await verifyReceipt(txHash, ["AccessGranted", "AccessExtended"], { patient, doctor });
  if (from !== patient) throw forbidden("Transaksi ini tidak dikirim oleh wallet Anda.");
  const granted = name === "AccessGranted" ? args.expiresAt : args.newExpiresAt;
  if (BigInt(granted) !== BigInt(expiresAt)) throw new ApiError(422, "TX_INVALID", "expiresAt di transaksi tidak sama dengan masa akses jadwal ini.");
  if (!(await hasAccess(patient, doctor)) || (await getAccessExpiry(patient, doctor)) < expiresAt) {
    throw conflict("Akses dokter di kontrak belum mencukupi (mungkin sudah dicabut). Berikan akses lagi.");
  }
  return name === "AccessGranted" ? "grant_access" : "extend_access";
}

/**
 * Langkah akses untuk jadwal baru. Tanpa txHash: { ready: accessAction === 'none', accessAction, expiresAt }.
 * Dengan txHash: tx diverifikasi & dicatat ke tx_log (pada `conn`) -> { ready: true, ... }.
 */
async function ensureAccess(conn, body, patient, doctor, slot) {
  const plan = await accessPlan(patient, doctor, slot);
  if (body?.txHash === undefined || body?.txHash === null) return { ...plan, ready: plan.accessAction === "none" };
  const txHash = hashParam(body.txHash);
  const action = await verifyAccessTx(conn, txHash, patient, doctor, plan.expiresAt);
  await conn.execute(
    "INSERT INTO tx_log (tx_hash, actor_wallet, action, target_wallet, status) VALUES (?, ?, ?, ?, 'confirmed')",
    [txHash, patient, action, doctor],
  );
  return { ready: true, accessAction: action === "grant_access" ? "grant" : "extend", expiresAt: plan.expiresAt, txHash };
}

/** Catat perubahan ke appointment_changes (append-only). */
function logChange(conn, appt, by, type, { newAt = null, reason = null } = {}) {
  return conn.execute(
    "INSERT INTO appointment_changes (appointment_id, changed_by, change_type, old_scheduled_at, new_scheduled_at, reason) VALUES (?, ?, ?, ?, ?, ?)",
    [appt.id, by, type, appt.scheduled_at, newAt, reason],
  );
}

/**
 * Kunci appointment (SELECT ... FOR UPDATE) milik wallet sesi lalu jalankan fn(conn, appt) dalam
 * SATU transaksi DB. Status & waktu dicek ULANG di dalam kunci -> dua klik bersamaan tidak bisa
 * sama-sama berhasil. fn mengembalikan { saved: false, ... } jika tidak ada yang diubah.
 */
async function withOwnAppointment(req, owner, fn) {
  const id = idParam(req.params.id);
  await expireOverdueAppointments("a.id = ?", [id]); // status sudah benar sebelum dikunci
  let out;
  try {
    out = await withTransaction(async (conn) => {
      const [[a]] = await conn.execute("SELECT * FROM appointments WHERE id = ? FOR UPDATE", [id]);
      if (!a) throw notFound("Appointment tidak ditemukan.");
      if (a[owner] !== req.wallet) throw forbidden("Appointment ini bukan milik Anda.");
      return (await fn(conn, a)) ?? {};
    });
  } catch (err) {
    throw dupConflict(err);
  }
  if (out.saved === false) return out;
  return { ...out, appointment: await loadAppointment(id) };
}
/** Cek awal slot dokter masih kosong (selain appointment `exceptId`), agar pasien tidak membayar
 *  gas untuk slot yang sudah terisi. Penjaga sebenarnya tetap UNIQUE (doctor_wallet, active_slot). */
async function assertSlotFree(db, doctor, slot, exceptId = 0) {
  const [[busy]] = await db.execute("SELECT 1 AS x FROM appointments WHERE doctor_wallet = ? AND active_slot = ? AND id <> ?", [doctor, slot, exceptId]);
  if (busy) throw conflict("Slot ini sudah dipesan. Pilih waktu lain.");
}
const requireStatus = (a, allowed, action) => {
  if (!allowed.includes(a.status)) throw conflict(`Appointment berstatus ${a.status}; tidak bisa ${action}.`);
};
/**
 * Pasangan appointment `a` + jumlah appointment AKTIF lain (LOCKING) antara dokter & pasien yang sama.
 * completed sengaja tidak dihitung: jendela completed di isTreating adalah batas maksimum, jadi tawaran
 * melepas/mencabut akses setelah appointment selesai tetap muncul.
 */
async function pairOf(conn, a) {
  const [[{ n }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM appointments WHERE doctor_wallet = ? AND patient_wallet = ? AND id <> ? AND status IN (?)",
    [a.doctor_wallet, a.patient_wallet, a.id, LOCKING],
  );
  return { patient: a.patient_wallet, doctor: a.doctor_wallet, others: Number(n) };
}
// Akses on-chain dokter masih aktif padahal tidak ada appointment aktif lain -> sebaiknya diakhiri
// (shouldRenounce untuk dokter, shouldRevoke untuk pasien). Dibaca SETELAH transaksi DB selesai.
const accessLeftover = async ({ patient, doctor, others }) => others === 0 && (await hasAccess(patient, doctor));

// Baca

// GET /api/appointments/doctors?specialization=&date=YYYY-MM-DD — Patient.
// Dokter = role Doctor di kontrak. slots = jam 08:00–15:30 (tiap 30 menit, WIB) pada `date`
// (default hari ini) yang BELUM terisi dan BELUM lewat menurut jam server.
router.get("/doctors", requireRole("patient"), async (req, res) => {
  const date = req.query.date === undefined ? todayWib() : dateParam(req.query.date);
  if (!date) throw badRequest("Parameter tidak valid.", { date: "Format YYYY-MM-DD." });
  const wanted = searchParam(req.query.specialization, "specialization").toLowerCase();
  const doctors = (await activeDoctors()).filter((d) => !wanted || d.specialization?.toLowerCase() === wanted);

  const taken = new Set();
  if (doctors.length) {
    const [rows] = await pool.query(
      "SELECT doctor_wallet, DATE_FORMAT(active_slot, '%H:%i') AS t FROM appointments WHERE doctor_wallet IN (?) AND DATE(active_slot) = ?",
      [doctors.map((d) => d.wallet_address), date],
    );
    for (const r of rows) taken.add(`${r.doctor_wallet}|${r.t}`);
  }
  const now = Date.now();
  const future = SLOT_TIMES.filter((t) => wibToMs(`${date} ${t}`) > now);
  res.json({
    date,
    items: doctors.map((d) => ({ ...d, slots: future.filter((t) => !taken.has(`${d.wallet_address}|${t}`)) })),
  });
});

// GET /api/appointments?status=&page=&pageSize= — Patient & Doctor: hanya miliknya. Admin -> 403 (pakai /summary).
router.get("/", requireRole("patient", "doctor"), async (req, res) => {
  const status = enumParam(req.query.status, STATUSES, "status") ?? null;
  const { page, pageSize } = pagination(req.query);
  const own = { patient: "a.patient_wallet = ?", doctor: "a.doctor_wallet = ?" }[req.role];
  await expireOverdueAppointments(own, [req.wallet]);
  const where = `${own} AND (? IS NULL OR a.status = ?)`;
  const params = [req.wallet, status, status];
  const [[{ total }]] = await pool.execute(`SELECT COUNT(*) AS total FROM appointments a WHERE ${where}`, params);
  const [items] = await pool.query(
    `SELECT ${COLS} FROM ${FROM} WHERE ${where} ORDER BY a.scheduled_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  res.json({ items: items.map((r) => ({ ...r, access_expires_at: Number(r.access_expires_at) })), page, pageSize, total: Number(total) });
});

// GET /api/appointments/summary — Admin: AGREGAT saja: { items: [{ date, doctor_wallet, doctor_name,
// status, count }] } per tanggal (WIB) x dokter x status. Tanpa nama/wallet/pseudonim pasien, tanpa jam, tanpa alasan.
// Dokter yang role on-chain-nya kini bukan Doctor: doctor_wallet & doctor_name = null, hanya doctor_pseudonym.
router.get("/summary", requireRole("admin"), async (req, res) => {
  await expireOverdueAppointments("1 = 1", []);
  const [rows] = await pool.execute(
    `SELECT DATE_FORMAT(a.scheduled_at, '%Y-%m-%d') AS date, a.doctor_wallet, d.full_name AS doctor_name, a.status, COUNT(*) AS count
     FROM appointments a LEFT JOIN users d ON d.wallet_address = a.doctor_wallet
     GROUP BY date, a.doctor_wallet, d.full_name, a.status ORDER BY date DESC, a.doctor_wallet, a.status`,
  );
  const hidden = await adminHidden([...new Set(rows.map((r) => r.doctor_wallet))]);
  res.json({
    items: rows.map((r) => ({
      ...r, count: Number(r.count), doctor_pseudonym: null,
      ...(hidden.has(r.doctor_wallet) ? { doctor_wallet: null, doctor_name: null, doctor_pseudonym: hidden.get(r.doctor_wallet) } : {}),
    })),
  });
});

// Pasien

// POST /api/appointments { doctor_wallet, scheduled_at, reason, txHash? } — Patient booking.
//   201 { saved: true, accessAction, expiresAt, appointment }   (akses cukup / tx terverifikasi)
//   200 { saved: false, accessAction: 'grant'|'extend', expiresAt } (kirim tx dulu, lalu ulangi + txHash)
router.post("/", requireRole("patient"), async (req, res) => {
  const v = assertValid(validateAppointment(req.body));
  if ((await getRole(v.doctor_wallet)) !== "doctor") throw badRequest("Data tidak valid.", { doctor_wallet: "Wallet ini bukan dokter aktif." });
  await expireOverdueAppointments("a.patient_wallet = ?", [req.wallet]); // jatah appointment lewat jadwal bebas
  await assertSlotFree(pool, v.doctor_wallet, v.scheduled_at);
  await freeQuotaNo(pool, req.wallet);

  let out;
  // Tabrakan nomor jatah (uq_appt_patient_quota) = request paralel pasien yang sama mengambil nomor yang sama:
  // ulangi SELURUH transaksi (snapshot baru -> freeQuotaNo melihat nomor yang baru terpakai). Batas 3 aktif
  // tetap dijaga UNIQUE + CHECK di DB. Tabrakan slot (uq_appt_doctor_slot) tidak diulang -> 409.
  for (let attempt = 0; ; attempt++) {
    try {
      out = await withTransaction(async (conn) => {
        const acc = await ensureAccess(conn, req.body, req.wallet, v.doctor_wallet, v.scheduled_at);
        if (!acc.ready) return { saved: false, accessAction: acc.accessAction, expiresAt: acc.expiresAt, doctor_wallet: v.doctor_wallet };
        const [r] = await conn.execute(
          "INSERT INTO appointments (patient_wallet, doctor_wallet, scheduled_at, reason, access_expires_at, quota_no) VALUES (?, ?, ?, ?, ?, ?)",
          [req.wallet, v.doctor_wallet, v.scheduled_at, v.reason, acc.expiresAt, await freeQuotaNo(conn, req.wallet)],
        );
        return { saved: true, id: r.insertId, accessAction: acc.accessAction, expiresAt: acc.expiresAt };
      });
      break;
    } catch (err) {
      if (isQuotaDup(err) && attempt < QUOTA_RETRIES) continue;
      throw dupConflict(err);
    }
  }
  if (!out.saved) return res.json(out);
  const { id, ...rest } = out;
  res.status(201).json({ ...rest, appointment: await loadAppointment(id) });
});

// PATCH /api/appointments/:id/reschedule { scheduled_at, txHash? } — Patient pemilik.
// Hanya requested/accepted dan LEBIH dari 24 jam sebelum jadwal; status kembali requested.
// Akses untuk jadwal baru mengikuti langkah 2-tahap yang sama dengan booking.
router.patch("/:id/reschedule", requireRole("patient"), async (req, res) => {
  const v = assertValid(validateReschedule(req.body, { needReason: false }));
  res.json(await withOwnAppointment(req, "patient_wallet", async (conn, a) => {
    requireStatus(a, ["requested", "accepted"], "di-reschedule pasien");
    if (msUntil(a.scheduled_at) <= H1_MS) throw conflict("Reschedule hanya bisa lebih dari 24 jam sebelum jadwal (H-1).");
    if (v.scheduled_at === a.scheduled_at) throw badRequest("Data tidak valid.", { scheduled_at: "Jadwal baru sama dengan jadwal sekarang." });
    await assertSlotFree(conn, a.doctor_wallet, v.scheduled_at, a.id);
    const acc = await ensureAccess(conn, req.body, a.patient_wallet, a.doctor_wallet, v.scheduled_at);
    if (!acc.ready) return { saved: false, accessAction: acc.accessAction, expiresAt: acc.expiresAt, doctor_wallet: a.doctor_wallet };
    await conn.execute(
      "UPDATE appointments SET scheduled_at = ?, status = 'requested', access_expires_at = ? WHERE id = ?",
      [v.scheduled_at, acc.expiresAt, a.id],
    );
    await logChange(conn, a, req.wallet, "patient_reschedule", { newAt: v.scheduled_at });
    return { saved: true, accessAction: acc.accessAction, expiresAt: acc.expiresAt };
  }));
});

// PATCH /api/appointments/:id/cancel — Patient pemilik.
//   requested/accepted: hanya jika LEBIH dari 24 jam sebelum jadwal (H-1);
//   rescheduled_by_doctor: kapan saja sebelum jadwal baru (pasien tidak menyetujui jadwal itu).
// shouldRevoke = true jika tidak ada appointment aktif lain dengan dokter itu DAN akses on-chain-nya
// masih aktif -> frontend menawarkan revokeDoctorAccess.
router.patch("/:id/cancel", requireRole("patient"), async (req, res) => {
  const { pair, ...out } = await withOwnAppointment(req, "patient_wallet", async (conn, a) => {
    requireStatus(a, ["requested", "accepted", "rescheduled_by_doctor"], "dibatalkan");
    const left = msUntil(a.scheduled_at);
    if (a.status === "rescheduled_by_doctor" ? left <= 0 : left <= H1_MS) {
      throw conflict(a.status === "rescheduled_by_doctor" ? "Jadwal sudah lewat." : "Pembatalan hanya bisa lebih dari 24 jam sebelum jadwal (H-1).");
    }
    await conn.execute("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [a.id]);
    await logChange(conn, a, req.wallet, "cancel");
    return { pair: await pairOf(conn, a) };
  });
  res.json({ ...out, shouldRevoke: await accessLeftover(pair) });
});

// PATCH /api/appointments/:id/confirm { txHash? } — Patient pemilik menyetujui jadwal baru dari
// dokter (rescheduled_by_doctor -> accepted), sebelum jadwal itu. Jika masa akses jadwal baru melebihi
// akses on-chain, langkah akses 2-tahap berlaku (accessAction 'grant'/'extend').
router.patch("/:id/confirm", requireRole("patient"), async (req, res) => {
  res.json(await withOwnAppointment(req, "patient_wallet", async (conn, a) => {
    requireStatus(a, ["rescheduled_by_doctor"], "dikonfirmasi");
    if (msUntil(a.scheduled_at) <= 0) throw conflict("Jadwal sudah lewat.");
    const acc = await ensureAccess(conn, req.body, a.patient_wallet, a.doctor_wallet, a.scheduled_at);
    if (!acc.ready) return { saved: false, accessAction: acc.accessAction, expiresAt: acc.expiresAt, doctor_wallet: a.doctor_wallet };
    await conn.execute("UPDATE appointments SET status = 'accepted', access_expires_at = ? WHERE id = ?", [acc.expiresAt, a.id]);
    await logChange(conn, a, req.wallet, "confirm");
    return { saved: true, accessAction: acc.accessAction, expiresAt: acc.expiresAt };
  }));
});

// Dokter

// PATCH /api/appointments/:id/accept|reject { note? } — Doctor pemilik, hanya dari requested.
// accept = dokter mulai merawat: baru sekarang ia boleh membaca/menulis data pasien (isTreating).
// reject: shouldRevoke (sama seperti cancel) — tidak ada appointment aktif lain & akses on-chain masih
// aktif; pasien diingatkan mencabutnya di halaman Appointment.
for (const [action, to] of [["accept", "accepted"], ["reject", "rejected"]]) {
  router.patch(`/:id/${action}`, requireRole("doctor"), async (req, res) => {
    const note = noteParam(req.body);
    const { pair, ...out } = await withOwnAppointment(req, "doctor_wallet", async (conn, a) => {
      requireStatus(a, ["requested"], action === "accept" ? "diterima" : "ditolak");
      await conn.execute("UPDATE appointments SET status = ?, doctor_note = COALESCE(?, doctor_note) WHERE id = ?", [to, note, a.id]);
      await logChange(conn, a, req.wallet, action);
      return { pair: await pairOf(conn, a) };
    });
    res.json(action === "reject" ? { ...out, shouldRevoke: await accessLeftover(pair) } : out);
  });
}

// PATCH /api/appointments/:id/doctor-reschedule { scheduled_at, reason } — Doctor pemilik.
// Kapan saja sebelum jadwal; alasan WAJIB (>= 10 karakter setelah trim) -> rescheduled_by_doctor.
// Akses on-chain tidak diubah di sini: pasien yang mengurusnya saat confirm.
router.patch("/:id/doctor-reschedule", requireRole("doctor"), async (req, res) => {
  const v = assertValid(validateReschedule(req.body, { needReason: true }));
  res.json(await withOwnAppointment(req, "doctor_wallet", async (conn, a) => {
    requireStatus(a, LOCKING, "di-reschedule dokter");
    if (msUntil(a.scheduled_at) <= 0) throw conflict("Jadwal sudah dimulai/lewat; tidak bisa di-reschedule.");
    if (v.scheduled_at === a.scheduled_at) throw badRequest("Data tidak valid.", { scheduled_at: "Jadwal baru sama dengan jadwal sekarang." });
    await assertSlotFree(conn, a.doctor_wallet, v.scheduled_at, a.id);
    await conn.execute("UPDATE appointments SET scheduled_at = ?, status = 'rescheduled_by_doctor' WHERE id = ?", [v.scheduled_at, a.id]);
    await logChange(conn, a, req.wallet, "doctor_reschedule", { newAt: v.scheduled_at, reason: v.reason });
  }));
});

// PATCH /api/appointments/:id/complete { note? } — Doctor pemilik, dari accepted, setelah jadwal dimulai dan
// paling lambat jadwal + 24 jam (setelah itu expired).
// shouldRenounce = true hanya jika TIDAK ada appointment lain requested/accepted/rescheduled_by_doctor
// antara dokter & pasien yang sama DAN akses dokter masih aktif di kontrak (renounceAccess akan
// revert NoAccess/AccessExpired jika tidak). Frontend lalu meminta dokter mengirim renounceAccess(patient).
router.patch("/:id/complete", requireRole("doctor"), async (req, res) => {
  const note = noteParam(req.body);
  const { pair, ...out } = await withOwnAppointment(req, "doctor_wallet", async (conn, a) => {
    requireStatus(a, ["accepted"], "diselesaikan");
    if (msUntil(a.scheduled_at) > 0) throw conflict("Appointment belum dimulai; tandai selesai setelah jadwalnya.");
    if (msUntil(a.scheduled_at) < -H1_MS) throw conflict("Appointment sudah kedaluwarsa (lebih dari 24 jam setelah jadwal).");
    await conn.execute("UPDATE appointments SET status = 'completed', doctor_note = COALESCE(?, doctor_note) WHERE id = ?", [note, a.id]);
    await logChange(conn, a, req.wallet, "complete");
    return { pair: await pairOf(conn, a) };
  });
  res.json({ ...out, shouldRenounce: await accessLeftover(pair) });
});

// Admin
export const adminRouter = Router();

// POST /api/admin/doctors/:wallet/cancel-appointments — Admin membatalkan SEMUA appointment aktif dokter yang
// role-nya sudah dicabut: kuota & slot pasien bebas (status cancelled, mekanisme sama dengan cancel
// pasien), appointment_changes mencatat Admin + kode tetap DOCTOR_ROLE_REVOKED. Role dibaca dari kontrak
// (fail closed: kontrak tidak terbaca -> 503). Masih Doctor -> 409. Respons hanya jumlah, tanpa data pasien.
// :wallet boleh ref profil (U-…): wallet dicari backend, jadi Admin tidak perlu memegang wallet mantan dokter.
adminRouter.post("/doctors/:wallet/cancel-appointments", requireRole("admin"), async (req, res) => {
  const doctor = REF_RE.test(req.params.wallet) ? await walletOfRef(req.params.wallet) : walletParam(req.params.wallet);
  if ((await getRole(doctor)) === "doctor") throw conflict("Wallet ini masih ber-role Doctor di kontrak. Cabut role-nya dulu (revokeRole).");
  await expireOverdueAppointments("a.doctor_wallet = ?", [doctor]); // yang sudah lewat menjadi expired, bukan cancelled
  const cancelled = await withTransaction(async (conn) => {
    const [rows] = await conn.query(
      "SELECT id, scheduled_at FROM appointments WHERE doctor_wallet = ? AND status IN (?) ORDER BY id FOR UPDATE",
      [doctor, LOCKING],
    );
    if (!rows.length) return 0;
    await conn.query("UPDATE appointments SET status = 'cancelled' WHERE id IN (?)", [rows.map((r) => r.id)]);
    for (const a of rows) await logChange(conn, a, req.wallet, "cancel", { reason: DOCTOR_ROLE_REVOKED });
    return rows.length;
  });
  res.json({ cancelled });
});

export default router;
