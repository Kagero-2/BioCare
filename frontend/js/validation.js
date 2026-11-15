// validation.js — validasi input profil di frontend (cermin aturan backend).
// Validasi ini hanya untuk kenyamanan pengguna; backend WAJIB memvalidasi ulang.
import { isCleanText, textMessage } from "./text.js";

export const PHONE_RE = /^(\+62|0)8\d{7,12}$/;

// [field, label, multiline] — aturan karakter (js/text.js) sama dengan backend; alamat = textarea.
const PROFILE_TEXT = [["full_name", "Nama lengkap"], ["phone", "Telepon"], ["address", "Alamat", true], ["specialization", "Spesialisasi"]];

// d = objek string hasil formData(). Mengembalikan { namaField: "pesan" }.
export function validateProfile(d, needSpecialization = false) {
  const e = {};
  if (d.full_name.length < 3 || d.full_name.length > 100) e.full_name = "Nama lengkap wajib 3–100 karakter.";
  if (!PHONE_RE.test(d.phone)) e.phone = "Format nomor: 08xxxxxxxxx atau +628xxxxxxxxx.";
  const birth = new Date(d.birth_date);
  if (!d.birth_date || Number.isNaN(birth.getTime()) || birth > new Date() || birth.getFullYear() < 1900) e.birth_date = "Tanggal lahir tidak valid.";
  if (!["L", "P"].includes(d.gender)) e.gender = "Pilih jenis kelamin.";
  if (d.address.length < 5 || d.address.length > 255) e.address = "Alamat wajib 5–255 karakter.";
  if (needSpecialization && (d.specialization.length < 3 || d.specialization.length > 100)) e.specialization = "Spesialisasi wajib 3–100 karakter.";
  for (const [k, label, multi] of PROFILE_TEXT) if (!isCleanText(d[k] ?? "", multi)) e[k] = textMessage(label, multi);
  return e;
}

/**
 * Masa akses dokter untuk jadwal WIB "YYYY-MM-DD HH:MM[:SS]" / "YYYY-MM-DDTHH:MM" (detik Unix):
 * 00:00 WIB pertama SETELAH (jadwal + 24 jam), atau tepat (jadwal + 24 jam) bila sudah 00:00.
 * HARUS identik dengan accessExpiresAt di backend/lib/validate.js (diuji scripts/test-parity.js).
 * Dipakai sebagai expectedExpiresAt: nilai server berbeda -> MetaMask tidak dibuka.
 */
export function accessExpiresAt(slotWib) {
  const [y, mo, d, h, mi, se = 0] = slotWib.split(/[- :T]/).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, se) / 1000 + 86400; // jam dinding WIB (jadwal + 24 jam) sebagai detik
  return Math.ceil(wall / 86400) * 86400 - 7 * 3600;              // bulatkan ke 00:00 WIB, lalu ke detik Unix
}
/** Status appointment aktif (mengunci slot & jatah); = LOCKING di backend/routes/appointments.js. */
export const ACTIVE_APPOINTMENT = ["requested", "accepted", "rescheduled_by_doctor"];
/**
 * Pasien ditawari "Cabut akses dokter" untuk appointment `a`: appointment sudah berakhir tanpa
 * perawatan (ditolak, dibatalkan, kedaluwarsa), akses on-chain dokter itu masih aktif (`activeDoctors` = Set
 * wallet dokter berstatus active dari GET /api/access/me), dan TIDAK ada appointment aktif lain dengannya di `list`.
 */
export const offerRevoke = (a, list, activeDoctors) =>
  ["rejected", "cancelled", "expired"].includes(a.status) && activeDoctors.has(a.doctor_wallet)
  && !list.some((x) => x.doctor_wallet === a.doctor_wallet && ACTIVE_APPOINTMENT.includes(x.status));
/** Booking/reschedule paling jauh hari ini + 57 hari (WIB); = BOOKING_HORIZON_DAYS di backend. */
export const BOOKING_HORIZON_DAYS = 57;
