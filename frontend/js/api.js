// api.js — SATU-SATUNYA lapisan data untuk semua halaman: fetch ke backend (same-origin, cookie
// sesi HttpOnly) + transaksi kontrak lewat chain.js (runTx). Bentuk data mengikuti respons endpoint di backend/routes.
// Frontend hanya kenyamanan: role, akses & validasi WAJIB ditegakkan backend dan kontrak.
// Fungsi transaksi menerima opts = { signer?, onStage? }:
//   signer  default = MetaMask (browserSigner, harus = wallet sesi); di Node: ethers.Wallet (uji).
//   onStage dipanggil per tahap runTx (awaiting_signature -> pending -> confirmed/rejected/reverted/failed).
// Hasilnya objek runTx ({ status, txHash, message, ... }) — penolakan/revert tidak melempar.
import { getSession, setSession, clearSession } from "./session.js";
import { validateProfile } from "./validation.js";
import { computeDataHash } from "./hash.js";
import { isCleanText, textMessage } from "./text.js";
import { CHAIN_ID, CHAIN_NAME, CONTRACT_ADDRESS } from "./config.js";
import { runTx, browserSigner, iface, revertName, REVERT_TEXT, getRecord as chainGetRecord } from "./chain.js";
import { roleToEnum } from "./chain-format.js";

export const NETWORK = { name: CHAIN_NAME, chainId: CHAIN_ID };
const me = () => getSession()?.wallet;
const PROFILE_KEYS = ["full_name", "phone", "birth_date", "gender", "address", "specialization"];

// Error dengan pesan yang aman ditampilkan ke pengguna: { status, code, message, fields? }.
export class ApiError extends Error {}
const fail = (status, code, message, fields) => Object.assign(new ApiError(message), { status, code, ...(fields ? { fields } : {}) });

// HTTP + penanganan error terpusat
// Kode yang pesannya diganti teks yang lebih jelas bagi pengguna. Kode lain memakai pesan backend
// (sudah Bahasa Indonesia); VALIDATION_ERROR memakai pesan field pertama (label = label form).
const CODE_TEXT = {
  NETWORK: "Server BioCare tidak terjangkau. Pastikan backend berjalan lalu coba lagi.",
  UNAUTHENTICATED: "Sesi Anda sudah berakhir. Silakan masuk lagi.",
  CHAIN_UNAVAILABLE: "Blockchain lokal tidak terjangkau. Pastikan node Hardhat berjalan, lalu coba lagi.",
  RATE_LIMITED: "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.",
  BAD_ORIGIN: "Permintaan ditolak. Buka aplikasi lewat alamat resmi (http://127.0.0.1:3000).",
  PAYLOAD_TOO_LARGE: "Data yang dikirim terlalu besar.",
  INTERNAL_ERROR: "Terjadi kesalahan pada server. Coba lagi.",
};
// "prescriptions.1.ingredients.0.name" -> awalan "Obat 2, bahan 1: " agar pesan toast jelas.
function fieldText(key, msg) {
  const m = /^prescriptions\.(\d+)(?:\.ingredients\.(\d+))?/.exec(key);
  return m ? `Obat ${Number(m[1]) + 1}${m[2] !== undefined ? `, bahan ${Number(m[2]) + 1}` : ""}: ${msg}` : msg;
}
async function http(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw fail(0, "NETWORK", CODE_TEXT.NETWORK);
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.ok) return data;
  const code = data?.error?.code ?? "HTTP_ERROR";
  const fields = data?.error?.fields;
  const first = fields && Object.entries(fields)[0];
  // 401 di luar /api/auth/* = sesi habis/dicabut -> kembali ke halaman login.
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    clearSession();
    globalThis.location?.replace?.("index.html");
  }
  throw fail(res.status, code, CODE_TEXT[code] ?? (first ? fieldText(...first) : data?.error?.message ?? "Terjadi kesalahan pada server."), fields);
}
const q = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  return s ? `?${s}` : "";
};
// Semua halaman sebuah daftar ber-pagination (pageSize maks 100 di backend).
async function allPages(path, params = {}) {
  const items = [];
  for (let page = 1; ; page++) {
    const r = await http("GET", path + q({ ...params, page, pageSize: 100 }));
    items.push(...r.items);
    if (!r.items.length || items.length >= r.total) return items;
  }
}
const nullOn404 = (err) => { if (err.status === 404) return null; throw err; };

// Login & sesi
// Sesi = cookie HttpOnly berisi JWT (tidak bisa dibaca JavaScript). sessionStorage hanya CERMIN
// { wallet, role } untuk menu & tampilan; role tetap dibaca backend dari kontrak setiap request.
// loginAt dipertahankan selama wallet sama (authMe dipanggil setiap dashboard dimuat).
const mirror = ({ address, role }) => {
  const cur = getSession();
  return setSession({ wallet: address, role, loginAt: cur?.wallet === address ? cur.loginAt : undefined });
};

/** POST /api/auth/nonce -> pesan SIWE (EIP-4361) yang harus ditandatangani APA ADANYA. */
export const authNonce = async (address) => (await http("POST", "/api/auth/nonce", { address })).message;
/** POST /api/auth/verify -> { address, role }. Wallet tanpa role: ApiError code "NO_ROLE" (403). */
export async function authVerify(message, signature) {
  const s = await http("POST", "/api/auth/verify", { message, signature });
  mirror(s);
  return s;
}
/** GET /api/auth/me -> { address, role (dari kontrak), hasProfile }. Belum login: ApiError status 401. */
export async function authMe() {
  const s = await http("GET", "/api/auth/me");
  if (s.role !== "unregistered") mirror(s);
  return s;
}
/** POST /api/auth/logout — sesi dicabut di server + cookie dihapus. Tidak pernah melempar. */
export async function authLogout() {
  clearSession();
  try { await http("POST", "/api/auth/logout"); } catch { /* server mati: cookie tetap kedaluwarsa sendiri */ }
}

// Profil
// Ambil hanya field profil yang dikenal + validasi (cermin validasi backend; backend tetap penentu).
function cleanProfile(data, needSpecialization) {
  const d = Object.fromEntries(PROFILE_KEYS.map((k) => [k, String(data[k] ?? "").trim()]));
  if (!needSpecialization) d.specialization = "";
  const errors = validateProfile(d, needSpecialization);
  if (Object.keys(errors).length) throw fail(400, "VALIDATION_ERROR", Object.values(errors)[0], errors);
  return d;
}
// key = rujukan profil untuk route/aksi: wallet, atau ref "U-…" untuk profil pasien di tampilan Admin
// (Admin tidak menerima wallet pasien).
const toUser = (u) => ({ ...u, wallet: u.wallet_address, key: u.ref ?? u.wallet_address });

/** POST /api/users/register — profil pasien; backend memakai wallet dari SESI & cek role on-chain = Patient. */
export const registerProfile = (profile) => http("POST", "/api/users/register", cleanProfile(profile, false));

// Admin: semua profil (tersamar). Dokter = role Doctor ATAU profil dokter yang belum/tidak lagi
// punya role (staff_type doctor, status pending) agar bisa diberi role. Pasien = sisanya kecuali Admin.
const isDoctorProfile = (u) => u.role === "doctor" || (u.role === "unregistered" && u.staff_type === "doctor");
const allUsers = async () => (await allPages("/api/users")).map(toUser);

/**
 * kind: "patient" | "doctor".
 * Admin: profil tersamar. Doctor: hanya pasien yang aksesnya aktif (backend), ditambah accessSince
 * & recordCount untuk tampilan.
 */
export async function getUsers(kind) {
  if (getSession()?.role !== "doctor") {
    return (await allUsers()).filter((u) => u.role !== "admin" && (kind === "doctor") === isDoctorProfile(u));
  }
  const [list, access] = await Promise.all([allPages("/api/users"), getDoctorAccess()]);
  const since = new Map(access.items.map((a) => [a.patient_wallet, a.since]));
  // shortcut: jumlah rekam medis = 1 request per pasien; untuk banyak pasien perlu endpoint ringkasan.
  return Promise.all(list.map(async (u) => ({
    ...toUser(u),
    accessSince: since.get(u.wallet_address) ? new Date(since.get(u.wallet_address) * 1000).toISOString() : null,
    recordCount: (await getRecords(u.wallet_address, { verify: false })).length,
  })));
}
/** Pengguna yang terakhir ditambah/diubah (dashboard Admin). */
export async function getRecentUsers(limit = 5) {
  return (await allUsers()).filter((u) => u.role !== "admin" || u.wallet !== me())
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, limit);
}
/** GET /api/users/:key (wallet, atau ref U-… untuk Admin) — null jika profil tidak ada. Dokter tanpa akses: ApiError NO_ACCESS. */
export const getUser = async (key) => {
  const u = await http("GET", `/api/users/${encodeURIComponent(key)}`).catch(nullOn404);
  return u && toUser(u);
};
/** Admin: kontak lengkap (key = user.key); setiap akses dicatat backend di access_log. */
export const getContact = (key) => http("GET", `/api/users/${encodeURIComponent(key)}/contact`);
// Alasan Admin dicek dengan aturan teks backend (js/text.js) SEBELUM request; backend memvalidasi ulang (10–200).
function checkReason(reason) {
  if (isCleanText(reason)) return;
  const msg = textMessage("Alasan");
  throw fail(400, "INVALID_TEXT", msg, { reason: msg });
}
/**
 * Admin: "Buka identitas" pasien di balik pseudonim -> { pseudonym, full_name }. Backend mencatat ke
 * access_log dan membatasi 10/jam per Admin (429 REVEAL_LIMIT). Pseudonim di body, bukan URL.
 */
export async function revealIdentity(pseudonym, reason) {
  checkReason(reason);
  return http("POST", "/api/admin/patients/identity", { pseudonym, reason });
}
/**
 * Admin: wallet pasien HANYA untuk transaksi yang akan langsung ditandatangani. Dicatat backend di access_log
 * (alasan wajib, 10/jam). Dipanggil tepat sebelum MetaMask dibuka; hasilnya tidak disimpan di state UI.
 * who = { pseudonym } (daftar akses) atau { ref } (daftar pengguna).
 */
async function resolvePatientWallet(who, reason) {
  checkReason(reason);
  return (await http("POST", "/api/admin/patients/resolve-wallet", { ...who, reason })).wallet_address;
}
export const getMyProfile = async () => {
  const u = await http("GET", "/api/users/me").catch(nullOn404);
  return u && toUser(u);
};
/** Simpan profil sendiri. Pasien yang profilnya belum ada -> dibuat (POST /api/users/register). */
export async function saveProfile(data) {
  const role = getSession()?.role;
  const d = cleanProfile(data, role === "doctor");
  try {
    return toUser(await http("PUT", "/api/users/me", d));
  } catch (err) {
    if (err.status === 404 && role === "patient") return toUser(await http("POST", "/api/users/register", d));
    throw err;
  }
}
/** Admin mengubah profil pengguna lain (key = user.key). needSpecialization = profil dokter. */
export const updateUserProfile = async (key, data, needSpecialization) =>
  toUser(await http("PUT", `/api/users/${encodeURIComponent(key)}`, cleanProfile(data, needSpecialization)));
/** Hapus profil off-chain: Admin (key = user.key; wallet tanpa role) atau Patient (wallet miliknya). */
export const deleteProfile = (key) => http("DELETE", `/api/users/${encodeURIComponent(key)}`);

// Transaksi + pencatatan (POST /api/access/log)
const txOpts = (opts = {}) => ({ signer: opts.signer ?? browserSigner(me()), onStage: opts.onStage });
/** Kirim tx; jika confirmed, catat ke tx_log. Gagal mencatat -> r.logError (tx sudah sah on-chain). */
async function txAndLog(buildTx, log, opts) {
  const r = await runTx(buildTx, txOpts(opts));
  if (r.status === "confirmed") {
    try { r.log = await logAccessTx({ ...log, txHash: r.txHash }); } catch (err) { r.logError = err; }
  }
  return r;
}
/** POST /api/access/log — catat tx yang SUDAH sukses (receipt diverifikasi backend). */
export const logAccessTx = (body) => http("POST", "/api/access/log", body);

/**
 * Admin mendaftarkan Dokter: profil (status pending) -> grantRole(wallet, Doctor) -> log grant_role.
 * Jika tx ditolak/gagal, profil tetap pending dan role bisa diberikan lagi lewat grantDoctorRole.
 */
export async function addStaff(wallet, data, opts) {
  const w = String(wallet ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(w)) throw fail(400, "VALIDATION_ERROR", "Alamat wallet tidak valid.", { wallet: "Harus 0x diikuti 40 karakter heksadesimal." });
  const user = toUser(await http("POST", "/api/users", { wallet: w, role: "doctor", ...cleanProfile(data, true) }));
  return { user, tx: user.role === "doctor" ? null : await grantDoctorRole(w, opts) };
}
export const grantDoctorRole = (account, opts) =>
  txAndLog((c) => c.grantRole(account, roleToEnum("doctor")), { action: "grant_role", account, role: "doctor" }, opts);
/** Admin: grantRole untuk kandidat yang pernah pasien (ref) — wallet dibuka lewat resolve-wallet (tercatat) lalu langsung dipakai. */
export const grantDoctorRoleByRef = async (ref, reason, opts) => grantDoctorRole(await resolvePatientWallet({ ref }, reason), opts);
export const revokeRole = (account, opts) => txAndLog((c) => c.revokeRole(account), { action: "revoke_role", account }, opts);
/** Admin: cabut role pasien dari daftar pengguna (ref) — wallet dibuka lewat resolve-wallet (tercatat) lalu langsung dipakai. */
export const revokePatientRole = async (ref, reason, opts) => revokeRole(await resolvePatientWallet({ ref }, reason), opts);

// Akses dokter
export const getMyAccess = () => http("GET", "/api/access/me");
export const getDoctorAccess = () => http("GET", "/api/access/doctor");
export const getAllAccess = ({ status } = {}) => http("GET", `/api/access${q({ status })}`);
/** Patient (miliknya): revokeDoctorAccess -> log revoke_access. */
export const revokeAccess = (patient, doctor, opts) =>
  txAndLog((c) => c.revokeDoctorAccess(patient, doctor), { action: "revoke_access", patient, doctor }, opts);
/** Admin: cabut akses dokter ke pasien berpseudonim — wallet dibuka lewat resolve-wallet (tercatat) lalu langsung dipakai. */
export const revokeAccessAsAdmin = async (pseudonym, doctor, reason, opts) =>
  revokeAccess(await resolvePatientWallet({ pseudonym }, reason), doctor, opts);
/** Doctor melepas aksesnya: renounceAccess -> log renounce_access. */
export const renounceAccess = (patient, opts) => txAndLog((c) => c.renounceAccess(patient), { action: "renounce_access", patient }, opts);

// Rekam medis
// Cermin validatePrescriptions di backend (backend/lib/validate.js): 0–20 item, single tanpa bahan,
// compound 2–10 bahan, error berkunci "prescriptions.<i>.<field>" / "prescriptions.<i>.ingredients.<j>.<field>".
// Batas & label HARUS sama dengan validate.js (batas dibandingkan otomatis di scripts/test-e2e-node.mjs).
export const RX_MAX = 20;
export const RX_QTY_MAX = 9999;
export const RX_INGR_MIN = 2;
export const RX_INGR_MAX = 10;
// [kunci, min, max, label] — min 0 = opsional (kosong -> null). label = label form = label pesan backend.
export const RX_ITEM = [["name", 2, 100, "Nama obat"], ["strength", 0, 50, "Kekuatan"], ["form", 1, 50, "Bentuk sediaan"],
  ["unit", 1, 20, "Satuan"], ["signa", 1, 100, "Aturan pakai"], ["duration", 1, 50, "Durasi"], ["instructions", 0, 255, "Instruksi"]];
export const RX_INGR = [["name", 2, 100, "Nama bahan"], ["strength", 1, 50, "Kekuatan bahan"], ["amount", 1, 50, "Jumlah per sediaan"]];
const len = (s) => [...(s ?? "")].length; // panjang dalam code point, sama dengan backend
const checkText = (obj, rules, e, at) => {
  for (const [k, min, max, label] of rules) {
    const n = len(obj[k]);
    if (min ? n < min || n > max : n > max) e[`${at}.${k}`] = min ? `${label} wajib ${min}–${max} karakter.` : `${label} maksimal ${max} karakter.`;
    if (!isCleanText(obj[k] ?? "")) e[`${at}.${k}`] = textMessage(label); // field resep = satu baris
  }
};
export function validateRecord(d) {
  const e = {};
  if (len(d.diagnosis) < 3 || len(d.diagnosis) > 200) e.diagnosis = "Diagnosis wajib 3–200 karakter.";
  if (len(d.treatment) < 3 || len(d.treatment) > 500) e.treatment = "Tindakan wajib 3–500 karakter.";
  if (len(d.notes) > 1000) e.notes = "Catatan maksimal 1000 karakter.";
  // Aturan karakter (js/text.js) SEBELUM hash dihitung: diagnosis satu baris, tindakan & catatan textarea.
  if (!isCleanText(d.diagnosis ?? "")) e.diagnosis = textMessage("Diagnosis");
  if (!isCleanText(d.treatment ?? "", true)) e.treatment = textMessage("Tindakan", true);
  if (!isCleanText(d.notes ?? "", true)) e.notes = textMessage("Catatan", true);
  const list = d.prescriptions ?? [];
  if (list.length > RX_MAX) e.prescriptions = `Maksimal ${RX_MAX} item per resep.`;
  list.forEach((p, i) => {
    const at = `prescriptions.${i}`;
    if (!["single", "compound"].includes(p.type)) e[`${at}.type`] = "Jenis obat harus satuan atau racikan.";
    checkText(p, RX_ITEM, e, at);
    if (!Number.isSafeInteger(p.quantity) || p.quantity < 1 || p.quantity > RX_QTY_MAX) e[`${at}.quantity`] = `Jumlah harus bilangan bulat 1–${RX_QTY_MAX}.`;
    const ingr = p.ingredients ?? [];
    const n = ingr.length;
    if (p.type === "single" && n) e[`${at}.ingredients`] = "Obat satuan tidak boleh punya bahan racikan.";
    else if (p.type === "compound" && (n < RX_INGR_MIN || n > RX_INGR_MAX)) e[`${at}.ingredients`] = `Racikan wajib ${RX_INGR_MIN}–${RX_INGR_MAX} bahan.`;
    else ingr.forEach((g, j) => checkText(g, RX_INGR, e, `${at}.ingredients.${j}`));
  });
  return e;
}
// Normalisasi SEKALI (trim + NFC) seperti backend; opsional kosong -> null; quantity tetap angka.
// Hasilnya = nilai yang akan disimpan backend, jadi dipakai juga untuk MENGHITUNG ULANG hash.
const txt = (v) => String(v ?? "").trim().normalize("NFC");
const cleanRx = (list) => (Array.isArray(list) ? list : []).map((p) => ({
  type: txt(p.type), name: txt(p.name), strength: txt(p.strength) || null, form: txt(p.form),
  quantity: p.quantity, // harus number dari form; string ditolak validator seperti backend
  unit: txt(p.unit), signa: txt(p.signa), duration: txt(p.duration), instructions: txt(p.instructions) || null,
  ingredients: (Array.isArray(p.ingredients) ? p.ingredients : []).map((g) => ({ name: txt(g.name), strength: txt(g.strength), amount: txt(g.amount) })),
}));
function cleanRecord(data) {
  const d = { diagnosis: txt(data.diagnosis), treatment: txt(data.treatment), notes: txt(data.notes), prescriptions: cleanRx(data.prescriptions) };
  const errors = validateRecord(d);
  if (Object.keys(errors).length) throw fail(400, "VALIDATION_ERROR", fieldText(...Object.entries(errors)[0]), errors);
  return d;
}

// Bentuk rekam medis di UI (dari baris API): nama field camelCase + integrity "ok" | "bad" | "none".
const toRecord = (r) => ({
  id: r.id, onchainId: r.onchain_id, patient: r.patient_wallet, doctor: r.doctor_wallet,
  patientName: r.patient_name ?? "Tanpa profil", doctorName: r.doctor_name ?? "Tanpa profil",
  diagnosis: r.diagnosis, treatment: r.treatment, notes: r.notes, status: r.status, salt: r.salt, dataHash: r.data_hash,
  created_at: r.created_at, updated_at: r.updated_at, integrity: "none", chainHash: null,
});
/**
 * Verifikasi integritas DI BROWSER, tanpa memercayai backend untuk hasilnya:
 *   localHash = keccak256(salt ‖ JSON kanonik) dihitung hash.js dari isi + resep + salt yang diterima API;
 *   chainHash dibaca LANGSUNG dari kontrak lewat chain.js (MetaMask; getRecord butuh from = pengguna):
 *     versionNo kosong -> getRecord(onchainId) = hash versi yang berlaku;
 *     versionNo diisi  -> hash di event tx versi itu (RecordAdded.dataHash / RecordUpdated.newHash).
 * detail = hasil getRecord(id). opts.runner = Signer (default MetaMask wallet sesi; di Node: ethers.Wallet).
 * -> { state: "ok" | "bad" | "deleted" | "none", localHash, chainHash, reason }
 */
export async function verifyInBrowser(detail, versionNo = null, { runner } = {}) {
  runner = runner ?? await browserSigner(me());
  const v = versionNo ? detail.versions.find((x) => x.version_no === versionNo) : null;
  if (versionNo && !v) throw fail(404, "NOT_FOUND", "Versi rekam medis tidak ditemukan.");
  const src = v ?? detail;
  let localHash = null;
  try {
    localHash = computeDataHash(src.salt, { patient: detail.patient, doctor: detail.doctor, diagnosis: src.diagnosis,
      treatment: src.treatment, notes: src.notes, prescriptions: v ? v.prescriptions : detail.prescriptions });
  } catch { /* data/salt rusak -> tidak bisa cocok */ }
  const out = (state, chainHash, reason) => ({ state: state === "ok" && !localHash ? "bad" : state, localHash, chainHash, reason });
  const match = (h, p, d) => h === localHash?.toLowerCase() && p === detail.patient && d === detail.doctor;

  if (!v) {
    if (detail.onchainId == null) return out("none", null, "Belum tercatat on-chain.");
    try {
      const c = await chainGetRecord(detail.onchainId, runner);
      return out(match(c.dataHash, c.patient, c.doctor) ? "ok" : "bad", c.dataHash, null);
    } catch (err) {
      const name = revertName(err);
      if (name === "RecordAlreadyDeleted") return out("deleted", null, "Rekam medis sudah dihapus on-chain.");
      if (name === "RecordNotFound") return out("none", null, "Belum tercatat on-chain.");
      throw fail(0, name ?? "CHAIN_UNAVAILABLE", REVERT_TEXT[name] ?? CODE_TEXT.CHAIN_UNAVAILABLE);
    }
  }
  if (v.status !== "confirmed") return out("none", null, `Versi berstatus ${v.status}; belum tercatat on-chain.`);
  if (v.action === "delete") return out("deleted", null, "Versi hapus: rekam medis dihapus on-chain (event tanpa hash).");
  let receipt;
  try { receipt = await (runner.provider ?? runner).getTransactionReceipt(v.tx_hash); } catch { throw fail(0, "CHAIN_UNAVAILABLE", CODE_TEXT.CHAIN_UNAVAILABLE); }
  if (!receipt) return out("none", null, "Transaksi versi ini tidak ditemukan di blockchain (node di-restart?).");
  const name = v.action === "create" ? "RecordAdded" : "RecordUpdated";
  const ev = receipt.logs.filter((l) => l.address.toLowerCase() === CONTRACT_ADDRESS.toLowerCase())
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === name && Number(e.args.id) === Number(detail.onchainId));
  if (!ev) return out("bad", null, `Event ${name} tidak ada di transaksi versi ini.`);
  const h = String(v.action === "create" ? ev.args.dataHash : ev.args.newHash).toLowerCase();
  return out(match(h, ev.args.patient.toLowerCase(), ev.args.doctor.toLowerCase()) ? "ok" : "bad", h, null);
}
/** Verifikasi di browser untuk rekam medis `id` (versi yang berlaku) -> "ok" | "bad" | "deleted" | "none". */
export async function verifyRecord(id, opts) {
  return (await verifyInBrowser(await getRecord(id, { verify: false }), null, opts)).state;
}
async function withIntegrity(r) {
  if (r.status !== "confirmed") return r;
  const v = await http("GET", `/api/records/${r.id}/verify`);
  return { ...r, integrity: v.match ? "ok" : v.chainHash ? "bad" : "none", chainHash: v.chainHash };
}
/**
 * Daftar rekam medis aktif seorang pasien (Doctor ber-akses / Patient miliknya). verify = true:
 * status integritas tiap rekam medis confirmed diperiksa backend terhadap kontrak.
 */
export async function getRecords(patientWallet, { verify = true } = {}) {
  const rows = (await http("GET", `/api/records/patient/${encodeURIComponent(patientWallet)}`)).items.map(toRecord);
  // shortcut: 1 request verifikasi per rekam medis; untuk daftar panjang verifikasi per halaman saja.
  return verify ? Promise.all(rows.map(withIntegrity)) : rows;
}
export const getMyRecords = () => getRecords(me());
/**
 * Detail rekam medis + resep + riwayat versi. version = nomor versi yang data_hash-nya sama dengan
 * record (= versi yang berlaku, dipakai cetakan resep); tx = tx hash versi itu.
 */
export async function getRecord(id, { verify = true } = {}) {
  const d = await http("GET", `/api/records/${id}`);
  const cur = d.versions.find((v) => v.data_hash === d.data_hash && v.status === "confirmed") ?? null;
  const r = { ...toRecord(d), prescriptions: d.prescriptions, versions: d.versions, version: cur?.version_no ?? null, tx: cur?.tx_hash ?? null };
  return verify ? withIntegrity(r) : r;
}

// Kirim tx rekam medis lewat runTx. Di tahap "pending" (tx sudah terkirim, receipt belum ada) txHash
// LANGSUNG dicatat ke draft (POST .../versions/:v/tx), agar draft bisa direkonsiliasi walau confirm
// tidak sempat dipanggil (tab ditutup / koneksi putus).
async function recordTx(buildTx, recordId, versionNo, opts) {
  const o = txOpts(opts);
  let noted = Promise.resolve();
  const r = await runTx(buildTx, { ...o, onStage: (ev) => {
    if (ev.stage === "pending") noted = http("POST", `/api/records/${recordId}/versions/${versionNo}/tx`, { txHash: ev.txHash }).catch(() => {});
    o.onStage?.(ev);
  } });
  await noted; // urutan: catat txHash -> confirm/fail
  return finishRecordTx(r, recordId, versionNo);
}
// Selesaikan tx rekam medis: confirmed -> confirm(txHash); selain itu -> fail (txHash bila sudah terkirim).
async function finishRecordTx(r, recordId, versionNo) {
  const out = { ...r, recordId, versionNo };
  if (r.status === "confirmed") {
    const path = versionNo === 1 ? `/api/records/${recordId}/confirm` : `/api/records/${recordId}/versions/${versionNo}/confirm`;
    // Tx sudah sah on-chain; gagal mencatat -> logError (versi tetap pending + txHash, lihat reconcileRecords).
    try { out.record = await http("POST", path, { txHash: r.txHash }); } catch (err) { out.logError = err; }
    return out;
  }
  await markFailed(recordId, versionNo, r.message, r.txHash).catch((err) => { out.logError = err; });
  return out;
}
/**
 * POST /api/records/reconcile — Doctor: periksa ulang semua draft pending miliknya ke blockchain.
 * -> { items: [{ recordId, versionNo, action, result: "confirmed"|"failed"|"pending", reason }], confirmed, failed, pending }
 */
export const reconcileRecords = () => http("POST", "/api/records/reconcile");
// reason = pesan error sistem (bukan data medis): karakter yang ditolak backend (js/text.js) diganti spasi.
const markFailed = (recordId, versionNo, reason, txHash) =>
  http("POST", `/api/records/${recordId}/fail`, {
    reason: String(reason).toWellFormed().replace(/[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]|(?![\n\t])\p{Cc}/gu, " ").slice(0, 255).toWellFormed(),
    versionNo, ...(txHash ? { txHash } : {}),
  });

/**
 * Doctor membuat (rec = null) atau mengubah rekam medis buatannya (rec = rekam medis dari API):
 *   1. draft ke backend (versi pending) -> { salt, dataHash/newHash }
 *   2. HITUNG ULANG hash dari payload yang dikirim + salt (js/hash.js). Beda -> TIDAK menandatangani:
 *      versi ditandai gagal lalu ApiError HASH_MISMATCH (dokter tidak menandatangani hash yang tidak ia buat).
 *   3. addRecord / updateRecord lewat runTx -> 4. confirm(txHash), atau fail (tanpa txHash jika ditolak MetaMask).
 * Mengembalikan hasil runTx + { recordId, versionNo, record? }.
 */
export async function saveRecord(rec, patientWallet, data, opts) {
  const d = cleanRecord(data);
  const patient = String(rec ? rec.patient : patientWallet).toLowerCase();
  const draft = rec
    ? await http("PUT", `/api/records/${rec.id}`, d)
    : await http("POST", "/api/records", { patient, ...d });
  const hash = rec ? draft.newHash : draft.dataHash;
  let mine = null;
  try { mine = computeDataHash(draft.salt, { patient, doctor: me(), ...d }); } catch { /* salt tidak valid -> dianggap tidak cocok */ }
  // Update: id on-chain & hash lama di draft WAJIB = rekam medis yang sedang diedit, seperti deleteRecord;
  // jika tidak, MetaMask bisa diminta menimpa hash rekam medis LAIN milik dokter ini.
  const sameTarget = !rec || (draft.onchainId === rec.onchainId && draft.oldHash === rec.dataHash);
  if (!mine || mine.toLowerCase() !== String(hash).toLowerCase() || (!rec && draft.patient !== patient) || !sameTarget) {
    await markFailed(draft.recordId, draft.versionNo, "Hash dari server tidak cocok dengan data yang diisi; transaksi tidak dikirim.").catch(() => {});
    throw fail(0, "HASH_MISMATCH", "Hash dari server tidak cocok dengan data yang Anda isi. Transaksi TIDAK dikirim; muat ulang lalu coba lagi.");
  }
  return recordTx((c) => (rec ? c.updateRecord(draft.onchainId, hash) : c.addRecord(patient, hash)), draft.recordId, draft.versionNo, opts);
}
/** Soft delete oleh Doctor pembuatnya: DELETE (versi pending) -> deleteRecord(onchainId) -> confirm / fail. */
export async function deleteRecord(rec, opts) {
  const draft = await http("DELETE", `/api/records/${rec.id}`);
  if (draft.onchainId !== rec.onchainId) {
    await markFailed(draft.recordId, draft.versionNo, "Id on-chain dari server tidak cocok; transaksi tidak dikirim.").catch(() => {});
    throw fail(0, "HASH_MISMATCH", "Data dari server tidak cocok dengan rekam medis yang dipilih. Transaksi TIDAK dikirim.");
  }
  return recordTx((c) => c.deleteRecord(draft.onchainId), draft.recordId, draft.versionNo, opts);
}

/** Statistik tanpa isi rekam medis. Admin: GET /api/stats. Doctor: rekam medis buatannya + tx pending. */
export async function getRecordStats() {
  if (getSession()?.role === "admin") {
    const s = await http("GET", "/api/stats");
    return { appointmentsToday: s.appointmentsToday, total: s.activeRecords, newThisWeek: s.recordsLast7Days };
  }
  const [patients, pending] = await Promise.all([allPages("/api/users"), http("GET", "/api/tx-log?status=pending&pageSize=1")]);
  const recs = (await Promise.all(patients.map((u) => getRecords(u.wallet_address, { verify: false })))).flat();
  return { mine: recs.filter((r) => r.doctor === me()).length, minePending: pending.total };
}

// Resep digital
/** GET /api/prescriptions/me — resep dari rekam medis confirmed milik pasien + status verifikasi. */
export async function getMyPrescriptions() {
  return (await http("GET", "/api/prescriptions/me")).items.map((r) => ({
    id: r.recordId, onchainId: r.onchainId, patient: r.patient_wallet, doctor: r.doctor_wallet,
    patientName: r.patient_name ?? "Tanpa profil", doctorName: r.doctor_name ?? "Tanpa profil",
    diagnosis: r.diagnosis, created_at: r.created_at, updated_at: r.updated_at, prescriptions: r.prescriptions,
    integrity: r.verified ? "ok" : r.chainHash ? "bad" : "none", chainHash: r.chainHash,
  }));
}

// Appointment
export const getAppointmentDoctors = ({ specialization, date } = {}) => http("GET", `/api/appointments/doctors${q({ specialization, date })}`);
// Teks bebas appointment (textarea) dicek dengan aturan backend SEBELUM request & MetaMask (js/text.js).
const APPT_TEXT = { reason: "Alasan", note: "Catatan" };
function checkApptText(body) {
  for (const [k, label] of Object.entries(APPT_TEXT)) {
    const msg = textMessage(label, true);
    if (typeof body[k] === "string" && !isCleanText(body[k], true)) throw fail(400, "INVALID_TEXT", msg, { [k]: msg });
  }
  return body;
}
export const bookAppointment = (body) => http("POST", "/api/appointments", checkApptText(body));
export const getAppointments = async ({ status } = {}) => ({ items: await allPages("/api/appointments", { status }) });
/** Admin: agregat appointment (tanggal × dokter × status × jumlah), tanpa data pasien. */
export const getAppointmentSummary = async () => (await http("GET", "/api/appointments/summary")).items;
/** Admin: batalkan semua appointment aktif dokter yang role-nya SUDAH dicabut -> { cancelled }. */
export const cancelDoctorAppointments = (key) => http("POST", `/api/admin/doctors/${encodeURIComponent(key)}/cancel-appointments`);
/** PATCH /api/appointments/:id/<action> (accept|reject|doctor-reschedule|complete|reschedule|cancel|confirm). */
export const patchAppointment = (id, action, body = {}) => http("PATCH", `/api/appointments/${encodeURIComponent(id)}/${action}`, checkApptText(body));

/**
 * Handshake accessAction (lihat backend/routes/appointments.js): request({}) dulu; aksi none -> sudah tersimpan. grant/extend ->
 * grantDoctorAccess(doctor, expiresAt) lewat runTx -> request({ txHash }) (backend memverifikasi & mencatat tx).
 * Mengembalikan respons tersimpan ({ saved: true, ... }) atau { saved: false, tx } jika tx tidak confirmed.
 * opts.expectedExpiresAt (detik Unix = accessExpiresAt(jadwal) di validation.js, dihitung browser & ditampilkan ke pasien): jika diisi
 * dan expiresAt dari server berbeda, TIDAK ada yang ditandatangani (ApiError ACCESS_MISMATCH).
 * doctor = wallet dokter yang DIPILIH/DITAMPILKAN ke pasien: doctor_wallet di respons handshake (dokter yang akan
 * diverifikasi server) wajib sama, jika tidak TIDAK ada yang ditandatangani (ACCESS_MISMATCH).
 */
export async function saveWithAccess(request, doctor, opts) {
  const res = await request({});
  if (res.saved) return res;
  if (opts?.expectedExpiresAt !== undefined && res.expiresAt !== opts.expectedExpiresAt) {
    throw fail(0, "ACCESS_MISMATCH", "Masa akses dari server berbeda dengan jadwal yang Anda pilih. Transaksi TIDAK dikirim; muat ulang lalu coba lagi.");
  }
  if (String(res.doctor_wallet).toLowerCase() !== String(doctor).toLowerCase()) {
    throw fail(0, "ACCESS_MISMATCH", "Dokter dari server berbeda dengan dokter yang ditampilkan. Transaksi TIDAK dikirim; muat ulang lalu coba lagi.");
  }
  const r = await runTx((c) => c.grantDoctorAccess(doctor, res.expiresAt), txOpts(opts));
  if (r.status !== "confirmed") return { saved: false, accessAction: res.accessAction, tx: r };
  return request({ txHash: r.txHash });
}

// Riwayat aktivitas
// GET /api/activity: event kontrak (transaksi sukses) + tx_log pending/failed, sudah difilter per role
// & diurutkan waktu di SERVER. Baris tx_log tidak punya event -> args disusun dari actor/target.
// Aksi tx_log -> nama event kontrak (dipakai filter & label activity-map.js).
const TX_EVENT = {
  grant_role: "RoleGranted", revoke_role: "RoleRevoked", register_patient: "PatientRegistered",
  add_record: "RecordAdded", update_record: "RecordUpdated", delete_record: "RecordDeleted",
  grant_access: "AccessGranted", extend_access: "AccessExtended", revoke_access: "AccessRevoked", renounce_access: "AccessRevoked",
};
function toActivity(a) {
  const actorName = a.actor === me() ? "Anda" : a.names[a.actor] ?? "Tanpa profil";
  if (a.source === "event") return { ...a, actorName, from: a.actor, gasUsed: null, error: null };
  const renounce = a.action === "renounce_access";
  const args = a.action.endsWith("_access")
    ? (renounce ? { patient: a.target, doctor: a.actor, by: a.actor } : { doctor: a.target })
    : a.target ? { account: a.target } : {};
  return { ...a, event: TX_EVENT[a.action], args, actorName, from: a.actor, to: null, blockNumber: null, gasUsed: null };
}
/** limit diisi -> hanya `limit` aktivitas terbaru (satu request); kosong -> semua halaman. */
export async function getActivity({ limit } = {}) {
  const rows = limit ? (await http("GET", `/api/activity${q({ pageSize: limit })}`)).items : await allPages("/api/activity");
  return rows.map(toActivity);
}
