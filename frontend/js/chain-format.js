// chain-format.js — SATU tempat konversi nilai dari kontrak (ethers v6).
// ethers mengembalikan uint sebagai BigInt dan alamat dalam format checksum.
import { getAddress, isAddress } from "../vendor/ethers.min.js";

// SATU-SATUNYA pemetaan enum Role di frontend. Urutan = enum Role di HospitalRecords.sol:
//   { None, Admin, Doctor, Patient } -> 0, 1, 2, 3
// Harus identik dengan backend/lib/roles.js (diuji di scripts/test-roles.js).
export const ROLE_ENUM = Object.freeze(["unregistered", "admin", "doctor", "patient"]);

/**
 * Angka enum (BigInt/number) -> nama role aplikasi.
 * Nilai di luar 0..3 -> null (BUKAN role lain); pemanggil harus menolaknya.
 */
export function roleFromEnum(v) {
  const n = typeof v === "bigint" ? v : typeof v === "number" && Number.isInteger(v) ? BigInt(v) : -1n;
  return n >= 0n && n < BigInt(ROLE_ENUM.length) ? ROLE_ENUM[Number(n)] : null;
}

/** Nama role aplikasi -> angka enum (BigInt) untuk argumen kontrak. */
export function roleToEnum(role) {
  const i = ROLE_ENUM.indexOf(role);
  if (i === -1) throw new Error(`Role tidak dikenal: ${role}`);
  return BigInt(i);
}

/** Alamat -> lowercase, untuk PERBANDINGAN & kunci database. Melempar error jika bukan alamat. */
export function normalizeAddress(addr) {
  if (!isAddress(addr)) throw new Error(`Alamat tidak valid: ${addr}`);
  return addr.toLowerCase();
}

/** Alamat -> format checksum EIP-55, untuk TAMPILAN (sama seperti keluaran ethers). */
export const checksumAddress = (addr) => getAddress(normalizeAddress(addr));

/** uint256 dari kontrak (BigInt) -> number biasa; tolak nilai di luar batas aman JS. */
export function toNumberId(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Id tidak valid: ${v}`);
  return n;
}
