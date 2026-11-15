// text.js — aturan karakter untuk SEMUA teks bebas yang disimpan ke MySQL atau masuk JSON kanonik hash.
// HARUS identik dengan frontend/js/text.js (diuji scripts/test-parity.js).
//   - String wajib well-formed (tanpa lone surrogate). MySQL menyimpan surrogate tunggal sebagai U+FFFD,
//     sehingga hash yang ditandatangani != hash dari data tersimpan.
//   - Tanpa karakter tak terlihat (INVISIBLE): format \p{Cf} (bidi control U+202A–202E/U+2066–2069, zero-width
//     U+200B–200D, soft hyphen U+00AD, BOM U+FEFF), pemisah baris/paragraf Unicode \p{Zl} \p{Zp} (U+2028/U+2029),
//     \p{Default_Ignorable_Code_Point} (Hangul filler U+115F/U+1160/U+3164/U+FFA0, CGJ U+034F, variation selector
//     — termasuk emoji dengan VS16 seperti ❤️), dan braille kosong U+2800. Teks bisa tampil berbeda dari isinya.
//   - Tanpa karakter kontrol \p{Cc}. Field multi-baris (textarea) boleh \n dan \t; \r SELALU ditolak
//     (textarea browser mengirim baris baru sebagai \n). Data TIDAK dinormalisasi diam-diam: hash
//     bergantung pada byte persis, jadi teks yang melanggar ditolak, bukan diubah.
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]/u;
const CONTROL = /\p{Cc}/u;
const CONTROL_MULTILINE = /(?![\n\t])\p{Cc}/u;

/** true jika teks boleh disimpan. multiline = field textarea (boleh \n dan \t). */
export const isCleanText = (s, multiline = false) =>
  typeof s === "string" && s.isWellFormed() && !INVISIBLE.test(s) && !(multiline ? CONTROL_MULTILINE : CONTROL).test(s);

/** Pesan error (bahasa Indonesia) untuk field `label`. */
export const textMessage = (label, multiline = false) =>
  `${label} berisi karakter tersembunyi atau karakter kontrol yang tidak diizinkan (mis. pembalik arah teks, spasi lebar-nol, huruf kosong, pemilih variasi emoji${multiline ? "" : ", atau baris baru"}).`;
