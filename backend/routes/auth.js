// routes/auth.js — login dengan tanda tangan wallet (Sign-In with Ethereum, EIP-4361) + sesi JWT.
//   1. POST /nonce  {address}            -> server menyusun pesan SIWE lengkap (nonce acak 256 bit),
//                                           menyimpan keccak256(pesan) di auth_nonces, mengembalikan {message}.
//   2. Wallet menandatangani pesan itu APA ADANYA (personal_sign, tanpa gas).
//   3. POST /verify {message, signature} -> nonce dihanguskan atomik, pesan harus identik byte-per-byte
//                                           (hash sama), penanda tangan = alamat nonce, role dibaca dari
//                                           kontrak, lalu cookie sesi (JWT) diberikan.
// Server tidak mem-parsing SIWE: pesan dibuat server sendiri, jadi cukup dibandingkan hash-nya.
import { Router } from "express";
import { randomBytes } from "node:crypto";
import { getAddress, id as keccakUtf8, verifyMessage } from "ethers";
import config from "../config.js";
import { pool } from "../db.js";
import { getRole } from "../chain.js";
import { ApiError, badRequest } from "../lib/errors.js";
import { isWallet } from "../lib/validate.js";
import { COOKIE, SESSION_HOURS, cookieOptions, signSession, verifySession, readCookie } from "../lib/session.js";
import { requireAuth, rateLimit } from "../middleware/auth.js";

const router = Router();

const NONCE_MINUTES = 5;
const DOMAIN = new URL(config.APP_ORIGIN).host; // mis. "127.0.0.1:3000" — harus sama dengan host halaman di browser
const STATEMENT = "Masuk ke BioCare. Tanda tangan ini hanya membuktikan Anda pemilik wallet; tidak mengirim transaksi dan tanpa biaya gas.";
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const NONCE_LINE = /^Nonce: ([0-9a-f]{64})$/m;

// Satu jenis error untuk SEMUA kegagalan verifikasi: client tidak diberi tahu bagian mana yang salah.
const loginFailed = () => new ApiError(401, "LOGIN_FAILED", "Login gagal atau pesan sudah kedaluwarsa. Minta pesan baru lalu tanda tangani lagi.");

/** Pesan EIP-4361. Address WAJIB format checksum (EIP-55); waktu ISO 8601 UTC. */
function siweMessage(address, nonce, issuedAt, expiresAt) {
  return [
    `${DOMAIN} wants you to sign in with your Ethereum account:`,
    address,
    "",
    STATEMENT,
    "",
    `URI: ${config.APP_ORIGIN}`,
    "Version: 1",
    `Chain ID: ${config.CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join("\n");
}

// Rate limit per IP, terpisah untuk tiap endpoint (lihat middleware/auth.js).
const nonceLimit = rateLimit({ limit: 10, windowMs: 60_000 });
const verifyLimit = rateLimit({ limit: 10, windowMs: 60_000 });

// POST /api/auth/nonce {address}
router.post("/nonce", nonceLimit, async (req, res) => {
  const address = req.body?.address;
  let checksum;
  try {
    if (!isWallet(address)) throw new Error();
    checksum = getAddress(address.toLowerCase()); // toLowerCase: terima input huruf campur tanpa checksum yang salah
  } catch {
    throw badRequest("Alamat wallet tidak valid.", { address: "Harus 0x diikuti 40 karakter heksadesimal." });
  }
  const nonce = randomBytes(32).toString("hex"); // 256 bit dari CSPRNG
  const now = Date.now();
  const message = siweMessage(checksum, nonce, new Date(now).toISOString(), new Date(now + NONCE_MINUTES * 60_000).toISOString());
  // Bersihkan nonce lama (> 1 hari) supaya tabel tidak tumbuh terus.
  await pool.execute("DELETE FROM auth_nonces WHERE expires_at < NOW() - INTERVAL 1 DAY");
  await pool.execute(
    "INSERT INTO auth_nonces (wallet_address, nonce, message_hash, expires_at) VALUES (?, ?, ?, NOW() + INTERVAL ? MINUTE)",
    [checksum.toLowerCase(), nonce, keccakUtf8(message), NONCE_MINUTES],
  );
  res.json({ message });
});

// POST /api/auth/verify {message, signature}
router.post("/verify", verifyLimit, async (req, res) => {
  const { message, signature } = req.body ?? {};
  if (typeof message !== "string" || message.length > 1000 || typeof signature !== "string" || !SIG_RE.test(signature)) {
    throw badRequest("Data tidak valid.", { ...(typeof message === "string" && message.length <= 1000 ? {} : { message: "Pesan tidak valid." }),
      ...(typeof signature === "string" && SIG_RE.test(signature) ? {} : { signature: "Tanda tangan tidak valid." }) });
  }
  const nonce = NONCE_LINE.exec(message)?.[1];
  if (!nonce) throw loginFailed();

  // 1. Hanguskan nonce SECARA ATOMIK sebelum memeriksa apa pun: hanya SATU request yang bisa mengubah
  //    used_at dari NULL. Satu nonce = satu percobaan (berhasil atau gagal) -> replay & tebak ulang mustahil.
  const [upd] = await pool.execute(
    "UPDATE auth_nonces SET used_at = NOW() WHERE nonce = ? AND used_at IS NULL AND expires_at > NOW()",
    [nonce],
  );
  if (upd.affectedRows !== 1) throw loginFailed();
  const [[row]] = await pool.execute("SELECT wallet_address, message_hash FROM auth_nonces WHERE nonce = ?", [nonce]);

  // 2. Pesan identik byte-per-byte dengan yang disusun server (domain, chainId, alamat, waktu tidak diubah).
  if (keccakUtf8(message) !== row.message_hash) throw loginFailed();

  // 3. Penanda tangan = alamat pemilik nonce.
  let signer;
  try {
    signer = verifyMessage(message, signature).toLowerCase();
  } catch {
    throw loginFailed();
  }
  if (signer !== row.wallet_address) throw loginFailed();

  // 4. Role dari KONTRAK. Wallet tanpa role tidak mendapat sesi; frontend menawarkan registrasi pasien.
  //    (Role tidak masuk JWT; tetap dibaca ulang dari kontrak di setiap request.)
  const role = await getRole(signer);
  if (role === "unregistered") {
    throw new ApiError(403, "NO_ROLE", "Wallet ini belum terdaftar. Daftar sebagai pasien, atau hubungi Admin jika Anda dokter.");
  }

  // 5. Sesi: baris auth_sessions (bisa dicabut) + JWT di cookie HttpOnly.
  const jti = randomBytes(16).toString("hex");
  await pool.execute("DELETE FROM auth_sessions WHERE expires_at < NOW() - INTERVAL 1 DAY");
  await pool.execute(
    "INSERT INTO auth_sessions (jti, wallet_address, expires_at) VALUES (?, ?, NOW() + INTERVAL ? HOUR)",
    [jti, signer, SESSION_HOURS],
  );
  res.cookie(COOKIE, await signSession(signer, jti), { ...cookieOptions(), maxAge: SESSION_HOURS * 3600_000 });
  res.json({ address: signer, role });
});

// POST /api/auth/logout — cabut sesi (jika ada) + hapus cookie. Selalu 204, juga jika belum login.
router.post("/logout", async (req, res) => {
  const s = await verifySession(readCookie(req));
  if (s) await pool.execute("UPDATE auth_sessions SET revoked_at = NOW() WHERE jti = ? AND revoked_at IS NULL", [s.jti]);
  res.clearCookie(COOKIE, cookieOptions());
  res.status(204).end();
});

// GET /api/auth/me — identitas sesi + role SAAT INI dari kontrak + sudah punya profil atau belum.
router.get("/me", requireAuth, async (req, res) => {
  const role = await getRole(req.wallet);
  const [rows] = await pool.execute("SELECT 1 FROM users WHERE wallet_address = ?", [req.wallet]);
  res.json({ address: req.wallet, role, hasProfile: rows.length > 0 });
});

export default router;
