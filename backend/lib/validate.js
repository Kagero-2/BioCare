// validate.js — validator manual. Setiap fungsi validasi body mengembalikan
// { value, errors }: value = HANYA field yang dikenal (sudah di-trim),
// errors = { field: "pesan" }. Field lain di body diabaikan (cegah mass assignment).
// Aturan sama dengan frontend/js/validation.js & CHECK di database/schema.sql.
import { badRequest, invalidText } from "./errors.js";
import { isCleanText, textMessage } from "./text.js";

export const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
export const PHONE_RE = /^(\+62|0)8\d{7,12}$/;
export const GENDERS = ["L", "P"];

export const isWallet = (v) => typeof v === "string" && WALLET_RE.test(v);
export const isHash = (v) => typeof v === "string" && HASH_RE.test(v);

/** Wallet -> lowercase, atau lempar 400. Dipakai untuk SEMUA wallet sebelum query. */
export function walletParam(v, field = "wallet") {
  if (!isWallet(v)) throw badRequest("Alamat wallet tidak valid.", { [field]: "Harus 0x diikuti 40 karakter heksadesimal." });
  return v.toLowerCase();
}
/** tx hash -> lowercase, atau lempar 400. */
export function hashParam(v, field = "txHash") {
  if (!isHash(v)) throw badRequest("Hash tidak valid.", { [field]: "Harus 0x diikuti 64 karakter heksadesimal." });
  return v.toLowerCase();
}
/**
 * Waktu unix (detik) positif yang muat di uint64 kontrak, mis. expiresAt. Number atau string
 * digit. Mengembalikan BigInt (dicocokkan dengan argumen event), atau lempar 400.
 */
export function unixParam(v, field) {
  const ok = (typeof v === "number" && Number.isSafeInteger(v) && v > 0) || (typeof v === "string" && /^[1-9]\d{0,19}$/.test(v));
  if (!ok || BigInt(v) > 2n ** 64n - 1n) throw badRequest("Data tidak valid.", { [field]: "Harus waktu unix (detik), bilangan bulat positif." });
  return BigInt(v);
}
/** Id bilangan bulat positif dari URL, atau lempar 400. */
export function idParam(v, field = "id") {
  if (typeof v !== "string" || !/^[1-9]\d{0,15}$/.test(v)) throw badRequest("Id tidak valid.", { [field]: "Harus bilangan bulat positif." });
  return Number(v);
}

// String: harus bertipe string; dinormalisasi SEKALI di sini (trim + Unicode NFC) sebelum
// disimpan, sehingga hash rekam medis dihitung dari nilai yang tersimpan, bukan body mentah.
// Panjang dihitung per code point = CHAR_LENGTH di MySQL (batas sama dengan CHECK di schema.sql).
// Karakter dicek pada nilai MENTAH (lib/text.js): melanggar -> langsung 400 INVALID_TEXT (field = at.key).
// multiline = field textarea (boleh LF dan TAB). Mengembalikan nilai bersih ("" jika kosong); error lain ke errors[key].
function str(d, errors, key, { min = 0, max, label, multiline = false, at }) {
  const raw = d?.[key];
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    errors[key] = `${label} harus berupa teks.`;
    return "";
  }
  if (typeof raw === "string" && !isCleanText(raw, multiline)) throw invalidText(at ? `${at}.${key}` : key, textMessage(label, multiline));
  const v = (raw ?? "").trim().normalize("NFC");
  const len = [...v].length;
  if (len < min || len > max) errors[key] = min ? `${label} wajib ${min}–${max} karakter.` : `${label} maksimal ${max} karakter.`;
  return v;
}
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function isValidDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; // tolak 2024-02-31
}

/** Profil pengguna. needSpecialization = true untuk Doctor; selain itu specialization = null. */
export function validateProfile(d, { needSpecialization }) {
  const errors = {};
  const value = {
    full_name: str(d, errors, "full_name", { min: 3, max: 100, label: "Nama lengkap" }),
    phone: str(d, errors, "phone", { min: 1, max: 16, label: "Telepon" }),
    birth_date: str(d, errors, "birth_date", { min: 1, max: 10, label: "Tanggal lahir" }),
    gender: str(d, errors, "gender", { min: 1, max: 1, label: "Jenis kelamin" }),
    address: str(d, errors, "address", { min: 5, max: 255, label: "Alamat", multiline: true }),
    specialization: needSpecialization ? str(d, errors, "specialization", { min: 3, max: 100, label: "Spesialisasi" }) : null,
  };
  if (!errors.phone && !PHONE_RE.test(value.phone)) errors.phone = "Format nomor: 08xxxxxxxxx atau +628xxxxxxxxx.";
  if (!errors.birth_date) {
    const today = todayWib();
    if (!isValidDate(value.birth_date) || value.birth_date < "1900-01-01" || value.birth_date > today) errors.birth_date = "Tanggal lahir tidak valid.";
  }
  if (!errors.gender && !GENDERS.includes(value.gender)) errors.gender = "Jenis kelamin harus L atau P.";
  return { value, errors };
}

/** Isi rekam medis. */
export function validateRecord(d) {
  const errors = {};
  const value = {
    diagnosis: str(d, errors, "diagnosis", { min: 3, max: 200, label: "Diagnosis" }),
    treatment: str(d, errors, "treatment", { min: 3, max: 500, label: "Tindakan", multiline: true }),
    notes: str(d, errors, "notes", { max: 1000, label: "Catatan", multiline: true }),
  };
  return { value, errors };
}

// Resep digital
// Batas SAMA dengan CHECK di database/schema.sql (prescription_items / prescription_ingredients).
export const RX_MAX_ITEMS = 20;
export const RX_TYPES = ["single", "compound"];
const RX_MIN_INGR = 2;
const RX_MAX_INGR = 10;
const RX_MAX_QTY = 9999;
// [kunci, min, max, label] — min 0 = opsional: kosong disimpan & di-hash sebagai null.
// label = label field di form frontend (records-view.js / api.js RX_ITEM), agar pesan error konsisten.
const ITEM_FIELDS = [
  ["name", 2, 100, "Nama obat"], ["strength", 0, 50, "Kekuatan"], ["form", 1, 50, "Bentuk sediaan"],
  ["unit", 1, 20, "Satuan"], ["signa", 1, 100, "Aturan pakai"], ["duration", 1, 50, "Durasi"],
  ["instructions", 0, 255, "Instruksi"],
];
const INGREDIENT_FIELDS = [["name", 2, 100, "Nama bahan"], ["strength", 1, 50, "Kekuatan bahan"], ["amount", 1, 50, "Jumlah per sediaan"]];

/** Field teks sebuah objek menurut daftar aturan; error ditulis dengan awalan `at`. */
function textFields(obj, fields, errors, at) {
  const e = {};
  const v = {};
  for (const [k, min, max, label] of fields) {
    const s = str(obj, e, k, { min, max, label, at });
    v[k] = min === 0 && s === "" ? null : s;
  }
  for (const [k, msg] of Object.entries(e)) errors[`${at}.${k}`] = msg;
  return v;
}

/**
 * Item resep (0–20). Bentuk tiap item (urutan key = JSON kanonik di lib/hash.js):
 *   { type: "single"|"compound", name, strength|null, form, quantity (bilangan bulat 1–9999),
 *     unit, signa, duration, instructions|null, ingredients: [{ name, strength, amount }] }
 * single: ingredients wajib kosong ([] / tidak dikirim). compound: 2–10 bahan.
 * Error berkunci "prescriptions.<i>.<field>" dan "prescriptions.<i>.ingredients.<j>.<field>".
 */
export function validatePrescriptions(list) {
  const errors = {};
  if (list === undefined || list === null) return { value: [], errors };
  if (!Array.isArray(list)) return { value: [], errors: { prescriptions: "Resep harus berupa daftar." } };
  if (list.length > RX_MAX_ITEMS) return { value: [], errors: { prescriptions: `Maksimal ${RX_MAX_ITEMS} item per resep.` } };
  const value = list.map((item, i) => {
    const at = `prescriptions.${i}`;
    if (!isObject(item)) {
      errors[at] = "Item resep tidak valid.";
      return null;
    }
    const type = RX_TYPES.includes(item.type) ? item.type : null;
    if (!type) errors[`${at}.type`] = "Jenis harus single (satuan) atau compound (racikan).";
    const t = textFields(item, ITEM_FIELDS, errors, at);
    const quantity = item.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > RX_MAX_QTY) errors[`${at}.quantity`] = `Jumlah harus bilangan bulat 1–${RX_MAX_QTY}.`;

    const raw = item.ingredients ?? [];
    let ingredients = [];
    if (!Array.isArray(raw)) errors[`${at}.ingredients`] = "Bahan racikan harus berupa daftar.";
    else if (type === "single" && raw.length) errors[`${at}.ingredients`] = "Obat satuan tidak boleh punya bahan racikan.";
    else if (type === "compound" && (raw.length < RX_MIN_INGR || raw.length > RX_MAX_INGR)) errors[`${at}.ingredients`] = `Racikan wajib ${RX_MIN_INGR}–${RX_MAX_INGR} bahan.`;
    else {
      ingredients = raw.map((g, j) => {
        if (isObject(g)) return textFields(g, INGREDIENT_FIELDS, errors, `${at}.ingredients.${j}`);
        errors[`${at}.ingredients.${j}`] = "Bahan racikan tidak valid.";
        return null;
      });
    }
    return {
      type, name: t.name, strength: t.strength, form: t.form, quantity, unit: t.unit,
      signa: t.signa, duration: t.duration, instructions: t.instructions, ingredients,
    };
  });
  return { value, errors };
}

/** Isi rekam medis + resep. */
export function validateRecordWithPrescriptions(d) {
  const r = validateRecord(d);
  const p = validatePrescriptions(d?.prescriptions);
  return { value: { ...r.value, prescriptions: p.value }, errors: { ...r.errors, ...p.errors } };
}

// Waktu appointment: WIB (Asia/Jakarta = UTC+7, tanpa DST)
// Dihitung eksplisit dari epoch, TIDAK bergantung pada zona waktu proses Node.
// Sama dengan time_zone '+07:00' di koneksi MySQL (db.js), jadi DATETIME yang disimpan = WIB.
const WIB_OFFSET_MS = 7 * 3600 * 1000;
export const HOUR_MS = 3600 * 1000;
const pad = (n) => String(n).padStart(2, "0");
/** "YYYY-MM-DD HH:MM[:SS]" (WIB) -> epoch ms. */
export function wibToMs(s) {
  const [y, mo, d, h, mi, se = 0] = s.split(/[- :T]/).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, se) - WIB_OFFSET_MS;
}
/** epoch ms -> "YYYY-MM-DD HH:MM:SS" (WIB). */
export const msToWib = (ms) => new Date(ms + WIB_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
/** Tanggal hari ini menurut jam server WIB, "YYYY-MM-DD". */
export const todayWib = (nowMs = Date.now()) => msToWib(nowMs).slice(0, 10);
/**
 * Masa akses dokter untuk jadwal WIB "YYYY-MM-DD HH:MM[:SS]" (detik Unix):
 * 00:00 WIB pertama SETELAH (jadwal + 24 jam), atau tepat (jadwal + 24 jam) bila sudah 00:00.
 * Semua appointment di tanggal yang sama -> expiresAt sama, jadi jam appointment tidak bisa
 * dibaca dari kontrak (masa akses ±24–48 jam). HARUS identik dengan frontend/js/validation.js.
 */
export function accessExpiresAt(slotWib) {
  const [y, mo, d, h, mi, se = 0] = slotWib.split(/[- :T]/).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, se) / 1000 + 86400; // jam dinding WIB (jadwal + 24 jam) sebagai detik
  return Math.ceil(wall / 86400) * 86400 - 7 * 3600;              // bulatkan ke 00:00 WIB, lalu ke detik Unix
}
/**
 * Booking/reschedule paling jauh hari ini + 57 hari (WIB). Kontrak: expiresAt <= waktu blok + 60 hari.
 * Jadwal hari ke-57 -> expiresAt = 00:00 WIB hari ke-59, jadi ada sisa >= 24 jam terhadap batas kontrak
 * walau blok terakhir node sudah lama (backend menilai dengan timestamp blok "latest").
 */
export const BOOKING_HORIZON_DAYS = 57;

/** Slot praktik 08:00–16:00 tiap 30 menit: "08:00" … "15:30" (16 slot). */
export const SLOT_TIMES = Array.from({ length: 16 }, (_, i) => `${pad(8 + Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`);

/** Tanggal "YYYY-MM-DD" yang benar-benar ada (tolak 2024-02-31), atau null. */
export function dateParam(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !isValidDate(v)) return null;
  return v;
}

/**
 * Waktu appointment "YYYY-MM-DDTHH:MM" (atau dengan spasi / ":00"), dalam WIB.
 * Wajib: tanggal valid, slot 30 menit (menit 00/30), mulai 08:00–15:30, dan di masa depan
 * menurut jam server. Mengembalikan { value: "YYYY-MM-DD HH:MM:00", ms } atau { error }.
 */
export function parseSlot(v, nowMs = Date.now()) {
  const m = typeof v === "string" && /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::00)?$/.exec(v);
  if (!m) return { error: "Format waktu: YYYY-MM-DDTHH:MM (WIB)." };
  const [, date, hh, mm] = m;
  if (!dateParam(date) || Number(hh) > 23 || Number(mm) > 59) return { error: "Tanggal/jam tidak valid." };
  if (mm !== "00" && mm !== "30") return { error: "Slot harus kelipatan 30 menit (menit 00 atau 30)." };
  if (!SLOT_TIMES.includes(`${hh}:${mm}`)) return { error: "Jam praktik 08:00–16:00 WIB (slot terakhir 15:30)." };
  const value = `${date} ${hh}:${mm}:00`;
  const ms = wibToMs(value);
  if (ms <= nowMs) return { error: "Waktu harus di masa depan." };
  if (date > todayWib(nowMs + BOOKING_HORIZON_DAYS * 24 * HOUR_MS)) return { error: `Jadwal paling jauh ${BOOKING_HORIZON_DAYS} hari ke depan.` };
  return { value, ms };
}

/** Body booking appointment: { doctor_wallet, scheduled_at, reason }. */
export function validateAppointment(d) {
  const errors = {};
  const doctor = d?.doctor_wallet;
  if (!isWallet(doctor)) errors.doctor_wallet = "Pilih dokter yang valid.";
  const slot = parseSlot(d?.scheduled_at);
  if (slot.error) errors.scheduled_at = slot.error;
  const reason = str(d, errors, "reason", { min: 3, max: 500, label: "Alasan kunjungan", multiline: true });
  return { value: { doctor_wallet: isWallet(doctor) ? doctor.toLowerCase() : null, scheduled_at: slot.value, reason }, errors };
}

/**
 * Body reschedule: { scheduled_at } (pasien) atau { scheduled_at, reason } (dokter;
 * alasan WAJIB minimal 10 karakter setelah trim, maks 500).
 */
export function validateReschedule(d, { needReason }) {
  const errors = {};
  const slot = parseSlot(d?.scheduled_at);
  if (slot.error) errors.scheduled_at = slot.error;
  const reason = needReason ? str(d, errors, "reason", { min: 10, max: 500, label: "Alasan perubahan jadwal", multiline: true }) : null;
  return { value: { scheduled_at: slot.value, reason }, errors };
}


/** Catatan dokter opsional (maks 500); kosong -> null. */
export function noteParam(d) {
  const errors = {};
  const note = str(d, errors, "note", { max: 500, label: "Catatan", multiline: true });
  if (errors.note) throw badRequest("Data tidak valid.", errors);
  return note || null;
}

/** Alasan Admin membuka identitas pasien: wajib, 10–200 karakter, satu baris. */
export function validateRevealReason(d) {
  const errors = {};
  const reason = str(d, errors, "reason", { min: 10, max: 200, label: "Alasan" });
  return { value: reason, errors };
}

/** Lempar 400 jika ada error validasi. */
export function assertValid({ value, errors }) {
  if (Object.keys(errors).length) throw badRequest("Data tidak valid.", errors);
  return value;
}

/** Pagination dari query string: page >= 1, pageSize 1–100. */
export function pagination(q) {
  const page = /^\d{1,6}$/.test(q.page ?? "") ? Math.max(1, Number(q.page)) : 1;
  const pageSize = /^\d{1,3}$/.test(q.pageSize ?? "") ? Math.min(100, Math.max(1, Number(q.pageSize))) : 20;
  return { page, pageSize };
}

/** Nilai enum opsional dari query string; nilai lain -> 400. */
export function enumParam(v, allowed, field) {
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string" || !allowed.includes(v)) throw badRequest("Filter tidak valid.", { [field]: `Pilihan: ${allowed.join(", ")}.` });
  return v;
}

/** Teks pencarian/filter opsional (maks 100 karakter, aturan karakter yang sama dengan teks tersimpan). */
export function searchParam(v, field = "search") {
  if (v === undefined) return "";
  if (typeof v !== "string" || v.length > 100) throw badRequest("Pencarian tidak valid.", { [field]: "Maksimal 100 karakter." });
  if (!isCleanText(v)) throw invalidText(field, textMessage("Pencarian"));
  return v.trim();
}
