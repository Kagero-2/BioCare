// text.js — aturan karakter teks bebas (FRONTEND). HARUS identik dengan backend/lib/text.js
// (diuji scripts/test-parity.js). Dicek SEBELUM hash dihitung atau MetaMask dibuka; backend tetap penentu.
//   - String wajib well-formed (tanpa lone surrogate).
//   - Tanpa karakter tak terlihat: \p{Cf} (bidi control, zero-width, soft hyphen, BOM), U+2028/U+2029,
//     \p{Default_Ignorable_Code_Point} (Hangul filler, CGJ, variation selector termasuk emoji ❤️), braille kosong U+2800.
//   - Tanpa karakter kontrol \p{Cc}; field multi-baris (textarea) boleh \n dan \t; \r selalu ditolak.
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]/u;
const CONTROL = /\p{Cc}/u;
const CONTROL_MULTILINE = /(?![\n\t])\p{Cc}/u;

/** true jika teks boleh disimpan. multiline = field textarea (boleh \n dan \t). */
export const isCleanText = (s, multiline = false) =>
  typeof s === "string" && s.isWellFormed() && !INVISIBLE.test(s) && !(multiline ? CONTROL_MULTILINE : CONTROL).test(s);

/** Pesan error (bahasa Indonesia) untuk field `label`. */
export const textMessage = (label, multiline = false) =>
  `${label} berisi karakter tersembunyi atau karakter kontrol yang tidak diizinkan (mis. pembalik arah teks, spasi lebar-nol, huruf kosong, pemilih variasi emoji${multiline ? "" : ", atau baris baru"}).`;
