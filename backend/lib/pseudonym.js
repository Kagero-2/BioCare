// pseudonym.js — penyamaran pasien untuk tampilan Admin.
//   pseudonym(wallet) = "P-" + 8 hex HMAC-SHA256(kunci A, wallet lowercase): dipakai daftar akses, Riwayat
//     Aktivitas, tx-log versi Admin, "Buka identitas" & resolve-wallet.
//   userRef(wallet)   = "U-" + 16 hex HMAC-SHA256(kunci B, wallet lowercase): rujukan profil pasien di
//     daftar pengguna Admin (edit/hapus/detail/cabut role) PENGGANTI wallet.
// Kunci A & B diturunkan dari JWT_SECRET lewat HKDF-SHA256 dengan label berbeda, jadi pseudonim dan ref
// tidak bisa dicocokkan satu sama lain (atau ke wallet) tanpa kunci server -> daftar pengguna (nama + ref)
// tidak bisa di-join dengan daftar akses/aktivitas (pseudonim) di dalam aplikasi.
// Rotasi JWT_SECRET = SEMUA pseudonim & ref berubah (catatan Admin yang menyebut pseudonim lama tidak berlaku lagi).
// Ini minimisasi TAMPILAN, bukan kerahasiaan: wallet pasien tetap publik di event kontrak.
import { createHmac, hkdfSync } from "node:crypto";
import config from "../config.js";

const key = (label) => Buffer.from(hkdfSync("sha256", config.JWT_SECRET, Buffer.alloc(0), label, 32));
const PSEUDONYM_KEY = key("biocare-pseudonym-v1");
const REF_KEY = key("biocare-user-ref-v1");
const mac = (k, wallet) => createHmac("sha256", k).update(String(wallet).toLowerCase()).digest("hex");

/** "0xabc…" -> "P-1a2b3c4d" */
export const pseudonym = (wallet) => `P-${mac(PSEUDONYM_KEY, wallet).slice(0, 8)}`;
/** "0xabc…" -> "U-1a2b3c4d5e6f7a8b" */
export const userRef = (wallet) => `U-${mac(REF_KEY, wallet).slice(0, 16)}`;
export const PSEUDONYM_RE = /^P-[0-9a-f]{8}$/;
export const REF_RE = /^U-[0-9a-f]{16}$/;

/**
 * Wallet ini disamarkan untuk Admin? Ya, kecuali role on-chain SAAT INI Admin/Doctor (dibaca dari kontrak).
 * Fail closed: pasien, wallet tanpa role, mantan dokter, role asing = disamarkan. Kolom staff_type tidak dipakai.
 */
export const hiddenForAdmin = (role) => role !== "admin" && role !== "doctor";
