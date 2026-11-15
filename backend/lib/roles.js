// roles.js — SATU-SATUNYA pemetaan enum Role kontrak <-> nama role di backend.
// Urutan WAJIB sama dengan contracts/HospitalRecords.sol:
//   enum Role { None, Admin, Doctor, Patient }  ->  0, 1, 2, 3
// (diuji otomatis terhadap source kontrak di scripts/test-roles.js)

/** Index = nilai enum on-chain. "unregistered" = Role.None. */
export const ROLES = Object.freeze(["unregistered", "admin", "doctor", "patient"]);

/** Role yang punya akun (bukan Unregistered). */
export const REGISTERED = Object.freeze(ROLES.slice(1));

/**
 * Nilai enum dari kontrak (BigInt/number) -> nama role.
 * Nilai yang TIDAK dikenal (mis. 4 dari kontrak/ABI versi lain) mengembalikan null,
 * BUKAN role lain: pemanggil wajib menolaknya (fail closed).
 */
export function roleFromEnum(v) {
  const n = typeof v === "bigint" ? v : typeof v === "number" ? BigInt(Number.isInteger(v) ? v : -1) : -1n;
  return n >= 0n && n < BigInt(ROLES.length) ? ROLES[Number(n)] : null;
}

/** Nama role -> nilai enum (number) untuk dicocokkan dengan argumen event. Role tak dikenal -> null. */
export function roleToEnum(role) {
  const i = ROLES.indexOf(role);
  return i === -1 ? null : i;
}
