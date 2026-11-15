// session.js — JWT sesi login (library jose) + cookie.
// JWT hanya membawa identitas (sub = wallet lowercase) dan jti. ROLE TIDAK dimasukkan:
// role selalu dibaca dari kontrak di setiap request. Validitas sesi juga dicek ke tabel
// auth_sessions (middleware/auth.js), jadi logout langsung berlaku.
import { SignJWT, jwtVerify } from "jose";
import config from "../config.js";

export const COOKIE = "biocare_session";
export const SESSION_HOURS = 8;
const ISSUER = "biocare-backend";
const AUDIENCE = "biocare-app";
const KEY = new TextEncoder().encode(config.JWT_SECRET);
const WALLET_LOWER = /^0x[0-9a-f]{40}$/;
const JTI_RE = /^[0-9a-f]{32}$/;

/** Opsi cookie: tidak bisa dibaca JavaScript, tidak dikirim lintas situs, Secure di production. */
export const cookieOptions = () => ({ httpOnly: true, sameSite: "strict", path: "/", secure: !config.isDev });

/** JWT HS256 untuk wallet (lowercase) + jti acak; berlaku SESSION_HOURS jam. */
export function signSession(wallet, jti) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(wallet)
    .setJti(jti)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(KEY);
}

/**
 * Verifikasi JWT: HANYA HS256 (alg "none"/lainnya ditolak), issuer & audience tetap, exp wajib.
 * Mengembalikan { wallet, jti } atau null (token tidak ada/rusak/palsu/kedaluwarsa).
 */
export async function verifySession(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return null;
  try {
    const { payload } = await jwtVerify(token, KEY, {
      algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE, requiredClaims: ["exp", "iat", "jti", "sub"],
    });
    if (!WALLET_LOWER.test(payload.sub) || !JTI_RE.test(payload.jti)) return null;
    return { wallet: payload.sub, jti: payload.jti };
  } catch {
    return null;
  }
}

/** Ambil nilai cookie sesi dari header Cookie (tanpa dependensi cookie-parser). */
export function readCookie(req) {
  for (const part of (req.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}
