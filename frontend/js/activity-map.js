// activity-map.js — SATU tempat pemetaan event kontrak & status transaksi
// ke label Bahasa Indonesia, ikon (lucide lokal), dan warna (tone-*).
import { ROLE_LABEL } from "./session.js";
import { roleFromEnum, toNumberId } from "./chain-format.js";
import { shortAddress, formatDate } from "./ui.js";

export const EVENTS = {
  RoleGranted:       { label: "Role diberikan",      icon: "user-cog",    tone: "info" },
  RoleRevoked:       { label: "Role dicabut",        icon: "user-cog",    tone: "danger" },
  PatientRegistered: { label: "Pasien mendaftar",    icon: "badge-check", tone: "success" },
  RecordAdded:       { label: "Rekam medis dibuat",  icon: "plus",        tone: "success" },
  RecordUpdated:     { label: "Rekam medis diubah",  icon: "pencil",      tone: "warning" },
  RecordDeleted:     { label: "Rekam medis dihapus", icon: "trash-2",     tone: "danger" },
  AccessGranted:     { label: "Akses dokter diberikan",    icon: "shield-plus",    tone: "success" },
  AccessExtended:    { label: "Akses dokter diperpanjang", icon: "clock-arrow-up", tone: "info" },
  AccessRevoked:     { label: "Akses dokter dicabut",      icon: "shield-off",     tone: "danger" },
};
// AccessRevoked dengan by = doctor = dokter melepas aksesnya sendiri (renounceAccess), bukan dicabut pasien/Admin.
const RENOUNCED = { label: "Akses dilepas dokter", icon: "log-out", tone: "warning" };
// Kolom action di tx_log (GET /api/tx-log: transaksi pending/failed yang dikirim aplikasi).
export const TX_ACTIONS = {
  grant_role: EVENTS.RoleGranted, revoke_role: EVENTS.RoleRevoked, register_patient: EVENTS.PatientRegistered,
  add_record: EVENTS.RecordAdded, update_record: EVENTS.RecordUpdated, delete_record: EVENTS.RecordDeleted,
  grant_access: EVENTS.AccessGranted, extend_access: EVENTS.AccessExtended, revoke_access: EVENTS.AccessRevoked, renounce_access: RENOUNCED,
};
export const eventInfo = (name) => EVENTS[name] ?? { label: name, icon: "activity", tone: "info" };
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
/** Label + ikon satu baris Riwayat Aktivitas: event kontrak (e.event) atau baris tx_log (e.action). */
export function activityInfo(e) {
  if (e.event === "AccessRevoked" && same(e.args?.by, e.args?.doctor)) return RENOUNCED;
  if (e.event) return eventInfo(e.event);
  return TX_ACTIONS[e.action] ?? { label: e.action ?? "Transaksi", icon: "activity", tone: "info" };
}

// Masa berlaku akses (detik Unix waktu blok) dalam WIB.
const until = (sec) => (sec == null ? "" : ` · berlaku s.d. ${formatDate(new Date(Number(sec) * 1000), true)}`);
// Ringkasan satu baris dari argumen event (nama argumen = ABI kontrak), mis. "Doctor" atau "Record #5".
// RecordAdded/Updated/Deleted: id · RoleGranted: role · RoleRevoked: previousRole · PatientRegistered: (pelakunya = pasien itu sendiri).
// AccessGranted/Extended: dokter + masa berlaku baru · AccessRevoked: dokter (pencabut = args.by) ·
// renounceAccess: pasien yang aksesnya dilepas (pelakunya dokter itu sendiri).
export function eventSummary(e) {
  const a = e.args ?? {};
  if (a.id != null) return `Record #${toNumberId(a.id)}`;
  if (activityInfo(e) === RENOUNCED && a.patient) return `Pasien ${shortAddress(a.patient)}`;
  // Pencabut akses: pasien itu sendiri atau Admin (dokter sendiri = RENOUNCED di atas).
  if (e.event === "AccessRevoked" && a.by && a.doctor) return `Dokter ${shortAddress(a.doctor)} · dicabut ${same(a.by, a.patient) ? "pasien" : "Admin"}`;
  if ((e.event?.startsWith("Access") || e.action?.endsWith("_access")) && a.doctor) {
    return `Dokter ${shortAddress(a.doctor)}${until(a.expiresAt ?? a.newExpiresAt)}`;
  }
  const role = a.role ?? a.previousRole;
  // Mencabut role Doctor mengakhiri semua akses perawatan dokter itu di kontrak (tanpa event AccessRevoked per pasien).
  if (e.event === "RoleRevoked" && roleFromEnum(role) === "doctor") return `${ROLE_LABEL.doctor} · semua akses perawatan berakhir`;
  if (role != null) return ROLE_LABEL[roleFromEnum(role)] ?? `Role tidak dikenal (${role})`;
  return "";
}

export const STATUS = {
  confirmed: { label: "Confirmed", icon: "circle-check",  tone: "success" },
  pending:   { label: "Pending",   icon: "loader-circle", tone: "warning" },
  failed:    { label: "Failed",    icon: "circle-alert",  tone: "danger" },
};
export const statusInfo = (s) => STATUS[s] ?? { label: s, icon: "info", tone: "info" };
