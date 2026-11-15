// chain.js — SATU-SATUNYA tempat frontend berbicara dengan kontrak HospitalRecords.
//   - baca: getRole, getAccessExpiry, hasAccess, getRecord (lewat MetaMask / provider apa pun)
//   - tulis: runTx(buildTx, { signer, onStage }) — signer DITERIMA sebagai parameter, jadi
//     bisa diuji di Node dengan ethers.Wallet; di browser dipakai browserSigner() (MetaMask).
// Tidak menyentuh DOM. Tampilan progres ada di ui.js (txProgress).
import { BrowserProvider, Contract, Interface } from "../vendor/ethers.min.js";
import { CHAIN_ID, CONTRACT_ADDRESS, CONTRACT_ABI } from "./config.js";
import { roleFromEnum, toNumberId } from "./chain-format.js";

export const iface = new Interface(CONTRACT_ABI);

// Custom error kontrak -> pesan Bahasa Indonesia. Kunci HARUS = semua `error` di HospitalRecords.sol
// (dicek otomatis di scripts/test-e2e-node.mjs terhadap ABI).
export const REVERT_TEXT = {
  NotAdmin: "Hanya Admin yang boleh melakukan aksi ini.",
  NotDoctor: "Wallet ini bukan dokter terdaftar.",
  NotAuthorized: "Anda tidak berhak membaca rekam medis ini.",
  ZeroAddress: "Alamat wallet tidak boleh kosong.",
  InvalidRole: "Admin hanya dapat memberi role Dokter.",
  AlreadyHasRole: "Wallet ini sudah punya role. Cabut role-nya dulu.",
  NoRole: "Wallet ini tidak punya role untuk dicabut.",
  CannotRevokeAdmin: "Role Admin tidak bisa dicabut.",
  NotPatient: "Wallet ini bukan pasien terdaftar.",
  RecordNotFound: "Rekam medis tidak ditemukan di blockchain.",
  RecordAlreadyDeleted: "Rekam medis ini sudah dihapus.",
  NotRecordOwner: "Hanya dokter pembuat yang dapat mengubah atau menghapus rekam medis ini.",
  ZeroHash: "Hash rekam medis kosong.",
  SameHash: "Tidak ada perubahan: hash rekam medis sama dengan sebelumnya.",
  NoAccess: "Akses dokter ke pasien ini tidak aktif (belum diberi atau sudah dicabut).",
  AccessExpired: "Akses dokter ke pasien ini sudah kedaluwarsa.",
  InvalidExpiry: "Masa berlaku akses tidak valid (harus di masa depan, maksimal 60 hari).",
  AccessNotExtended: "Akses yang masih aktif hanya bisa diperpanjang, tidak bisa diperpendek.",
  NotPatientOrAdmin: "Hanya pasien pemilik data atau Admin yang bisa mencabut akses.",
};

// Provider & signer browser (MetaMask)
let browserProvider = null;
/** BrowserProvider dari window.ethereum (satu instance). null jika MetaMask tidak ada. */
export function getBrowserProvider() {
  if (!browserProvider && globalThis.window?.ethereum) browserProvider = new BrowserProvider(window.ethereum);
  return browserProvider;
}
/**
 * Signer MetaMask. Menolak jika network bukan 31337 atau akun aktif MetaMask BUKAN wallet yang
 * login (expected), agar transaksi tidak terkirim atas nama wallet lain.
 */
export async function browserSigner(expected) {
  const p = getBrowserProvider();
  if (!p) throw new Error("MetaMask tidak ditemukan di browser ini.");
  if (Number((await p.getNetwork()).chainId) !== CHAIN_ID) throw new Error(`MetaMask tidak berada di network chainId ${CHAIN_ID}.`);
  const signer = await p.getSigner();
  if (expected && signer.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Akun aktif di MetaMask berbeda dengan akun yang login. Ganti akun MetaMask atau masuk ulang.");
  }
  return signer;
}

/** Instance kontrak untuk runner (provider = baca saja, signer = bisa kirim transaksi). */
export const contractFor = (runner) => new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, runner);

// Fungsi baca
// runner opsional; default MetaMask. getRecord dibatasi kontrak (msg.sender), jadi butuh signer/from.
const reader = (runner) => contractFor(runner ?? getBrowserProvider());
export async function getRole(account, runner) {
  const role = roleFromEnum(await reader(runner).getRole(account));
  if (role === null) throw new Error("Role on-chain tidak dikenali.");
  return role;
}
export const getAccessExpiry = async (patient, doctor, runner) => Number(await reader(runner).getAccessExpiry(patient, doctor));
export const hasAccess = async (patient, doctor, runner) => (await reader(runner).hasAccess(patient, doctor)) === true;
export async function getRecord(id, runner) {
  const r = await reader(runner).getRecord(id);
  return { id: toNumberId(r.id), patient: r.patient.toLowerCase(), doctor: r.doctor.toLowerCase(), dataHash: r.dataHash.toLowerCase(),
    createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt), isDeleted: r.isDeleted };
}

// Kirim transaksi
// Penolakan di MetaMask: ethers -> "ACTION_REJECTED"; EIP-1193 -> 4001 (kadang terbungkus di info.error).
export const isRejected = (err) => err?.code === "ACTION_REJECTED" || err?.code === 4001 || err?.info?.error?.code === 4001 || err?.error?.code === 4001;
/** Nama custom error kontrak dari error ethers/MetaMask, atau null. */
export function revertName(err) {
  if (err?.revert?.name) return err.revert.name;
  for (const data of [err?.data, err?.info?.error?.data, err?.info?.error?.data?.data, err?.error?.data, err?.error?.data?.data]) {
    if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) continue;
    try { const e = iface.parseError(data); if (e) return e.name; } catch { /* bukan error kontrak ini */ }
  }
  return null;
}

/**
 * Kirim satu transaksi kontrak dan laporkan tahapnya lewat onStage({ stage, txHash? }):
 *   awaiting_signature -> pending(txHash) -> confirmed | rejected | reverted | failed
 * buildTx(contract) -> Promise<TransactionResponse>, mis. (c) => c.renounceAccess(patient).
 * TIDAK melempar. Mengembalikan:
 *   { status: "confirmed", txHash, receipt }
 *   { status: "rejected", txHash: null, message }            — ditolak di MetaMask (pilihan sah, bukan error)
 *   { status: "reverted", txHash | null, error, message }    — custom error kontrak (null = ditolak sebelum dikirim)
 *   { status: "failed", txHash | null, message }             — jaringan, network salah, dll.
 * signer wajib ada (Signer atau Promise<Signer>; browser: browserSigner(wallet sesi); Node: ethers.Wallet).
 */
export async function runTx(buildTx, { signer, onStage = () => {} } = {}) {
  let txHash = null;
  const end = (r) => { onStage({ stage: r.status, ...r }); return r; };
  try {
    signer = await signer; // boleh Promise (mis. browserSigner()) agar kegagalannya ikut dilaporkan sebagai "failed"
    if (!signer) throw new Error("Signer tidak tersedia.");
    onStage({ stage: "awaiting_signature" });
    const tx = await buildTx(contractFor(signer));
    txHash = tx.hash.toLowerCase();
    onStage({ stage: "pending", txHash });
    const receipt = await tx.wait();
    if (receipt?.status !== 1) throw Object.assign(new Error("transaction execution reverted"), { code: "CALL_EXCEPTION", receipt });
    return end({ status: "confirmed", txHash, receipt });
  } catch (err) {
    if (isRejected(err)) return end({ status: "rejected", txHash: null, message: "Transaksi ditolak di MetaMask." });
    const name = revertName(err);
    if (name || err?.code === "CALL_EXCEPTION") {
      return end({ status: "reverted", txHash: txHash ?? err?.receipt?.hash?.toLowerCase() ?? null, error: name,
        message: REVERT_TEXT[name] ?? "Transaksi dibatalkan kontrak (revert). Tidak ada perubahan on-chain." });
    }
    return end({ status: "failed", txHash, message: err?.message && !err.code ? err.message : "Transaksi tidak bisa dikirim. Periksa MetaMask dan network, lalu coba lagi." });
  }
}
