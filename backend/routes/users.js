// /api/users — profil off-chain. Role TIDAK ada di MySQL: selalu dibaca dari kontrak.
// Status: "active" = wallet punya role on-chain, "pending" = profil ada tetapi role
// on-chain belum/tidak ada (mis. profil dibuat sebelum grantRole, atau role dicabut).
import { Router } from "express";
import { pool } from "../db.js";
import { getRole, contractEvents, findEvents } from "../chain.js";
import { requireRole, REGISTERED, isTreating, noAccess } from "../middleware/auth.js";
import { ROLES } from "../lib/roles.js";
import { ApiError, badRequest, forbidden, notFound, conflict } from "../lib/errors.js";
import {
  validateProfile, validateRevealReason, assertValid, walletParam, pagination, enumParam, searchParam, GENDERS,
} from "../lib/validate.js";
import { pseudonym, userRef, hiddenForAdmin, PSEUDONYM_RE, REF_RE } from "../lib/pseudonym.js";

const router = Router();
const COLS = "wallet_address, full_name, phone, birth_date, gender, address, specialization, staff_type, created_at, updated_at";
const STAFF = ["doctor"]; // staf yang dibuat Admin (Admin = deployer, Patient = registrasi sendiri)
const statusOf = (role) => (role === "unregistered" ? "pending" : "active");
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);

async function findProfile(wallet) {
  const [rows] = await pool.execute(`SELECT ${COLS} FROM users WHERE wallet_address = ?`, [wallet]);
  return rows[0] ?? null;
}
async function withRole(user) {
  const role = await getRole(user.wallet_address);
  return { ...user, role, status: statusOf(role) };
}

// Minimisasi data untuk tampilan Admin
// Admin mengelola akun, bukan merawat pasien: telepon & alamat disamarkan, tanggal lahir
// diganti umur. Data lengkap hanya lewat GET /:wallet/contact (tercatat di access_log).
/** "081234500006" -> "0812******06" (panjang tetap). */
export const maskPhone = (p) => (p.length <= 6 ? "*".repeat(p.length) : p.slice(0, 4) + "*".repeat(p.length - 6) + p.slice(-2));
/** "Jl. Anggrek No. 4, Sumedang" -> "Jl. Ang***, Sumedang" (kota = bagian setelah koma terakhir). */
export function maskAddress(a) {
  const i = a.lastIndexOf(",");
  const street = (i >= 0 ? a.slice(0, i) : a).trim();
  return `${street.slice(0, 7)}***${i >= 0 ? `, ${a.slice(i + 1).trim()}` : ""}`;
}
/** Umur (tahun penuh) dari "YYYY-MM-DD". */
export function ageOf(birthDate, now = new Date()) {
  const [y, m, d] = birthDate.split("-").map(Number);
  return now.getFullYear() - y - (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d) ? 1 : 0);
}
function masked({ phone, address, birth_date: birthDate, ...rest }) {
  return { ...rest, phone: maskPhone(phone), address: maskAddress(address), age: ageOf(birthDate), masked: true };
}
/**
 * Wallet profil yang BOLEH dilihat Admin (Set), dari role on-chain per request (u.role):
 *   - staf aktif: role Admin/Doctor saat ini;
 *   - kandidat dokter: role None + profil dokter + TIDAK pernah Patient (tanpa event PatientRegistered dan tanpa
 *     appointment sebagai pasien). Admin perlu memverifikasi wallet sebelum grantRole.
 * Selain itu (pasien, mantan pasien, wallet lain) = disamarkan. Fail closed: kontrak tidak terbaca -> 503.
 */
async function adminVisibleWallets(users) {
  const shown = new Set(users.filter((u) => !hiddenForAdmin(u.role)).map((u) => u.wallet_address));
  const cand = users.filter(isCandidateShape).map((u) => u.wallet_address);
  if (cand.length) {
    const former = await formerPatients(cand);
    for (const w of cand) if (!former.has(w)) shown.add(w);
  }
  return shown;
}
const isCandidateShape = (u) => u.role === "unregistered" && u.staff_type === "doctor";
/** Wallet (dari `wallets`) yang pernah Patient: event PatientRegistered on-chain atau appointment sebagai pasien. */
async function formerPatients(wallets) {
  const [rows] = await pool.query("SELECT DISTINCT patient_wallet FROM appointments WHERE patient_wallet IN (?)", [wallets]);
  const out = new Set(rows.map((r) => r.patient_wallet));
  for (const e of await findEvents("PatientRegistered", [wallets])) out.add(e.args.patient.toLowerCase()); // topik OR: salah satu wallet
  return out;
}

/**
 * Satu profil untuk Admin: tersamar. Profil yang disamarkan juga TANPA wallet & tanpa pseudonim: diganti ref "U-…"
 * (HMAC kunci lain, tidak bisa dicocokkan ke pseudonim di daftar akses/aktivitas), dan waktu hanya tanggal (jam
 * pembuatan profil = jam event PatientRegistered yang tampil di Riwayat Aktivitas). Kandidat dokter yang pernah
 * pasien diberi tanda former_patient: wallet-nya hanya lewat resolve-wallet (alasan wajib, tercatat).
 */
function adminView(u, shown) {
  const m = masked(u);
  if (shown.has(u.wallet_address)) return m;
  const { wallet_address: wallet, created_at: createdAt, updated_at: updatedAt, ...rest } = m;
  return {
    ref: userRef(wallet), ...rest, created_at: createdAt.slice(0, 10), updated_at: updatedAt.slice(0, 10),
    ...(isCandidateShape(u) ? { former_patient: true } : {}),
  };
}
const adminViewOne = async (u) => adminView(u, await adminVisibleWallets([u]));

/**
 * Target route /:wallet. Admin merujuk profil pasien lewat ref (U-…) dari daftar pengguna, BUKAN wallet,
 * jadi wallet pasien tidak pernah ada di URL maupun respons Admin. Role lain & profil staf tetap memakai wallet.
 */
async function targetOf(req) {
  if (req.role === "admin" && REF_RE.test(req.params.wallet)) return { wallet: await walletOfRef(req.params.wallet), byRef: true };
  return { wallet: walletParam(req.params.wallet), byRef: false };
}
/** Wallet profil dengan ref "U-…" (404 jika tidak ada). Dipakai juga pembatalan appointment mantan dokter. */
export async function walletOfRef(ref) {
  const [rows] = await pool.execute("SELECT wallet_address FROM users");
  // shortcut: ref dihitung ulang untuk semua profil per request (O(N) HMAC); untuk data besar simpan ref di kolom terindeks.
  const wallet = rows.find((r) => userRef(r.wallet_address) === ref)?.wallet_address;
  if (!wallet) throw notFound("Profil tidak ditemukan.");
  return wallet;
}
/** Admin + wallet + profil yang disamarkan -> 403: wallet -> nama tanpa jejak tidak boleh (pakai ref / jalur tercatat). */
async function assertAdminByRef(req, t, user, role) {
  if (req.role === "admin" && !t.byRef && t.wallet !== req.wallet
    && !(await adminVisibleWallets([{ ...user, role }])).has(t.wallet)) {
    throw forbidden("Profil pasien hanya dibuka lewat daftar pengguna, bukan alamat wallet.");
  }
}
// Pencarian/filter berdasarkan data tersamar ditolak, agar nilainya tidak bisa ditebak
// sedikit demi sedikit lewat hasil pencarian.
const FORBIDDEN_FILTERS = ["phone", "address", "birth_date", "age"];
const PHONE_LIKE = /^(\+62|0)8\d{2,}$/;

// GET /api/users?search=&gender=&role=&status=&page=&pageSize=
// Admin: semua profil.
// Doctor: HANYA pasien yang sedang ia rawat (isTreating: akses on-chain aktif + appointment disepakati).
// Pencarian hanya nama & wallet. Admin menerima telepon/alamat tersamar + umur.
// nama tetap dikirim ke Admin (manajemen akun butuh nama), tetapi endpoint ini hanya membaca tabel
// users: TANPA join ke appointment, akses dokter, jadwal, atau dokter yang merawat. specialization hanya
// milik profil dokter itu sendiri (pasien = null).
router.get("/", requireRole("admin", ...STAFF), async (req, res) => {
  const bad = FORBIDDEN_FILTERS.find((k) => k in req.query);
  if (bad) throw badRequest("Filter tidak diizinkan.", { [bad]: "Pencarian hanya berdasarkan nama atau alamat wallet." });
  const search = searchParam(req.query.search);
  if (PHONE_LIKE.test(search)) throw badRequest("Pencarian tidak diizinkan.", { search: "Pencarian hanya berdasarkan nama atau alamat wallet, bukan nomor telepon." });
  const gender = enumParam(req.query.gender, GENDERS, "gender") ?? null;
  const roleFilter = req.role === "admin"
    ? enumParam(req.query.role, ROLES, "role")
    : "patient"; // dokter tidak boleh melihat profil selain pasien, apa pun query-nya
  const statusFilter = enumParam(req.query.status, ["active", "pending"], "status");
  const { page, pageSize } = pagination(req.query);

  const like = `%${escapeLike(search)}%`;
  // wallet_address = ascii_bin: parameter non-ASCII tidak bisa dibandingkan (Illegal mix of collations).
  // Klausa wallet hanya untuk pencarian heksadesimal; selain itu NULL (tidak cocok apa pun).
  const walletLike = /^(0x)?[0-9a-f]+$/i.test(search) ? like.toLowerCase() : null;
  const [rows] = await pool.execute(
    `SELECT ${COLS}, (full_name LIKE ?) AS name_hit FROM users
     WHERE (? = '' OR full_name LIKE ? OR (? IS NOT NULL AND wallet_address LIKE ?))
       AND (? IS NULL OR gender = ?)
     ORDER BY full_name`,
    [like, search, like, walletLike, walletLike, gender, gender],
  );
  const nameHit = new Set(rows.filter((r) => r.name_hit).map((r) => r.wallet_address));
  for (const r of rows) delete r.name_hit;
  // shortcut: role dibaca per profil tiap request (N panggilan RPC); untuk data besar perlu cache/indeks event.
  const withRoles = await Promise.all(rows.map(withRole));
  const shown = req.role === "admin" ? await adminVisibleWallets(withRoles) : null;
  const all = withRoles
    .filter((u) => !roleFilter || u.role === roleFilter)
    .filter((u) => !statusFilter || u.status === statusFilter)
    // Admin mencari pasien hanya lewat nama; wallet pasien tidak boleh jadi kunci pencarian (peta wallet -> nama).
    .filter((u) => req.role !== "admin" || !search || nameHit.has(u.wallet_address) || shown.has(u.wallet_address));
  const visible = req.role === "doctor"
    ? (await Promise.all(all.map(async (u) => ((await isTreating(u.wallet_address, req.wallet)) ? u : null)))).filter(Boolean)
    : all;
  const items = visible.slice((page - 1) * pageSize, page * pageSize);
  res.json({ items: req.role === "admin" ? items.map((u) => adminView(u, shown)) : items, page, pageSize, total: visible.length });
});

// GET /api/users/me — profil sendiri
router.get("/me", requireRole(...REGISTERED), async (req, res) => {
  const user = await findProfile(req.wallet);
  if (!user) throw notFound("Profil belum dibuat.");
  res.json({ ...user, role: req.role, status: statusOf(req.role) });
});

// PUT /api/users/me — ubah profil sendiri (wallet & role tidak bisa diubah di sini)
router.put("/me", requireRole(...REGISTERED), async (req, res) => {
  const v = assertValid(validateProfile(req.body, { needSpecialization: STAFF.includes(req.role) }));
  const [r] = await pool.execute(
    "UPDATE users SET full_name = ?, phone = ?, birth_date = ?, gender = ?, address = ?, specialization = ? WHERE wallet_address = ?",
    [v.full_name, v.phone, v.birth_date, v.gender, v.address, v.specialization, req.wallet],
  );
  if (r.affectedRows === 0) throw notFound("Profil belum dibuat.");
  res.json({ ...(await findProfile(req.wallet)), role: req.role, status: statusOf(req.role) });
});

// POST /api/users/register — registrasi pasien SETELAH registerAsPatient() on-chain.
// Wallet dari sesi (req.wallet), BUKAN dari body. Role on-chain wajib Patient.
router.post("/register", requireRole("patient"), async (req, res) => {
  const v = assertValid(validateProfile(req.body, { needSpecialization: false }));
  if (await findProfile(req.wallet)) throw conflict("Profil untuk wallet ini sudah ada.");
  try {
    await pool.execute(
      "INSERT INTO users (wallet_address, full_name, phone, birth_date, gender, address, specialization) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      [req.wallet, v.full_name, v.phone, v.birth_date, v.gender, v.address],
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") throw conflict("Profil untuk wallet ini sudah ada.");
    throw err;
  }
  res.status(201).json({ ...(await findProfile(req.wallet)), role: "patient", status: "active" });
});

// POST /api/users — Admin membuat profil Doctor (sebelum atau sesudah grantRole).
// body: { wallet, role: "doctor", full_name, phone, birth_date, gender, address, specialization }
router.post("/", requireRole("admin"), async (req, res) => {
  const wallet = walletParam(req.body?.wallet);
  const intended = req.body?.role;
  if (!STAFF.includes(intended)) throw badRequest("Data tidak valid.", { role: "Admin hanya dapat membuat profil Dokter." });
  const v = assertValid(validateProfile(req.body, { needSpecialization: true }));

  // Role on-chain harus kosong (grantRole belum dikirim) atau sudah sesuai.
  const onchain = await getRole(wallet);
  if (onchain !== "unregistered" && onchain !== intended) {
    throw conflict(`Wallet ini sudah ber-role ${onchain} di kontrak.`);
  }
  try {
    await pool.execute(
      // staff_type hanya INFORMATIF (jenis staf yang dimaksud); otorisasi tetap dari role on-chain.
      "INSERT INTO users (wallet_address, full_name, phone, birth_date, gender, address, specialization, staff_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [wallet, v.full_name, v.phone, v.birth_date, v.gender, v.address, v.specialization, intended],
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") throw conflict("Profil untuk wallet ini sudah ada.");
    throw err;
  }
  res.status(201).json(masked({ ...(await findProfile(wallet)), role: onchain, status: statusOf(onchain) }));
});

// GET /api/users/:wallet/contact — Admin: data kontak LENGKAP (telepon, alamat, tanggal lahir)
// untuk form edit. Setiap akses dicatat di access_log (append-only) SEBELUM data dikirim.
// Profil pasien: lewat ref (U-…); respons tanpa wallet.
router.get("/:wallet/contact", requireRole("admin"), async (req, res) => {
  const t = await targetOf(req);
  const user = await findProfile(t.wallet);
  if (!user) throw notFound("Profil tidak ditemukan.");
  await assertAdminByRef(req, t, user, await getRole(t.wallet));
  await pool.execute("INSERT INTO access_log (actor_wallet, target_wallet, field_group) VALUES (?, ?, 'contact')", [req.wallet, t.wallet]);
  res.set("Cache-Control", "no-store");
  res.json({ ...(t.byRef ? { ref: req.params.wallet } : { wallet_address: t.wallet }), phone: user.phone, address: user.address, birth_date: user.birth_date });
});

// GET /api/users/:wallet — Admin: semua. Doctor: hanya pasien yang sedang ia rawat (isTreating).
// Patient: hanya dirinya.
// Akses dicek SEBELUM membaca database (cegah IDOR & enumerasi profil).
router.get("/:wallet", requireRole(...REGISTERED), async (req, res) => {
  const t = await targetOf(req); // Admin: ref untuk profil pasien
  const { wallet } = t;
  const targetRole = await getRole(wallet);
  const allowed = req.role === "admin" || (req.role === "patient" && wallet === req.wallet);
  if (req.role === "doctor" && targetRole === "patient") {
    if (!(await isTreating(wallet, req.wallet))) throw noAccess();
  } else if (!allowed) throw forbidden("Anda tidak memiliki akses ke profil ini.");
  const user = await findProfile(wallet);
  if (!user) throw notFound("Profil tidak ditemukan.");
  await assertAdminByRef(req, t, user, targetRole);
  const out = { ...user, role: targetRole, status: statusOf(targetRole) };
  // Admin melihat profil orang lain dalam bentuk tersamar (pasien: tanpa wallet); pemilik profil selalu lengkap.
  res.json(req.role === "admin" && wallet !== req.wallet ? await adminViewOne(out) : out);
});

// PUT /api/users/:wallet — Admin mengubah profil siapa pun.
router.put("/:wallet", requireRole("admin"), async (req, res) => {
  const t = await targetOf(req);
  const { wallet } = t;
  const targetRole = await getRole(wallet);
  const existing = await findProfile(wallet);
  if (!existing) throw notFound("Profil tidak ditemukan.");
  await assertAdminByRef(req, t, existing, targetRole);
  // Dokter aktif ATAU profil dokter yang belum diberi role (staff_type) wajib punya spesialisasi.
  const needSpecialization = STAFF.includes(targetRole) || existing.staff_type === "doctor";
  const v = assertValid(validateProfile(req.body, { needSpecialization }));
  const [r] = await pool.execute(
    "UPDATE users SET full_name = ?, phone = ?, birth_date = ?, gender = ?, address = ?, specialization = ? WHERE wallet_address = ?",
    [v.full_name, v.phone, v.birth_date, v.gender, v.address, v.specialization, wallet],
  );
  if (r.affectedRows === 0) throw notFound("Profil tidak ditemukan.");
  res.json(await adminViewOne({ ...(await findProfile(wallet)), role: targetRole, status: statusOf(targetRole) }));
});

// DELETE /api/users/:wallet — Admin: hanya jika wallet sudah TIDAK punya role on-chain
// (cabut role dulu). Patient: hanya profilnya sendiri. Rekam medis TIDAK ikut terhapus.
router.delete("/:wallet", requireRole("admin", "patient"), async (req, res) => {
  const t = await targetOf(req); // Admin: ref untuk profil pasien
  const { wallet } = t;
  if (req.role === "patient") {
    if (wallet !== req.wallet) throw forbidden("Anda hanya dapat menghapus profil sendiri.");
  } else {
    const role = await getRole(wallet);
    const existing = await findProfile(wallet);
    if (!existing) throw notFound("Profil tidak ditemukan.");
    await assertAdminByRef(req, t, existing, role);
    if (role !== "unregistered") throw conflict("Wallet ini masih punya role di kontrak. Cabut role-nya dulu (revokeRole).");
  }
  const [r] = await pool.execute("DELETE FROM users WHERE wallet_address = ?", [wallet]);
  if (r.affectedRows === 0) throw notFound("Profil tidak ditemukan.");
  res.status(204).end();
});

export default router;

// /api/admin/patients — satu-satunya jalur (tercatat) dari pseudonim/ref ke nama atau wallet pasien
// Admin melihat pasien sebagai pseudonim (daftar akses, aktivitas, tx-log) atau nama + ref (daftar pengguna); kedua
// daftar tidak punya kunci bersama. Membuka nama / wallet: alasan WAJIB 10–200 karakter (validator teks), dicatat di
// access_log (Admin, waktu, wallet pasien, jenis, alasan; append-only) SEBELUM data dikirim, maks REVEAL_LIMIT per
// Admin per jam per jenis (dihitung dari access_log, tahan restart). Input di BODY, bukan URL (tidak masuk log server).
export const adminPatientsRouter = Router();
const REVEAL_LIMIT = 10;

/** { pseudonym } (atau { ref } bila allowRef) — tepat satu, format persis. */
function selectorOf(body, allowRef) {
  const { pseudonym: p, ref } = body ?? {};
  if (typeof p === "string" && PSEUDONYM_RE.test(p) && ref === undefined) return { pseudonym: p };
  if (allowRef && typeof ref === "string" && REF_RE.test(ref) && p === undefined) return { ref };
  throw badRequest("Data tidak valid.", allowRef
    ? { pseudonym: "Isi tepat satu: pseudonim pasien (P- + 8 heksadesimal) atau rujukan profil (U- + 16 heksadesimal)." }
    : { pseudonym: "Pseudonim pasien: P- diikuti 8 karakter heksadesimal." });
}
/** Validasi alasan + batas per jam; dipanggil SEBELUM data apa pun dicari. Mengembalikan alasan (sudah di-trim). */
async function revealGuard(req, kind) {
  const reason = assertValid(validateRevealReason(req.body));
  const [[{ n }]] = await pool.execute(
    "SELECT COUNT(*) AS n FROM access_log WHERE actor_wallet = ? AND field_group = ? AND created_at > NOW() - INTERVAL 1 HOUR",
    [req.wallet, kind],
  );
  // shortcut: dua request yang benar-benar bersamaan bisa melewati batas 1 kali; cukup untuk satu Admin.
  // Tanpa Retry-After: berbeda dengan rate limit global per IP (klien tidak perlu mengulang otomatis).
  if (Number(n) >= REVEAL_LIMIT) throw new ApiError(429, "REVEAL_LIMIT", `Batas membuka data pasien tercapai (${REVEAL_LIMIT} per jam). Coba lagi nanti.`);
  return reason;
}
/** Wallet yang cocok dengan pseudonim/ref. Kandidat: profil MySQL (+ alamat di event kontrak bila withEvents). */
async function resolvePatient(sel, withEvents) {
  const [rows] = await pool.execute("SELECT wallet_address FROM users");
  const wallets = new Set(rows.map((r) => r.wallet_address));
  // Pasien tanpa profil (mis. profil dihapus) tetap bisa punya relasi akses on-chain yang perlu dicabut Admin.
  if (withEvents) for (const e of await contractEvents()) for (const v of Object.values(e.args)) if (typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v)) wallets.add(v);
  // shortcut: HMAC dihitung untuk semua kandidat per request (O(N)); untuk data besar perlu indeks pseudonim.
  const match = [...wallets].filter((w) => (sel.ref ? userRef(w) === sel.ref : pseudonym(w) === sel.pseudonym));
  if (match.length > 1) throw conflict("Pseudonim ini cocok dengan lebih dari satu wallet. Hubungi pengembang.");
  if (!match.length) throw notFound("Pasien tidak ditemukan.");
  return match[0];
}
const logReveal = (req, wallet, kind, reason) => pool.execute(
  "INSERT INTO access_log (actor_wallet, target_wallet, field_group, reason) VALUES (?, ?, ?, ?)", [req.wallet, wallet, kind, reason]);

// POST /api/admin/patients/identity { pseudonym, reason } — "Buka identitas": nama pasien di balik pseudonim.
// Respons hanya { pseudonym, full_name }: tanpa wallet, kontak, rekam medis, atau resep.
adminPatientsRouter.post("/identity", requireRole("admin"), async (req, res) => {
  const sel = selectorOf(req.body, false);
  const reason = await revealGuard(req, "identity");
  const wallet = await resolvePatient(sel, false);
  const user = await findProfile(wallet);
  if (!user) throw notFound("Profil tidak ditemukan.");
  await logReveal(req, wallet, "identity", reason);
  res.json({ pseudonym: sel.pseudonym, full_name: user.full_name });
});

// POST /api/admin/patients/resolve-wallet { pseudonym | ref, reason } — wallet pasien untuk transaksi Admin
// (revokeDoctorAccess, revokeRole pasien). Frontend memanggilnya tepat sebelum MetaMask dibuka dan tidak menyimpannya.
// Respons hanya { wallet_address }: tanpa nama.
adminPatientsRouter.post("/resolve-wallet", requireRole("admin"), async (req, res) => {
  const sel = selectorOf(req.body, true);
  const reason = await revealGuard(req, "wallet");
  const wallet = await resolvePatient(sel, Boolean(sel.pseudonym));
  await logReveal(req, wallet, "wallet", reason);
  res.json({ wallet_address: wallet });
});

/** Dokter aktif = profil yang role on-chain-nya Doctor: { wallet_address, full_name, specialization }. */
export async function activeDoctors() {
  const [rows] = await pool.execute("SELECT wallet_address, full_name, specialization FROM users ORDER BY full_name");
  // shortcut: role dibaca per profil (N panggilan RPC); untuk data besar perlu cache/indeks event.
  const roles = await Promise.all(rows.map((u) => getRole(u.wallet_address)));
  return rows.filter((_, i) => roles[i] === "doctor");
}
