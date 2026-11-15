// care-view.js — halaman Appointment, Resep Digital, dan Akses Dokter.
// Semua data lewat api.js (bentuk sama dengan respons backend & event kontrak).
// Tombol hanya muncul sesuai role, tetapi penegakan sebenarnya di kontrak & backend.
import * as api from "./api.js";
import { getSession } from "./session.js";
import {
  el, renderIcon, formatDate, toast, openModal, confirmDialog, field, showErrors, setLoading,
  emptyState, dataTable, rowActions, personCell, hashCell, tabs, page, card, avatar, skeletonRows, shortAddress,
  txProgress, txModal, resultNote as note, iconButton, reasonField,
} from "./ui.js";
import { integrityBadge, rxList } from "./records-view.js";
import { accessExpiresAt, BOOKING_HORIZON_DAYS, ACTIVE_APPOINTMENT as ACTIVE, offerRevoke } from "./validation.js";

const session = getSession();
const role = session?.role;
const me = session?.wallet;

// Waktu: SELALU WIB (Asia/Jakarta), tidak bergantung zona waktu browser
// scheduled_at dari API: "YYYY-MM-DD HH:MM:SS" WIB. expiresAt: detik Unix (waktu blok).
const fmt = (opts) => new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", ...opts });
const DAY_LONG = fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
const MONTH = fmt({ month: "short" });
const TIME = fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const wibDate = (s) => new Date(`${s.slice(0, 16).replace(" ", "T")}:00+07:00`);
const whenText = (s) => `${DAY_LONG.format(wibDate(s))} · ${s.slice(11, 16)} WIB`;
export const unixText = (sec) => `${DAY_LONG.format(new Date(sec * 1000))} · ${TIME.format(new Date(sec * 1000)).replace(".", ":")} WIB`;
const todayWib = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(ymd) + n * 864e5).toISOString().slice(0, 10);
// Sisa waktu dari remainingSeconds respons server (waktu blok), BUKAN Date.now() vs expiresAt.
export function durationText(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return [d && `${d} hari`, h && `${h} jam`, !d && m && `${m} menit`].filter(Boolean).join(" ") || "kurang dari 1 menit";
}
// Aturan H-1 di UI hanya untuk UX (tombol nonaktif + penjelasan); server tetap penentu.
const H1_MS = 24 * 3600e3;
const msLeft = (a) => wibDate(a.scheduled_at).getTime() - Date.now();

// Status akses dokter
const ACCESS_STATUS = {
  active: ["Aktif", "confirmed"], expired: ["Kedaluwarsa", "pending"], revoked: ["Dicabut", "failed"], none: ["Belum pernah", "unregistered"],
};
export const accessBadge = (s) => el("span", { className: `badge badge-${ACCESS_STATUS[s]?.[1] ?? "unregistered"}` }, ACCESS_STATUS[s]?.[0] ?? "Tidak dikenal");
// Keterangan masa berlaku. whoRevoked(addr) -> teks pelaku pencabutan.
export function accessDetail(a, whoRevoked = () => "") {
  if (a.status === "active") return `Berlaku sampai ${unixText(a.expiresAt)} · sisa ${durationText(a.remainingSeconds)}`;
  if (a.status === "expired") return `Berakhir otomatis ${unixText(a.expiresAt)}`;
  // role_revoked: role Doctor ATAU Patient dicabut Admin -> akses lama mati permanen di kontrak (perlu izin baru pasien).
  if (a.status === "revoked" && a.revokedReason === "role_revoked") return "Dicabut oleh Admin · role dokter atau pasien dicabut";
  if (a.status === "revoked") return `Dicabut${a.revokedBy ? ` oleh ${whoRevoked(a.revokedBy)}` : ""}`;
  return "Belum pernah diberi akses";
}

// Transaksi MetaMask
// Semua transaksi lewat api.js -> chain.js runTx; tahapnya ditampilkan txProgress (ui.js).
// Dokter melepas aksesnya: renounceAccess(patient) -> POST /api/access/log (renounce_access).
export function renounceModal(patient, name, done, lead = "") {
  txModal({
    title: "Lepas akses ke rekam medis?",
    message: `${lead}Setelah dilepas, Anda tidak bisa lagi membaca atau menulis rekam medis ${name}, termasuk yang Anda tulis sendiri, sampai pasien memberi akses lagi lewat appointment berikutnya.`,
    confirmText: "Lepas akses", label: "renounceAccess",
    run: (onStage) => api.renounceAccess(patient, { onStage }),
    successText: `Akses Anda ke ${name} sudah dilepas.`, done,
  });
}

// Pasien mencabut akses dokter: revokeDoctorAccess(me, doctor) -> POST /api/access/log (revoke_access).
export function revokeModal(doctor, name, done, lead = "") {
  txModal({
    title: `Cabut akses ${name}?`,
    message: `${lead}${name} tidak akan bisa lagi membaca, menambah, mengubah, atau menghapus rekam medis Anda, termasuk yang ia tulis sendiri. Rekam medis yang sudah ada tetap tersimpan. Pencabutan dikirim sebagai transaksi revokeDoctorAccess dan tercatat permanen di blockchain.`,
    confirmText: "Cabut Akses", label: "revokeDoctorAccess",
    run: (onStage) => api.revokeAccess(me, doctor, { onStage }),
    successText: `Akses ${name} dicabut.`, done,
  });
}

// Handshake accessAction (api.saveWithAccess): kirim tanpa txHash; jika grant/extend ->
// MetaMask grantDoctorAccess(doctor, expiresAt) -> kirim ulang dengan txHash. Progres tx hanya tampil
// bila memang ada transaksi. Mengembalikan respons tersimpan, atau null (tx ditolak/gagal; pesan di box).
// scheduledAt = jadwal yang ditampilkan ke pasien: expiresAt yang ditandatangani WAJIB = accessExpiresAt(jadwal itu).
async function saveWithAccess(box, doctor, scheduledAt, request) {
  let show = null;
  const res = await api.saveWithAccess(request, doctor, {
    expectedExpiresAt: accessExpiresAt(scheduledAt),
    onStage: (ev) => { show ??= txProgress(box, "grantDoctorAccess"); show(ev); },
  });
  return res.saved ? res : null;
}
const ACCESS_RESULT = {
  none: "Akses dokter sudah mencakup jadwal ini, jadi tidak perlu transaksi baru.",
  grant: "Akses dokter diberikan di blockchain.",
  extend: "Akses dokter diperpanjang di blockchain.",
};
const accessInfo = (scheduledAt, doctorName) => el("div", { className: "access-note" }, [
  renderIcon("shield-check"),
  el("div", {}, [
    el("p", { className: "person-name" }, `${doctorName} dapat mengakses rekam medis Anda sampai ${unixText(accessExpiresAt(scheduledAt))}, lalu otomatis berakhir.`),
    el("p", { className: "muted" }, "Masa akses = hingga akhir hari setelah jadwal (±24–48 jam), sama untuk semua jam di tanggal itu agar jam appointment tidak terbaca di blockchain. Jika akses dokter saat ini lebih pendek, MetaMask meminta tanda tangan grantDoctorAccess. Anda bisa mencabutnya kapan saja di menu Akses Dokter."),
  ]),
]);

// Pemilih jadwal (tanggal + slot 30 menit, WIB)
// Kartu pilihan berbasis radio asli: bisa dipilih dengan keyboard & terbaca screen reader.
function choice(name, value, checked, content, onchange) {
  const input = el("input", { type: "radio", name, value, className: "sr-only", onchange });
  input.checked = checked;
  return el("label", { className: "choice" }, [input, el("span", { className: "choice-body" }, content)]);
}
// loadSlots(date) -> Promise<string[]> slot yang ditawarkan. onPick("YYYY-MM-DDTHH:MM" | "").
function schedulePicker(loadSlots, onPick, initial = {}) {
  const s = { date: initial.date ?? todayWib(), time: initial.time ?? "" };
  // masa akses (00:00 WIB setelah jadwal + 24 jam) harus <= waktu blok + 60 hari (kontrak) -> paling jauh 57 hari.
  const dateField = field({ name: "date", label: "Tanggal", type: "date", required: true, value: s.date, attrs: { min: todayWib(), max: addDays(todayWib(), BOOKING_HORIZON_DAYS) } });
  const box = el("div", { "aria-live": "polite" });
  const emit = () => onPick(s.time ? `${s.date}T${s.time}` : "");
  async function load() {
    box.replaceChildren(skeletonRows(2));
    let slots;
    try { slots = await loadSlots(s.date); } catch (err) { box.replaceChildren(el("p", { className: "field-error" }, err.message || "Gagal memuat slot.")); return; }
    if (!slots.includes(s.time)) { s.time = ""; emit(); }
    box.replaceChildren(slots.length
      ? el("fieldset", { className: "slot-grid" }, [
          el("legend", { className: "label" }, `Jam (WIB, 30 menit) · ${slots.length} slot tersedia`),
          ...slots.map((t) => choice("slot", t, s.time === t, [el("span", {}, t)], () => { s.time = t; emit(); })),
        ])
      : el("p", { className: "field-hint" }, "Tidak ada slot tersedia di tanggal ini. Pilih tanggal lain."));
  }
  const input = dateField.querySelector("input");
  input.addEventListener("change", () => {
    const v = input.value;
    const okDate = /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= input.min && v <= input.max;
    dateField.classList.toggle("has-error", !okDate);
    dateField.querySelector(".field-error").textContent = okDate ? "" : "Pilih tanggal antara hari ini dan 58 hari ke depan.";
    if (!okDate) return;
    s.date = v; s.time = ""; emit();
    load();
  });
  load();
  return el("div", { className: "booking" }, [dateField, box]);
}
// Slot dokter yang tersedia menurut server (GET /api/appointments/doctors?date=).
const doctorSlots = (doctor) => async (date) => (await api.getAppointmentDoctors({ date })).items.find((d) => d.wallet_address === doctor)?.slots ?? [];
// Dokter tidak punya endpoint slot: tawarkan jam praktik yang belum lewat; bentrok ditolak server (409).
const SLOTS = Array.from({ length: 16 }, (_, i) => `${String(8 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
const practiceSlots = async (date) => SLOTS.filter((t) => wibDate(`${date} ${t}`).getTime() > Date.now());

// Appointment
const APPT_STATUS = {
  requested: ["Menunggu", "pending"], accepted: ["Diterima", "confirmed"], completed: ["Selesai", "info"], rescheduled_by_doctor: ["Jadwal diubah dokter", "pending"],
  rejected: ["Ditolak", "failed"], cancelled: ["Dibatalkan", "unregistered"], expired: ["Kedaluwarsa", "unregistered"],
};
export const apptBadge = (s) => el("span", { className: `badge badge-${APPT_STATUS[s]?.[1] ?? "unregistered"}` }, APPT_STATUS[s]?.[0] ?? s);
// Keterangan status akhir (tanpa aksi). expired = lewat jadwal tanpa diproses.
function statusNote(a) {
  if (a.status === "cancelled" && a.cancel_code === "DOCTOR_ROLE_REVOKED") return "Dibatalkan oleh Admin: dokter tidak lagi aktif.";
  if (a.status === "expired") return "Kedaluwarsa: jadwal lewat tanpa diproses (tidak bisa diubah lagi).";
  return null;
}

function apptItem(a, actions, hint) {
  const d = wibDate(a.scheduled_at);
  const isPatient = role === "patient";
  const moved = a.status === "rescheduled_by_doctor";
  return el("li", { className: "appt" }, [
    el("div", { className: "appt-date", "aria-hidden": "true" }, [el("span", { className: "appt-day" }, String(Number(a.scheduled_at.slice(8, 10)))), el("span", {}, MONTH.format(d))]),
    el("div", { className: "appt-main" }, [
      el("p", { className: "person-name" }, (isPatient ? a.doctor_name : a.patient_name) ?? "Tanpa profil"),
      el("p", { className: "muted appt-when" }, [renderIcon("clock"), whenText(a.scheduled_at), isPatient && a.doctor_specialization ? ` · ${a.doctor_specialization}` : ""]),
      // Admin tidak menerima reason/doctor_note/reschedule_reason dari API, jadi tidak ada yang dirender.
      moved && a.reschedule_reason ? el("p", { className: "appt-note" }, [el("span", { className: "muted" }, isPatient ? "Alasan dokter mengubah jadwal: " : "Alasan reschedule: "), a.reschedule_reason]) : null,
      a.reason ? el("p", { className: "appt-reason" }, a.reason) : null,
      a.doctor_note ? el("p", { className: "appt-note" }, [el("span", { className: "muted" }, "Catatan dokter: "), a.doctor_note]) : null,
      hint ? el("p", { className: "field-hint", id: `appt-hint-${a.id}` }, hint) : null,
    ]),
    el("div", { className: "appt-side" }, [apptBadge(a.status), actions.length ? el("div", { className: "actions" }, actions) : null]),
  ]);
}
const btn = (text, onclick, cls = "btn-secondary", extra = {}) => el("button", { type: "button", className: `btn btn-sm ${cls}`, onclick, ...extra }, text);

export async function pageAppointments() {
  // Pasien: dokter yang aksesnya masih aktif (untuk tawaran "Cabut akses dokter" di Riwayat).
  const accessOf = async () => (role === "patient"
    ? new Set((await api.getMyAccess()).items.filter((d) => d.status === "active").map((d) => d.doctor_wallet))
    : new Set());
  let [list, withAccess] = await Promise.all([api.getAppointments().then((r) => r.items), accessOf()]); // API: urut scheduled_at DESC
  let active = 0; // tab yang sedang dibuka, dipertahankan saat data dimuat ulang
  const holder = el("div");
  const reload = async () => { [list, withAccess] = await Promise.all([api.getAppointments().then((r) => r.items), accessOf()]); draw(); };
  const upcoming = (a) => ACTIVE.includes(a.status) && msLeft(a) > 0;
  const asc = (xs) => [...xs].reverse(); // jadwal mendatang: terdekat di atas

  const groups = role === "patient"
    ? [
        { id: "mendatang", label: "Mendatang", pick: (xs) => asc(xs.filter(upcoming)), empty: ["Belum ada appointment", "Klik \"Buat Appointment\" untuk memesan jadwal dengan dokter."] },
        { id: "riwayat", label: "Riwayat", pick: (xs) => xs.filter((a) => !upcoming(a)), empty: ["Belum ada riwayat", "Appointment yang selesai, ditolak, dibatalkan, atau kedaluwarsa muncul di sini."] },
      ]
    : [
        { id: "menunggu", label: "Menunggu", pick: (xs) => asc(xs.filter((a) => a.status === "requested")), empty: ["Tidak ada permintaan baru", "Permintaan appointment dari pasien muncul di sini."] },
        { id: "terjadwal", label: "Terjadwal", pick: (xs) => asc(xs.filter((a) => ["accepted", "rescheduled_by_doctor"].includes(a.status))), empty: ["Belum ada jadwal", "Appointment yang Anda terima muncul di sini."] },
        { id: "riwayat", label: "Riwayat", pick: (xs) => xs.filter((a) => ["completed", "rejected", "cancelled", "expired"].includes(a.status)), empty: ["Belum ada riwayat", ""] },
      ];

  // [tombol aksi, teks penjelasan]
  function actionsFor(a) {
    const left = msLeft(a);
    if (role === "patient") {
      // Ditolak/dibatalkan, akses dokter masih aktif & tidak ada appointment aktif lain dengannya -> tawarkan cabut.
      // Ditolak/dibatalkan/kedaluwarsa, akses dokter masih aktif & tidak ada appointment aktif lain dengannya -> tawarkan cabut.
      if (offerRevoke(a, list, withAccess)) {
        return [[btn("Cabut akses dokter", () => revokeModal(a.doctor_wallet, a.doctor_name, reload), "btn-secondary text-danger")],
          `${statusNote(a) ? `${statusNote(a)} ` : ""}Tidak ada appointment aktif dengan dokter ini, tetapi aksesnya ke rekam medis Anda masih berlaku.`];
      }
      if (!ACTIVE.includes(a.status) || left <= 0) return [[], statusNote(a)];
      if (a.status === "rescheduled_by_doctor") {
        return [[btn("Batalkan", () => cancelAppt(a, reload), "btn-ghost text-danger"), btn("Tinjau jadwal baru", () => confirmModal(a, reload), "")],
          "Dokter mengubah jadwal. Konfirmasi atau batalkan (pembatalan tetap boleh kurang dari 24 jam sebelum jadwal)."];
      }
      const h1 = left <= H1_MS;
      const desc = h1 ? { disabled: true, "aria-describedby": `appt-hint-${a.id}` } : {};
      return [[btn("Batalkan", () => cancelAppt(a, reload), "btn-ghost text-danger", desc), btn("Reschedule", () => patientReschedule(a, reload), "btn-secondary", desc)],
        h1 ? "Kurang dari 24 jam sebelum jadwal (H-1): tidak bisa dibatalkan atau dijadwal ulang. Hubungi rumah sakit bila mendesak." : null];
    }
    if (a.status === "requested") {
      return [[btn("Tolak", () => noteModal(a, "reject", reload)), btn("Reschedule", () => doctorReschedule(a, reload)), btn([renderIcon("check"), "Terima"], () => noteModal(a, "accept", reload), "")], null];
    }
    if (a.status === "rescheduled_by_doctor") {
      return [left > 0 ? [btn("Reschedule", () => doctorReschedule(a, reload))] : [], "Menunggu konfirmasi pasien atas jadwal baru."];
    }
    if (a.status === "accepted") {
      const notYet = left > 0;
      return [[
        notYet ? btn("Reschedule", () => doctorReschedule(a, reload)) : null,
        btn([renderIcon("circle-check"), "Tandai Selesai"], () => completeAppt(a, reload), "btn-secondary", notYet ? { disabled: true, "aria-describedby": `appt-hint-${a.id}` } : {}),
      ].filter(Boolean), notYet ? "Bisa ditandai selesai setelah jadwal dimulai." : "Tandai selesai paling lambat 24 jam setelah jadwal; setelah itu kedaluwarsa."];
    }
    return [[], statusNote(a)];
  }

  function draw() {
    const items = groups.map((g, i) => {
      const rows = g.pick(list);
      return {
        id: `appt-${g.id}`, label: `${g.label} (${rows.length})`,
        render: () => {
          active = i;
          return rows.length ? el("ul", { className: "appt-list" }, rows.map((a) => apptItem(a, ...actionsFor(a)))) : emptyState(g.empty[0], g.empty[1], "calendar");
        },
      };
    });
    holder.replaceChildren(tabs(items, active));
  }
  draw();

  const add = role === "patient" ? el("button", { type: "button", className: "btn", onclick: () => bookingSheet(reload) }, [renderIcon("plus"), "Buat Appointment"]) : null;
  const subtitle = role === "patient" ? "Jadwal konsultasi Anda dengan dokter. Semua waktu dalam WIB." : "Terima, tolak, atau jadwalkan ulang permintaan pasien. Semua waktu dalam WIB.";
  return page(card("Appointment", subtitle, add, holder));
}

// Pesan error server ditampilkan apa adanya (pesannya sudah aman untuk pengguna).
const showError = (box, err, fallback) => box.replaceChildren(note("danger", "circle-alert", fallback, err.message || "Coba lagi."));

// Patient: batalkan -> jika shouldRevoke (tidak ada appointment aktif lain & akses masih aktif), tawarkan "Cabut akses".
async function cancelAppt(a, done) {
  if (!(await confirmDialog({ title: "Batalkan appointment?", message: `Jadwal dengan ${a.doctor_name} pada ${whenText(a.scheduled_at)} dibatalkan dan slotnya dibuka untuk pasien lain. Jika tidak ada appointment lain dengan dokter ini, Anda akan ditawari mencabut aksesnya.`, confirmText: "Batalkan appointment", danger: true }))) return;
  let res;
  try { res = await api.patchAppointment(a.id, "cancel"); toast("Appointment dibatalkan.", "success"); }
  catch (err) { toast(err.message || "Gagal membatalkan.", "error"); return done(); }
  await done();
  if (res.shouldRevoke) revokeModal(a.doctor_wallet, a.doctor_name, done, `Tidak ada appointment aktif lain dengan ${a.doctor_name}. `);
}

// Doctor: tandai selesai -> jika shouldRenounce, tawarkan "Lepas akses".
async function completeAppt(a, done) {
  if (!(await confirmDialog({ title: "Tandai selesai?", message: `Konsultasi dengan ${a.patient_name} ditandai selesai dan pindah ke Riwayat.`, confirmText: "Tandai Selesai" }))) return;
  let res;
  try { res = await api.patchAppointment(a.id, "complete"); toast("Appointment ditandai selesai.", "success"); }
  catch (err) { toast(err.message || "Gagal memperbarui.", "error"); return done(); }
  await done();
  if (res.shouldRenounce) renounceModal(a.patient_wallet, a.patient_name, done, `Tidak ada appointment aktif lain dengan ${a.patient_name}. `);
}

// Terima / Tolak dengan catatan opsional untuk pasien.
function noteModal(a, action, done) {
  const accept = action === "accept";
  const form = el("form", { novalidate: true }, [
    el("p", { className: "modal-lead" }, `${a.patient_name} · ${whenText(a.scheduled_at)}`),
    a.reason ? el("p", { className: "appt-reason" }, a.reason) : null,
    field({ name: "note", label: "Catatan untuk pasien", type: "textarea", hint: accept ? "Opsional, mis. dokumen yang perlu dibawa." : "Opsional, mis. alasan penolakan.", attrs: { maxlength: 500, rows: 3 } }),
  ]);
  const save = el("button", { type: "submit", className: `btn ${accept ? "" : "btn-danger"}` }, accept ? "Terima" : "Tolak");
  form.append(el("div", { className: "form-actions" }, [el("button", { type: "button", className: "btn btn-secondary", onclick: () => close() }, "Batal"), save]));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = form.elements.note.value.trim();
    if (!showErrors(form, n.length > 500 ? { note: "Catatan maksimal 500 karakter." } : {})) return;
    setLoading(save, true);
    try {
      await api.patchAppointment(a.id, action, n ? { note: n } : {});
      close();
      toast(accept ? "Appointment diterima." : "Appointment ditolak.", "success");
    } catch (err) {
      setLoading(save, false);
      if (err.fields) showErrors(form, err.fields);
      toast(err.message || "Gagal memperbarui.", "error");
    }
    await done();
  });
  const close = openModal({ title: accept ? "Terima appointment" : "Tolak appointment", body: form });
}

// Doctor: reschedule mendesak. Alasan wajib >= 10 karakter (divalidasi di form & server).
function doctorReschedule(a, done) {
  let when = "";
  const save = el("button", { type: "submit", className: "btn", disabled: true }, "Simpan jadwal baru");
  const picker = schedulePicker(practiceSlots, (v) => { when = v; save.disabled = !v; });
  const form = el("form", { novalidate: true, className: "booking" }, [
    el("p", { className: "modal-lead" }, `${a.patient_name} · jadwal sekarang ${whenText(a.scheduled_at)}`),
    picker,
    field({ name: "reason", label: "Alasan perubahan jadwal", type: "textarea", required: true, hint: "Wajib, 10–500 karakter. Pasien akan melihat alasan ini.", attrs: { maxlength: 500, rows: 3 } }),
  ]);
  const errBox = el("div");
  form.append(errBox, el("div", { className: "form-actions" }, [el("button", { type: "button", className: "btn btn-secondary", onclick: () => close() }, "Batal"), save]));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = form.elements.reason.value.trim();
    const n = [...reason].length;
    if (!showErrors(form, n < 10 || n > 500 ? { reason: "Alasan wajib 10–500 karakter." } : {})) return;
    if (!when) return;
    setLoading(save, true);
    try {
      await api.patchAppointment(a.id, "doctor-reschedule", { scheduled_at: when, reason });
      close();
      toast("Jadwal diubah. Menunggu konfirmasi pasien.", "success");
      await done();
    } catch (err) {
      setLoading(save, false);
      if (err.fields) showErrors(form, err.fields);
      showError(errBox, err, "Gagal mengubah jadwal");
    }
  });
  const close = openModal({ title: "Jadwalkan ulang", body: form, wide: true, sheet: true });
}

// Patient: reschedule (> 24 jam sebelum jadwal) -> status kembali "requested"; handshake akses jadwal baru.
function patientReschedule(a, done) {
  let when = "";
  const body = el("div", { className: "booking" });
  const box = el("div", { className: "progress-box" });
  const info = el("div");
  const save = el("button", { type: "button", className: "btn", disabled: true }, "Simpan jadwal baru");
  const picker = schedulePicker(doctorSlots(a.doctor_wallet), (v) => {
    when = v; save.disabled = !v;
    info.replaceChildren(v ? accessInfo(v.replace("T", " "), a.doctor_name) : "");
  });
  // Wallet dokter ditampilkan: dokter di respons handshake server wajib sama (api.saveWithAccess).
  body.append(el("p", { className: "modal-lead" }, `${a.doctor_name} (${shortAddress(a.doctor_wallet)}) · jadwal sekarang ${whenText(a.scheduled_at)}`), picker, info, box);
  save.addEventListener("click", async () => {
    setLoading(save, true); // cegah klik ganda selama handshake
    try {
      const res = await saveWithAccess(box, a.doctor_wallet, when, (extra) => api.patchAppointment(a.id, "reschedule", { scheduled_at: when, ...extra }));
      if (!res) { setLoading(save, false); save.textContent = "Coba lagi"; return; }
      box.append(note("success", "circle-check", "Jadwal diubah", `Status kembali Menunggu sampai dokter menerimanya. ${ACCESS_RESULT[res.accessAction]}`));
      save.remove();
      await done();
    } catch (err) {
      setLoading(save, false);
      showError(box, err, "Gagal mengubah jadwal");
    }
  });
  openModal({ title: "Reschedule appointment", body, footer: [save], wide: true, sheet: true });
}

// Patient: tinjau jadwal baru dari dokter -> konfirmasi (handshake akses) atau batalkan.
function confirmModal(a, done) {
  const box = el("div", { className: "progress-box" });
  const save = el("button", { type: "button", className: "btn" }, "Konfirmasi jadwal baru");
  const cancel = el("button", { type: "button", className: "btn btn-ghost text-danger", onclick: () => { close(); cancelAppt(a, done); } }, "Batalkan appointment");
  const body = el("div", { className: "booking" }, [
    el("dl", { className: "booking-summary" }, [
      el("div", {}, [el("dt", {}, "Dokter"), el("dd", {}, `${a.doctor_name} (${shortAddress(a.doctor_wallet)})`)]),
      el("div", {}, [el("dt", {}, "Perubahan jadwal"), el("dd", { className: "schedule-change" }, a.previous_scheduled_at
        ? [el("s", {}, whenText(a.previous_scheduled_at)), el("span", { className: "sr-only" }, " diubah menjadi "), el("span", { "aria-hidden": "true" }, " → "), el("strong", {}, whenText(a.scheduled_at))]
        : [el("strong", {}, whenText(a.scheduled_at))])]),
    ]),
    el("p", {}, [el("span", { className: "muted" }, "Alasan dokter: "), a.reschedule_reason ?? "—"]),
    accessInfo(a.scheduled_at, a.doctor_name),
    box,
  ]);
  save.addEventListener("click", async () => {
    setLoading(save, true);
    cancel.disabled = true;
    try {
      const res = await saveWithAccess(box, a.doctor_wallet, a.scheduled_at, (extra) => api.patchAppointment(a.id, "confirm", extra));
      cancel.disabled = false;
      if (!res) { setLoading(save, false); save.textContent = "Coba lagi"; return; }
      box.append(note("success", "circle-check", "Jadwal baru dikonfirmasi", ACCESS_RESULT[res.accessAction]));
      save.remove(); cancel.remove();
      await done();
    } catch (err) {
      setLoading(save, false);
      cancel.disabled = false;
      showError(box, err, "Gagal mengonfirmasi");
    }
  });
  const close = openModal({ title: "Jadwal diubah dokter", body, footer: [cancel, save], wide: true });
}

// Booking (Patient)
// 1. dokter (filter spesialisasi) · 2. tanggal & slot · 3. alasan · 4. info masa akses -> simpan (+ MetaMask bila perlu).
async function bookingSheet(done) {
  const s = { doctor: null, when: "", reason: "", spec: "" };
  const body = el("div", { className: "booking" }, [skeletonRows(3)]);
  const close = openModal({ title: "Buat Appointment", body, wide: true, sheet: true });
  let doctors;
  try { doctors = (await api.getAppointmentDoctors()).items; }
  catch (err) { body.replaceChildren(emptyState("Gagal memuat dokter", err.message || "Coba lagi.", "circle-alert")); return; }
  const STEPS = ["Dokter", "Jadwal", "Alasan", "Akses"];

  const stepper = (n) => el("ol", { className: "stepper", "aria-label": "Langkah booking" }, STEPS.map((t, i) =>
    el("li", { className: i < n ? "done" : i === n ? "current" : "", ...(i === n ? { "aria-current": "step" } : {}) }, [el("span", { className: "stepper-dot" }, String(i + 1)), el("span", {}, t)])));
  const nav = (backFn, next) => el("div", { className: "form-actions booking-actions" }, [
    el("button", { type: "button", className: "btn btn-secondary", onclick: backFn ?? (() => close()) }, backFn ? [renderIcon("chevron-left"), "Kembali"] : "Batal"),
    next,
  ]);
  const nextBtn = (enabled, onclick) => el("button", { type: "button", className: "btn", disabled: !enabled, onclick }, ["Lanjut", renderIcon("chevron-right")]);
  const show = (n, ...nodes) => {
    body.replaceChildren(stepper(n), ...nodes);
    body.querySelector("input:checked, select, input, textarea")?.focus();
  };

  function step1() {
    const next = nextBtn(Boolean(s.doctor), () => step2());
    const specs = [...new Set(doctors.map((d) => d.specialization).filter(Boolean))].sort();
    const filter = field({ name: "spec", label: "Spesialisasi", type: "select", value: s.spec, options: [["", "Semua spesialisasi"], ...specs.map((x) => [x, x])] });
    const grid = el("div");
    const drawDoctors = () => {
      const shown = doctors.filter((d) => !s.spec || d.specialization === s.spec);
      grid.replaceChildren(shown.length
        ? el("fieldset", { className: "choice-grid" }, [
            el("legend", { className: "label" }, "Dokter"),
            ...shown.map((d) => choice("doctor", d.wallet_address, s.doctor?.wallet_address === d.wallet_address, [
              avatar(d.full_name),
              el("span", { className: "choice-text" }, [el("span", { className: "person-name" }, d.full_name), el("span", { className: "muted" }, d.specialization || "Dokter umum")]),
            ], () => { s.doctor = d; s.when = ""; next.disabled = false; })),
          ])
        : emptyState("Belum ada dokter", "Belum ada dokter aktif untuk spesialisasi ini.", "stethoscope"));
    };
    filter.querySelector("select").addEventListener("change", (e) => { s.spec = e.target.value; drawDoctors(); });
    drawDoctors();
    show(0, filter, grid, nav(null, next));
  }

  function step2() {
    const next = nextBtn(Boolean(s.when), () => step3());
    const [date, time] = s.when ? s.when.split("T") : [];
    const picker = schedulePicker(doctorSlots(s.doctor.wallet_address), (v) => { s.when = v; next.disabled = !v; }, { date, time });
    show(1, el("p", { className: "modal-lead" }, [s.doctor.full_name, el("span", { className: "muted" }, ` · ${s.doctor.specialization || "Dokter umum"}`)]), picker, nav(step1, next));
  }

  function step3() {
    const reason = field({ name: "reason", label: "Alasan kunjungan", type: "textarea", required: true, value: s.reason, hint: "3–500 karakter. Hanya Anda dan dokter yang bisa membacanya.", attrs: { maxlength: 500, rows: 3 } });
    const form = el("form", { novalidate: true }, [
      el("dl", { className: "booking-summary" }, [
        el("div", {}, [el("dt", {}, "Dokter"), el("dd", {}, s.doctor.full_name)]),
        el("div", {}, [el("dt", {}, "Waktu"), el("dd", {}, whenText(s.when.replace("T", " ")))]),
        el("div", {}, [el("dt", {}, "Durasi"), el("dd", {}, "30 menit")]),
      ]),
      reason,
    ]);
    form.append(nav(() => { s.reason = form.elements.reason.value; step2(); }, el("button", { type: "submit", className: "btn" }, ["Lanjut", renderIcon("chevron-right")])));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      s.reason = form.elements.reason.value.trim();
      const n = [...s.reason].length;
      if (!showErrors(form, n < 3 || n > 500 ? { reason: "Alasan kunjungan wajib 3–500 karakter." } : {})) return;
      step4();
    });
    show(2, form);
  }

  function step4() {
    const box = el("div", { className: "progress-box" });
    const submit = el("button", { type: "button", className: "btn" }, "Simpan appointment");
    const back = el("button", { type: "button", className: "btn btn-secondary", onclick: () => step3() }, [renderIcon("chevron-left"), "Kembali"]);
    submit.addEventListener("click", async () => {
      setLoading(submit, true); // cegah klik ganda selama handshake
      back.disabled = true;
      try {
        const res = await saveWithAccess(box, s.doctor.wallet_address, s.when, (extra) => api.bookAppointment({ doctor_wallet: s.doctor.wallet_address, scheduled_at: s.when, reason: s.reason, ...extra }));
        back.disabled = false;
        if (!res) { setLoading(submit, false); submit.textContent = "Coba lagi"; return; }
        box.append(note("success", "circle-check", "Appointment dibuat", `Status Menunggu sampai dokter menerimanya. ${ACCESS_RESULT[res.accessAction]}`));
        submit.remove();
        back.replaceChildren("Selesai");
        back.onclick = () => close();
        back.focus();
        await done();
      } catch (err) {
        setLoading(submit, false);
        back.disabled = false;
        showError(box, err, "Gagal membuat appointment");
        // Slot direbut orang lain / jadwal tidak valid -> tawarkan pilih jadwal lain.
        if (err.code === "CONFLICT" || err.fields?.scheduled_at) {
          box.append(el("div", { className: "form-actions" }, [el("button", { type: "button", className: "btn btn-secondary", onclick: () => { s.when = ""; step2(); } }, "Pilih jadwal lain")]));
        }
      }
    });
    show(3, accessInfo(s.when.replace("T", " "), s.doctor.full_name), box, el("div", { className: "form-actions booking-actions" }, [back, submit]));
    submit.focus();
  }

  step1();
}

// Resep Digital (Patient)
export async function pagePrescriptions() {
  const list = await api.getMyPrescriptions();
  if (!list.length) return page(card("Resep Digital", null, null, emptyState("Belum ada resep", "Resep muncul setelah dokter menuliskannya di rekam medis dan transaksinya terkonfirmasi on-chain.", "pill")));
  return page(
    el("p", { className: "page-lead" }, "Resep dari rekam medis yang sudah tercatat di blockchain. Pilih resep untuk melihat daftar obat, memverifikasi, atau mencetaknya."),
    el("ul", { className: "rx-grid" }, list.map((r) => el("li", {}, [
      el("button", { type: "button", className: "card rx-card", onclick: () => rxModal(r) }, [
        el("span", { className: "rx-card-head" }, [el("span", { className: "stat-icon" }, [renderIcon("pill")]), integrityBadge(r)]),
        el("span", { className: "rx-date" }, formatDate(r.created_at)),
        el("span", { className: "person-name" }, r.doctorName),
        el("span", { className: "muted rx-meta" }, `${r.prescriptions.length} obat · ${r.diagnosis}`),
      ]),
    ]))),
  );
}

// Resep + tombol Verifikasi & Cetak. Cetak = window.print() dengan @media print (components.css):
// hanya kartu .rx-print yang tercetak (A4 portrait), racikan tidak terpotong di tengah halaman.
function rxModal(r) {
  const result = el("div", { className: "verify-result", "aria-live": "polite" }, [integrityBadge(r)]);
  const verify = el("button", { type: "button", className: "btn btn-secondary" }, [renderIcon("shield-check"), "Verifikasi"]);
  verify.addEventListener("click", async () => {
    setLoading(verify, true);
    try {
      const st = await api.verifyRecord(r.id);
      result.replaceChildren(integrityBadge(st));
      toast(st === "ok" ? "Resep terverifikasi: sama dengan hash di blockchain." : "Data resep tidak cocok dengan blockchain!", st === "ok" ? "success" : "error");
    } catch (err) { toast(err.message || "Gagal memverifikasi.", "error"); }
    finally { setLoading(verify, false); }
  });
  const print = el("button", { type: "button", className: "btn" }, [renderIcon("printer"), "Cetak"]);
  print.addEventListener("click", () => window.print());
  // Nomor versi = versi yang data_hash-nya cocok dengan rekam medis (GET /api/records/:id).
  const version = el("span", {}, "…");
  api.getRecord(r.id).then((d) => { version.textContent = d.version ? String(d.version) : "-"; }).catch(() => { version.textContent = "-"; });
  // Spesialisasi dokter dari GET /api/access/me (daftar dokter aktif); tidak ada -> dikosongkan.
  const spec = el("span", { className: "muted" });
  api.getMyAccess().then(({ items }) => {
    const s = items.find((d) => d.doctor_wallet === r.doctor)?.specialization;
    spec.textContent = s ? ` · ${s}` : "";
  }).catch(() => {});
  const row = (k, v) => [el("dt", {}, k), el("dd", {}, v)];
  const body = el("div", { className: "record-detail rx-print" }, [
    el("div", { className: "print-only print-head" }, [
      el("img", { src: "assets/biocare-logo.png", alt: "", width: 40, height: 40 }),
      el("div", {}, [el("p", { className: "print-brand" }, "BioCare"), el("p", { className: "muted" }, "Resep Digital")]),
    ]),
    el("dl", { className: "detail-list" }, [
      ...row("Dokter", [r.doctorName, spec]), ...row("Pasien", r.patientName), ...row("Tanggal", formatDate(r.created_at, true)),
      ...row("Diagnosis", r.diagnosis),
    ]),
    el("h3", { className: "section-title" }, [renderIcon("pill"), `Daftar obat (${r.prescriptions.length})`]),
    rxList(r.prescriptions),
    // Data untuk verifikasi: hash ini bisa dicocokkan dengan kontrak HospitalRecords.
    el("p", { className: "rx-proof" }, [
      el("span", {}, [`Rekam medis #${r.id} · versi `, version, " · hash "]),
      el("span", { className: "mono", title: r.chainHash ?? "" }, r.chainHash ? shortAddress(r.chainHash, 10, 8) : "belum tercatat"),
    ]),
    el("div", { className: "proof-foot no-print" }, [result, el("div", { className: "form-actions" }, [verify, print])]),
  ]);
  openModal({ title: `Resep · ${formatDate(r.created_at)}`, body, wide: true });
}

// Akses Dokter
export const pageAccess = () => (role === "admin" ? accessAdmin() : accessPatient());

async function accessPatient() {
  const holder = el("div", { className: "page" });
  async function draw() {
    const list = (await api.getMyAccess()).items.filter((d) => d.status !== "none");
    const who = (d) => (w) => (w === me ? "Anda" : w === d.doctor_wallet ? "dokter (dilepas setelah appointment selesai)" : "Admin");
    const docLine = (d) => {
      const revoke = d.status === "active" ? el("button", { type: "button", className: "btn btn-secondary btn-sm text-danger" }, "Cabut Akses") : null;
      revoke?.addEventListener("click", () => revokeModal(d.doctor_wallet, d.doctor_name, draw));
      return el("li", { className: "access-item" }, [
        avatar(d.doctor_name),
        el("div", { className: "list-main" }, [
          el("p", { className: "person-name" }, [d.doctor_name, " ", accessBadge(d.status)]),
          el("p", { className: "muted" }, d.specialization || "Dokter umum"),
          el("p", { className: "access-meta" }, [el("span", { className: "muted" }, accessDetail(d, who(d))), hashCell(d.txHash)]),
        ]),
        revoke,
      ]);
    };
    const active = list.filter((d) => d.status === "active");
    const past = list.filter((d) => d.status !== "active");
    holder.replaceChildren(
      card("Dokter dengan akses", "Akses diberikan saat booking/konfirmasi jadwal, berlaku hingga akhir hari setelah jadwal (±24–48 jam), lalu berakhir otomatis.", null,
        active.length ? el("ul", { className: "access-list" }, active.map(docLine))
          : emptyState("Belum ada dokter dengan akses", "Akses diberikan otomatis lewat MetaMask saat Anda membuat appointment.", "shield-check")),
      past.length ? card("Riwayat akses", "Akses yang sudah kedaluwarsa atau dicabut. Dokter ini tidak bisa membuka rekam medis Anda.", null, el("ul", { className: "access-list" }, past.map(docLine))) : null,
    );
  }
  await draw();
  return holder;
}

// "Buka identitas" (Admin): nama pasien di balik pseudonim, alasan wajib 10–200 karakter (aturan teks
// sama dengan backend). Server mencatatnya di access_log & membatasi 10/jam. Nama hanya disimpan di memori
// halaman ini (`revealed`), hilang saat pindah halaman. done(nama) dipanggil setelah berhasil.
export function revealModal(pseudonym, done) {
  const form = el("form", { novalidate: true }, [
    el("p", { className: "modal-lead" }, `Pasien ${pseudonym}`),
    el("p", { className: "muted" }, "Nama pasien hanya dibuka bila memang dibutuhkan untuk tugas Admin. Alasan Anda, waktu, dan pasien yang dibuka tercatat permanen di log audit (maks. 10 per jam)."),
    field({ name: "reason", label: "Alasan membuka identitas", required: true, hint: "Wajib, 10–200 karakter.", attrs: { maxlength: 200, autocomplete: "off" } }),
  ]);
  const save = el("button", { type: "submit", className: "btn" }, "Buka identitas");
  form.append(el("div", { className: "form-actions" }, [el("button", { type: "button", className: "btn btn-secondary", onclick: () => close() }, "Batal"), save]));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = form.elements.reason.value.trim();
    const n = [...reason].length;
    if (!showErrors(form, n < 10 || n > 200 ? { reason: "Alasan wajib 10–200 karakter." } : {})) return;
    setLoading(save, true);
    try {
      const r = await api.revealIdentity(pseudonym, reason);
      close();
      done(r.full_name);
    } catch (err) {
      setLoading(save, false);
      if (err.fields) showErrors(form, err.fields);
      toast(err.message || "Gagal membuka identitas.", "error");
    }
  });
  const close = openModal({ title: "Buka identitas pasien", body: form });
}

async function accessAdmin() {
  let rows = (await api.getAllAccess()).items;
  let table;
  const revealed = new Map(); // pseudonim -> nama (hanya yang dibuka dengan alasan)
  const reload = async () => { rows = (await api.getAllAccess()).items; table.refresh(); };
  const patientLabel = (r) => revealed.get(r.patient_pseudonym) ?? `Pasien ${r.patient_pseudonym}`;
  table = dataTable({
    columns: [
      // Pasien = pseudonim dari server (tanpa wallet); nama hanya setelah "Buka identitas".
      { label: "Pasien", render: (r) => personCell(patientLabel(r), null) },
      // Dokter yang role-nya kini bukan Doctor: hanya pseudonim dari backend.
      { label: "Dokter", render: (r) => personCell(r.doctor_name ?? (r.doctor_pseudonym ? `Dokter tidak aktif ${r.doctor_pseudonym}` : "Tanpa profil"), r.doctor_wallet) },
      { label: "Status", render: (r) => accessBadge(r.status) },
      { label: "Masa berlaku", render: (r) => el("span", { className: "muted" }, accessDetail(r, (w) => (w === r.patient_pseudonym ? "pasien" : w === (r.doctor_wallet ?? r.doctor_pseudonym) ? "dokter" : "Admin"))) },
      { label: "Tx hash", render: (r) => hashCell(r.txHash) },
      { label: el("span", { className: "sr-only" }, "Aksi"), render: (r) => {
        const reveal = revealed.has(r.patient_pseudonym) ? null
          : iconButton("eye", `Buka identitas pasien ${r.patient_pseudonym}`, () => revealModal(r.patient_pseudonym, (name) => { revealed.set(r.patient_pseudonym, name); table.refresh(); }));
        if (r.status !== "active") return rowActions([reveal].filter(Boolean));
        const b = el("button", { type: "button", className: "btn btn-ghost btn-sm text-danger", "aria-label": `Cabut akses ${r.doctor_name} ke ${patientLabel(r)}` }, "Cabut Akses");
        b.addEventListener("click", () => {
          // Wallet pasien dibuka (tercatat, alasan wajib) tepat sebelum MetaMask, hanya sebagai variabel lokal transaksi.
          const why = reasonField("Alasan mencabut akses");
          txModal({
            title: "Cabut akses dokter?",
            message: `${r.doctor_name} tidak lagi bisa membuka atau menulis rekam medis ${patientLabel(r)}. Gunakan ini bila dokter sudah tidak menangani pasien tersebut. Wallet pasien dibuka hanya untuk transaksi revokeDoctorAccess ini dan tercatat di log audit.`,
            extra: why.node,
            confirmText: "Cabut Akses", label: "revokeDoctorAccess",
            run: (onStage) => api.revokeAccessAsAdmin(r.patient_pseudonym, r.doctor_wallet, why.value(), { onStage }),
            successText: "Akses dicabut.", done: reload,
          });
        });
        return rowActions([reveal, b].filter(Boolean));
      } },
    ],
    rows: () => rows,
    pageSize: 8,
    search: (r) => `${r.patient_pseudonym} ${revealed.get(r.patient_pseudonym) ?? ""} ${r.doctor_name ?? ""} ${r.doctor_wallet ?? r.doctor_pseudonym ?? ""}`,
    filter: { label: "Status", options: Object.entries(ACCESS_STATUS).filter(([k]) => k !== "none").map(([k, v]) => [k, v[0]]), match: (r, v) => r.status === v },
    empty: ["Belum ada relasi akses", "Akses muncul setelah pasien memberi izin ke dokter saat booking."],
  });
  return page(card("Akses dokter ke pasien", "Relasi akses dari kontrak (aktif, kedaluwarsa, dicabut). Pasien tampil sebagai pseudonim; nama hanya dibuka dengan alasan dan tercatat di log audit.", null, table));
}
