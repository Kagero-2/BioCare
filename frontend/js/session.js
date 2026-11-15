// session.js — cermin sesi di sessionStorage: { wallet, role, loginAt }, dipakai menu & tampilan.
// Sesi ASLI = cookie HttpOnly berisi JWT dari backend (api.js: authVerify/authMe mengisi cermin ini),
// yang tidak bisa dibaca JavaScript. Frontend hanya menyembunyikan menu; keamanan ditegakkan kontrak & backend.
import { ROLE_ENUM } from "./chain-format.js";

// Role sesi yang sah = enum kontrak (chain-format.js), termasuk "unregistered".
export const ROLES = ROLE_ENUM;
export const ROLE_LABEL = {
  admin: "Admin", doctor: "Doctor", patient: "Patient", unregistered: "Belum terdaftar",
};

const KEY = "session";
const WALLET_RE = /^0x[0-9a-f]{40}$/;

// sessionStorage bisa melempar error (mis. mode privat/diblokir), jadi dibungkus try/catch.
export function getSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY));
    // nilai rusak / tak dikenal = belum login
    return s && ROLES.includes(s.role) && WALLET_RE.test(s.wallet) ? s : null;
  } catch { return null; }
}

export function setSession({ wallet, role, loginAt = new Date().toISOString() }) {
  if (!ROLES.includes(role) || !WALLET_RE.test(wallet)) return false;
  try { sessionStorage.setItem(KEY, JSON.stringify({ wallet, role, loginAt })); return true; } catch { return false; }
}

export function clearSession() {
  try { sessionStorage.removeItem(KEY); } catch { /* abaikan */ }
}
