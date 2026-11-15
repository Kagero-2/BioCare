// /api/access — akses perawatan dokter–pasien (bermasa berlaku).
// SUMBER KEBENARAN = kontrak: status & expiresAt dibaca dari hasAccess/getAccessExpiry dengan
// WAKTU BLOK; event hanya untuk menemukan pasangan pasien–dokter (lihat chain.accessRelations).
// MySQL hanya menambah nama/spesialisasi dan mencatat tx_log. Tidak ada data medis di sini.
// Bentuk relasi: { status: "active"|"expired"|"revoked", expiresAt (unix detik | null),
//                  remainingSeconds, since (unix detik grant terakhir), txHash, revokedBy,
//                  revokedReason: "access_revoked"|"role_revoked"|null }  (role_revoked = role Doctor dicabut Admin)
import { Router } from "express";
import { pool } from "../db.js";
import { accessRelations, verifyReceipt } from "../chain.js";
import { requireRole, REGISTERED } from "../middleware/auth.js";
import { badRequest, conflict, forbidden } from "../lib/errors.js";
import { walletParam, hashParam, unixParam, enumParam } from "../lib/validate.js";
import { roleToEnum } from "../lib/roles.js";
import { pseudonym } from "../lib/pseudonym.js";
import { activeDoctors } from "./users.js";
import { adminHidden } from "./activity.js";

const router = Router();
const STATUSES = ["active", "expired", "revoked"];

/** Map wallet -> { full_name, specialization } untuk menamai daftar. */
async function names(wallets) {
  if (!wallets.length) return new Map();
  const [rows] = await pool.query("SELECT wallet_address, full_name, specialization FROM users WHERE wallet_address IN (?)", [[...new Set(wallets)]]);
  return new Map(rows.map((r) => [r.wallet_address, r]));
}
const accessFields = (a) => ({
  status: a.status, expiresAt: a.expiresAt, remainingSeconds: a.remainingSeconds,
  since: a.since, txHash: a.txHash, revokedBy: a.revokedBy, revokedReason: a.revokedReason,
});

// GET /api/access/me — Patient: semua dokter aktif + status aksesnya.
// Dokter yang belum pernah diberi akses: status "none".
router.get("/me", requireRole("patient"), async (req, res) => {
  const [doctors, rel] = await Promise.all([activeDoctors(), accessRelations({ patient: req.wallet })]);
  const byDoctor = new Map(rel.map((a) => [a.doctor, a]));
  res.json({
    items: doctors.map((d) => {
      const a = byDoctor.get(d.wallet_address);
      return {
        doctor_wallet: d.wallet_address, doctor_name: d.full_name, specialization: d.specialization,
        hasAccess: a?.status === "active",
        ...(a ? accessFields(a) : { status: "none", expiresAt: null, remainingSeconds: 0, since: null, txHash: null, revokedBy: null, revokedReason: null }),
      };
    }),
  });
});

// GET /api/access/doctor — Doctor: pasien yang aksesnya aktif atau sudah kedaluwarsa
// (agar dokter tahu siapa yang perlu memperpanjang). Pasien yang MENCABUT tidak ditampilkan.
router.get("/doctor", requireRole("doctor"), async (req, res) => {
  const rel = (await accessRelations({ doctor: req.wallet })).filter((a) => a.status !== "revoked");
  const n = await names(rel.map((a) => a.patient));
  res.json({ items: rel.map((a) => ({ patient_wallet: a.patient, patient_name: n.get(a.patient)?.full_name ?? null, ...accessFields(a) })) });
});

// GET /api/access?status=active|expired|revoked — Admin: semua relasi, tanpa data medis:
// pasien = pseudonim SAJA (tanpa wallet & nama), dokter = nama + wallet. TANPA spesialisasi & jadwal.
// revokedBy = pseudonim bila pasien sendiri yang mencabut. Nama pasien hanya lewat POST /api/admin/patients/identity,
// wallet (untuk tx revokeDoctorAccess) hanya lewat POST /api/admin/patients/resolve-wallet (alasan wajib, access_log).
// Dokter yang role on-chain-nya kini BUKAN Doctor (mantan dokter, juga yang kini pasien) = doctor_pseudonym saja.
router.get("/", requireRole("admin"), async (req, res) => {
  const status = enumParam(req.query.status, STATUSES, "status");
  const rel = (await accessRelations()).filter((a) => !status || a.status === status);
  const n = await names(rel.map((a) => a.doctor));
  const hidden = await adminHidden([...new Set(rel.flatMap((a) => [a.doctor, a.revokedBy]).filter(Boolean))]);
  res.json({
    items: rel.map((a) => {
      const docHidden = hidden.has(a.doctor);
      return {
        patient_pseudonym: pseudonym(a.patient),
        doctor_wallet: docHidden ? null : a.doctor,
        doctor_name: docHidden ? null : n.get(a.doctor)?.full_name ?? null,
        ...(docHidden ? { doctor_pseudonym: hidden.get(a.doctor) } : {}),
        ...accessFields(a),
        revokedBy: a.revokedBy === a.patient ? pseudonym(a.patient) : hidden.get(a.revokedBy) ?? a.revokedBy,
      };
    }),
  });
});

// POST /api/access/log { action, txHash, ... } — catat transaksi SUKSES ke tx_log setelah
// receipt & event-nya diverifikasi. Pelaku event & pengirim tx harus = wallet sesi (tidak bisa
// mencatat transaksi orang lain atas nama sendiri). Argumen event dibandingkan dengan body.
//   aksi              role      body                    event yang wajib ada di receipt
//   grant_access      patient   { doctor, expiresAt }   AccessGranted(patient = saya, doctor, expiresAt)
//   extend_access     patient   { doctor, expiresAt }   AccessExtended(patient = saya, doctor, newExpiresAt = expiresAt)
//   revoke_access     patient*  { patient, doctor }     AccessRevoked(patient, doctor, by = saya)   *atau admin
//   renounce_access   doctor    { patient }             AccessRevoked(patient, doctor = saya, by = saya)
//   grant_role        admin     { account, role }       RoleGranted(account, role, admin = saya)
//   revoke_role       admin     { account }             RoleRevoked(account, admin = saya)
//   register_patient  patient   {}                      PatientRegistered(patient = saya)
// target_wallet di tx_log: akses = wallet dokter (renounce: wallet pasien); role = akun; register = saya.
const ACTIONS = ["grant_access", "extend_access", "revoke_access", "renounce_access", "grant_role", "revoke_role", "register_patient"];
router.post("/log", requireRole(...REGISTERED), async (req, res) => {
  const b = req.body ?? {};
  const txHash = hashParam(b.txHash);
  const me = req.wallet;
  const onlyRoles = (...roles) => { if (!roles.includes(req.role)) throw forbidden(); };
  let event, args, target;
  switch (b.action) {
    case "grant_access":
    case "extend_access": {
      onlyRoles("patient");
      target = walletParam(b.doctor, "doctor");
      const expiresAt = unixParam(b.expiresAt, "expiresAt");
      [event, args] = b.action === "grant_access"
        ? ["AccessGranted", { patient: me, doctor: target, expiresAt }]
        : ["AccessExtended", { patient: me, doctor: target, newExpiresAt: expiresAt }];
      break;
    }
    case "revoke_access": {
      onlyRoles("patient", "admin");
      const patient = walletParam(b.patient, "patient");
      target = walletParam(b.doctor, "doctor");
      if (req.role !== "admin" && patient !== me) throw forbidden("Anda hanya dapat mencabut akses untuk diri sendiri.");
      [event, args] = ["AccessRevoked", { patient, doctor: target, by: me }];
      break;
    }
    case "renounce_access":
      onlyRoles("doctor");
      target = walletParam(b.patient, "patient");
      [event, args] = ["AccessRevoked", { patient: target, doctor: me, by: me }];
      break;
    case "grant_role": {
      onlyRoles("admin");
      target = walletParam(b.account, "account");
      if (b.role !== "doctor") throw badRequest("Data tidak valid.", { role: "Admin hanya dapat memberi role doctor." });
      [event, args] = ["RoleGranted", { account: target, role: roleToEnum(b.role), admin: me }];
      break;
    }
    case "revoke_role":
      onlyRoles("admin");
      target = walletParam(b.account, "account");
      [event, args] = ["RoleRevoked", { account: target, admin: me }];
      break;
    case "register_patient":
      target = me;
      [event, args] = ["PatientRegistered", { patient: me }];
      break;
    default:
      throw badRequest("Data tidak valid.", { action: `Pilihan: ${ACTIONS.join(", ")}.` });
  }

  const [used] = await pool.execute(
    "SELECT 1 FROM tx_log WHERE tx_hash = ? UNION ALL SELECT 1 FROM medical_record_versions WHERE tx_hash = ? LIMIT 1",
    [txHash, txHash],
  );
  if (used.length) throw conflict("txHash ini sudah pernah dicatat.");
  const { from } = await verifyReceipt(txHash, event, args);
  if (from !== me) throw forbidden("Transaksi ini tidak dikirim oleh wallet Anda.");

  try {
    await pool.execute(
      "INSERT INTO tx_log (tx_hash, actor_wallet, action, target_wallet, status) VALUES (?, ?, ?, ?, 'confirmed')",
      [txHash, me, b.action, target],
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") throw conflict("txHash ini sudah pernah dicatat.");
    throw err;
  }
  // Admin: target tidak digemakan (revoke_role pasien = wallet pasien; respons Admin tanpa wallet pasien).
  res.status(201).json({ action: b.action, txHash, actor_wallet: me, ...(req.role === "admin" ? {} : { target_wallet: target }), status: "confirmed" });
});

export default router;
