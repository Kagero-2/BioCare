// /api/activity, /api/tx-log & /api/stats
import { Router } from "express";
import config from "../config.js";
import { pool } from "../db.js";
import { getRole, getStats, contractEvents } from "../chain.js";
import { requireRole, REGISTERED } from "../middleware/auth.js";
import { enumParam, pagination, wibToMs } from "../lib/validate.js";
import { pseudonym, hiddenForAdmin } from "../lib/pseudonym.js";

// GET /api/activity?page=&pageSize= — Riwayat Aktivitas.
// Sumber kebenaran = EVENT kontrak (transaksi sukses), digabung dengan tx_log pending/failed (yang
// tidak punya event). Filter per role DI SERVER:
//   Admin: semua event (jenis, alamat, waktu; event hanya berisi alamat/id/hash, tanpa isi medis).
//   Doctor & Patient: hanya event yang salah satu argumen alamatnya = wallet sesi, dan baris tx_log
//   yang ia kirim atau yang menyangkut dirinya.
// Urut waktu terbaru dulu (event: waktu blok; tx_log: updated_at WIB). names = nama profil alamat di baris itu
// (untuk Admin: pasien sebagai pseudonim).
export const activityRouter = Router();
activityRouter.get("/", requireRole(...REGISTERED), async (req, res) => {
  const { page, pageSize } = pagination(req.query);
  const isAdmin = req.role === "admin";
  const events = (await contractEvents())
    .filter((e) => isAdmin || Object.values(e.args).includes(req.wallet))
    .map((e) => ({ ...e, source: "event", to: config.CONTRACT_ADDRESS, status: "confirmed", time: e.timestamp * 1000 }));
  const [logs] = await pool.execute(
    `SELECT id, tx_hash, actor_wallet, action, target_wallet, record_id, status, error_message, updated_at
     FROM tx_log WHERE status IN ('pending','failed') AND (? OR actor_wallet = ? OR target_wallet = ?)`,
    [isAdmin ? 1 : 0, req.wallet, req.wallet],
  );
  const rows = logs.map((t) => ({
    source: "tx_log", action: t.action, actor: t.actor_wallet, target: t.target_wallet, recordId: t.record_id === null ? null : Number(t.record_id),
    txHash: t.tx_hash, status: t.status, error: t.error_message, time: wibToMs(t.updated_at),
  }));
  const all = [...events, ...rows].sort((a, b) => b.time - a.time || (b.blockNumber ?? 0) - (a.blockNumber ?? 0) || (b.logIndex ?? 0) - (a.logIndex ?? 0));
  const items = all.slice((page - 1) * pageSize, page * pageSize);

  const addrs = (it) => [it.actor, it.target, ...Object.values(it.args ?? {})].filter((v) => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v));
  const wallets = [...new Set(items.flatMap(addrs))];
  const [users] = wallets.length ? await pool.query("SELECT wallet_address, full_name FROM users WHERE wallet_address IN (?)", [wallets]) : [[]];
  const nameOf = new Map(users.map((u) => [u.wallet_address, u.full_name]));
  // untuk Admin, pasien (dan wallet non-staf lain) tampil sebagai pseudonim DI DATA (actor/target/args/names),
  // bukan hanya di label: Admin tidak menerima wallet pasien sama sekali.
  const hidden = isAdmin ? await adminHidden(wallets) : new Map();
  for (const [w, p] of hidden) nameOf.set(w, p);
  const show = (v) => hidden.get(v) ?? v;
  res.json({
    items: items.map(({ time, ...it }) => ({
      ...it, timestamp: new Date(time).toISOString(),
      ...(isAdmin ? maskRow(it, show) : {}),
      names: Object.fromEntries(addrs(it).filter((a) => nameOf.has(a)).map((a) => [show(a), nameOf.get(a)])),
    })),
    page, pageSize, total: all.length,
  });
});

/**
 * Admin: Map wallet -> pseudonim untuk wallet yang disamarkan (hiddenForAdmin: semua selain role on-chain
 * Admin/Doctor saat ini; fail closed). Event kontrak tetap publik, jadi ini minimisasi tampilan aplikasi, bukan kerahasiaan.
 */
export async function adminHidden(wallets) {
  if (!wallets.length) return new Map();
  const roles = await Promise.all(wallets.map(getRole)); // shortcut: 1 eth_call per wallet di halaman ini
  return new Map(wallets.filter((w, i) => hiddenForAdmin(roles[i])).map((w) => [w, pseudonym(w)]));
}
/** Ganti wallet tersamar di kolom alamat satu baris aktivitas (actor, target, args). */
const maskRow = (it, show) => ({
  actor: show(it.actor),
  ...("target" in it ? { target: show(it.target) } : {}),
  ...(it.args ? { args: Object.fromEntries(Object.entries(it.args).map(([k, v]) => [k, show(v)])) } : {}),
});

export const txLogRouter = Router();

// GET /api/tx-log?status=pending|failed&page=&pageSize=
// Transaksi pending/failed (event kontrak hanya berisi transaksi sukses).
// Admin: semua. Lainnya: hanya transaksi yang ia kirim atau yang menyangkut wallet-nya.
txLogRouter.get("/", requireRole(...REGISTERED), async (req, res) => {
  const status = enumParam(req.query.status, ["pending", "failed"], "status");
  const { page, pageSize } = pagination(req.query);
  const isAdmin = req.role === "admin";
  const where = `status IN ('pending','failed') AND (? IS NULL OR status = ?) AND (? OR actor_wallet = ? OR target_wallet = ?)`;
  const params = [status ?? null, status ?? null, isAdmin ? 1 : 0, req.wallet, req.wallet];
  const [[{ total }]] = await pool.execute(`SELECT COUNT(*) AS total FROM tx_log WHERE ${where}`, params);
  // LIMIT/OFFSET sudah divalidasi sebagai integer oleh pagination(); tetap lewat placeholder.
  const [items] = await pool.query(
    `SELECT id, tx_hash, actor_wallet, action, target_wallet, record_id, status, error_message, created_at, updated_at
     FROM tx_log WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  if (isAdmin) { // wallet pasien (target add/update/delete_record) -> pseudonim
    const hidden = await adminHidden([...new Set(items.flatMap((t) => [t.actor_wallet, t.target_wallet]).filter(Boolean))]);
    for (const t of items) for (const k of ["actor_wallet", "target_wallet"]) t[k] = hidden.get(t[k]) ?? t[k];
  }
  res.json({ items, page, pageSize, total: Number(total) });
});

export const statsRouter = Router();

// GET /api/stats — Admin. Jumlah per role = profil MySQL yang role on-chain-nya sesuai.
// Admin hanya melihat ANGKA rekam medis, tidak pernah isinya.
statsRouter.get("/", requireRole("admin"), async (req, res) => {
  const [users] = await pool.execute("SELECT wallet_address FROM users");
  const roles = await Promise.all(users.map((u) => getRole(u.wallet_address)));
  const count = (r) => roles.filter((x) => x === r).length;
  const [[{ last7 }]] = await pool.execute(
    "SELECT COUNT(*) AS last7 FROM medical_records WHERE status IN ('confirmed','deleted') AND created_at >= NOW() - INTERVAL 7 DAY",
  );
  // Appointment hari ini: angka saja (tanpa alasan kunjungan).
  const [[{ today }]] = await pool.execute(
    "SELECT COUNT(*) AS today FROM appointments WHERE DATE(scheduled_at) = CURDATE() AND status IN ('requested','accepted','rescheduled_by_doctor','completed')",
  );
  res.json({
    appointmentsToday: Number(today),
    patients: count("patient"),
    doctors: count("doctor"),
    pendingProfiles: count("unregistered"), // profil tanpa role on-chain
    activeRecords: await getStats(),        // dari kontrak
    recordsLast7Days: Number(last7),        // dari MySQL (yang sudah tercatat on-chain)
  });
});
