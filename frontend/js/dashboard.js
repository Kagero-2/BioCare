// dashboard.js — kerangka dashboard + isi tiap halaman.
// Semua data lewat api.js (backend + kontrak). Filter per role di sini
// hanya untuk tampilan; penegakan akses sebenarnya di kontrak & backend.
import * as api from "./api.js";
import { ROLE_LABEL, getSession } from "./session.js";
import { checkContractDeployed } from "./config.js";
import { getBrowserProvider } from "./chain.js";
import { routesFor, renderMenu, startRouter } from "./router.js";
import {
  el, renderIcon, hydrateIcons, iconButton, shortAddress, addressNode, formatDate, timeAgo,
  roleBadge, statusBadge, toast, openModal, confirmDialog, field, showErrors, setLoading,
  emptyState, skeletonRows, dataTable, rowActions, avatar, copyText, tabs, formData, personCell, hashCell,
  page, card, timeNode, txModal, txProgress, resultNote, reasonField,
} from "./ui.js";
import { EVENTS, activityInfo, eventSummary, statusInfo } from "./activity-map.js";
import { validateProfile } from "./validation.js";
import { roleFromEnum, checksumAddress } from "./chain-format.js";

// Sesi
// Sesi dari backend (cookie JWT); role dibaca backend dari kontrak. Belum login (401) atau
// role sudah dicabut -> kembali ke login (di sana ada Registrasi Pasien).
const authed = await api.authMe().catch(() => null);
const session = authed && authed.role !== "unregistered" ? getSession() : null;
if (!session) {
  await api.authLogout();
  location.replace("index.html");
}
// View dimuat SETELAH sesi tersedia: care-view/records-view membaca role & wallet dari sesi saat dimuat.
const { pageAppointments, pagePrescriptions, pageAccess, accessBadge, accessDetail, renounceModal, apptBadge } = await import("./care-view.js");
const { recordsTable, recordDetailModal, recordFormModal, integrityBadge, verifyAllBox, copyable } = await import("./records-view.js");
const role = session?.role;
const me = session?.wallet;
const isAdmin = role === "admin";
const isDoctor = role === "doctor";
let myProfile = null; // dimuat saat start; dipakai sapaan & kartu pengguna

// Helper
const GENDER = [["L", "Laki-laki"], ["P", "Perempuan"]];
const genderLabel = (g) => Object.fromEntries(GENDER)[g] ?? "-";
const PEOPLE = { patient: "Pasien", doctor: "Dokter" };
const withinDays = (iso, days) => Date.now() - new Date(iso).getTime() <= days * 864e5;
const truncate = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
const isHash = (v) => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
function ageOf(birth) {
  const b = new Date(birth);
  if (Number.isNaN(b.getTime())) return "-";
  const t = new Date();
  let age = t.getFullYear() - b.getFullYear();
  if (t < new Date(t.getFullYear(), b.getMonth(), b.getDate())) age--;
  return `${age} tahun`;
}
// Admin menerima umur (age), bukan tanggal lahir; role lain menerima birth_date.
const ageText = (u) => (u.age != null ? `${u.age} tahun` : ageOf(u.birth_date));
// Komponen kecil
// trend = [teks, "up" | "flat"]
const statCard = (icon, value, label, trend) => el("div", { className: "card stat-card" }, [
  el("div", { className: "stat-icon" }, [renderIcon(icon)]),
  el("div", {}, [
    el("p", { className: "stat-value" }, String(value)),
    el("p", { className: "stat-label" }, label),
    trend ? el("span", { className: `stat-trend ${trend[1]}` }, trend[0]) : null,
  ]),
]);
const linkBtn = (href, text) => el("a", { href, className: "btn btn-ghost btn-sm" }, text);
// Ringkasan kecil: [label, nilai] berderet (dipakai Rekam Medis Saya & Profil).
const summaryRow = (items) => el("dl", { className: "summary" }, items.map(([k, v]) => el("div", {}, [el("dt", {}, k), el("dd", {}, [v])])));

function greeting() {
  const h = new Date().getHours();
  const part = h < 11 ? "pagi" : h < 15 ? "siang" : h < 18 ? "sore" : "malam";
  const name = myProfile?.full_name;
  const today = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  return el("header", { className: "greet" }, [el("h2", {}, `Selamat ${part}${name ? `, ${name}` : ""}`), el("p", {}, today)]);
}
function trendOf(list, key, verb) {
  const n = list.filter((x) => withinDays(x[key], 7)).length;
  return n ? [`+${n} ${verb} minggu ini`, "up"] : ["Tidak ada perubahan minggu ini", "flat"];
}
const userStatus = (u) => u.status === "pending"
  ? el("span", { className: "badge badge-pending" }, "Pending")
  : el("span", { className: "badge badge-confirmed" }, "Active");

// Ikon + label event dari activity-map.js
const eventIcon = (e) => {
  const info = activityInfo(e);
  return el("span", { className: `event-icon tone-${info.tone}`, "aria-hidden": "true" }, [renderIcon(info.icon)]);
};
const eventCell = (e) => el("span", { className: "event-cell" }, [
  eventIcon(e),
  el("span", {}, [el("span", { className: "person-name" }, activityInfo(e).label), el("span", { className: "muted event-detail" }, eventSummary(e))]),
]);
// Status transaksi sebagai ikon (label tetap terbaca screen reader & tooltip).
const statusIcon = (s) => {
  const info = statusInfo(s);
  return el("span", { className: `status-icon text-${info.tone}`, title: info.label }, [renderIcon(info.icon), el("span", { className: "sr-only" }, info.label)]);
};

// Dashboard
function pageDashboard() {
  if (isAdmin) return dashAdmin();
  if (role === "patient") return dashPatient();
  return dashDoctor();
}

async function dashAdmin() {
  const [patients, doctors, stats, recent, acts, summary] = await Promise.all([
    api.getUsers("patient"), api.getUsers("doctor"),
    api.getRecordStats(), api.getRecentUsers(5), api.getActivity({ limit: 6 }), api.getAppointmentSummary(),
  ]);
  // Admin hanya menerima AGREGAT appointment (tanggal × dokter × status × jumlah), tanpa pasien & jam.
  const summaryTable = dataTable({
    columns: [
      { label: "Tanggal", render: (r) => formatDate(`${r.date}T00:00:00+07:00`) },
      // Dokter yang role-nya kini bukan Doctor: hanya pseudonim dari backend.
      { label: "Dokter", render: (r) => personCell(r.doctor_name ?? (r.doctor_pseudonym ? `Dokter tidak aktif ${r.doctor_pseudonym}` : "Tanpa profil"), r.doctor_wallet) },
      { label: "Status", render: (r) => apptBadge(r.status) },
      { label: "Jumlah", render: (r) => el("span", { className: "mono" }, String(r.count)) },
    ],
    rows: summary, pageSize: 5,
    search: (r) => `${r.date} ${r.doctor_name ?? ""} ${r.doctor_wallet ?? ""} ${r.doctor_pseudonym ?? ""}`,
    empty: ["Belum ada appointment", ""],
  });
  const usersTable = dataTable({
    columns: [
      { label: "Nama", render: (u) => el("div", { className: "person" }, [avatar(u.full_name), el("span", { className: "person-name" }, u.full_name)]) },
      { label: "Wallet", render: (u) => addressNode(u.wallet) },
      { label: "Role", render: (u) => roleBadge(u.role) },
      { label: "Status", render: userStatus },
    ],
    rows: recent, pageSize: 5, empty: ["Belum ada pengguna", ""],
  });
  return page(
    greeting(),
    el("div", { className: "stat-grid" }, [
      statCard("user", patients.length, "Pasien", trendOf(patients, "created_at", "baru")),
      statCard("stethoscope", doctors.length, "Dokter", trendOf(doctors, "created_at", "baru")),
      // Jumlah saja; Admin tidak menerima alasan kunjungan.
      statCard("calendar", stats.appointmentsToday, "Appointment hari ini"),
      // Admin hanya melihat JUMLAH rekam medis, bukan isinya.
      statCard("file-text", stats.total, "Rekam Medis", stats.newThisWeek ? [`+${stats.newThisWeek} baru minggu ini`, "up"] : ["Tidak ada perubahan minggu ini", "flat"]),
    ]),
    el("div", { className: "grid-main" }, [
      card("Pengguna Terbaru", "Profil yang terakhir ditambah atau diubah.", null, usersTable),
      card("Aktivitas Terbaru", "Event kontrak & transaksi pending/gagal terbaru.", linkBtn("#/activity", "Lihat semua"), activityFeed(acts)),
    ]),
    card("Ringkasan Appointment", "Jumlah per tanggal, dokter, dan status. Data pasien, jam, dan alasan kunjungan tidak ditampilkan untuk Admin.", null, summaryTable),
  );
}

// Rekonsiliasi draft rekam medis pending (tx sah tetapi confirm tidak sempat dipanggil, atau draft
// yang tidak pernah ditandatangani). Mengembalikan ringkasan teks; toast hanya jika ada perubahan.
async function reconcile(quiet) {
  const r = await api.reconcileRecords();
  const text = `${r.confirmed} terkonfirmasi · ${r.failed} ditandai gagal · ${r.pending} masih tertunda`;
  if (r.confirmed || r.failed) toast(`Transaksi tertunda diperiksa: ${text}.`, r.failed ? "warning" : "success", 8000);
  else if (!quiet) toast(r.pending ? `Masih ada ${r.pending} transaksi tertunda.` : "Tidak ada transaksi tertunda.", "info");
  return text;
}

async function dashDoctor() {
  // Dijalankan sebelum statistik dimuat agar jumlah "Transaksi pending" sudah segar.
  const first = await reconcile(true).catch((err) => `Gagal memeriksa: ${err.message}`);
  const [patients, stats] = await Promise.all([api.getUsers("patient"), api.getRecordStats()]);
  const pendingNote = el("p", { className: "muted card-pad", "aria-live": "polite" }, `Pemeriksaan terakhir: ${first}.`);
  const check = el("button", { type: "button", className: "btn btn-secondary btn-sm", onclick: async () => {
    setLoading(check, true);
    try { pendingNote.textContent = `Pemeriksaan terakhir: ${await reconcile(false)}.`; } catch (err) { toast(err.message, "error"); }
    setLoading(check, false);
  } }, [renderIcon("history"), "Periksa transaksi tertunda"]);
  const recent = [...patients].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5);
  const items = [["users", patients.length, "Pasien dengan akses aktif"], ["file-text", stats.mine, "Rekam medis buatan saya"], ["loader-circle", stats.minePending, "Transaksi pending"]];
  const list = recent.length
    ? el("ul", { className: "list" }, recent.map((p) => el("li", {}, [
        el("a", { className: "list-link", href: `#/patients/${p.wallet}` }, [
          avatar(p.full_name),
          el("div", { className: "list-main" }, [el("div", { className: "person-name" }, p.full_name), el("div", { className: "muted" }, `${genderLabel(p.gender)} · ${ageOf(p.birth_date)}`)]),
          el("span", { className: "muted list-meta" }, `${p.recordCount ?? 0} rekam medis`),
          renderIcon("chevron-right", "list-chevron"),
        ]),
      ])))
    : emptyState("Belum ada pasien", "Pasien muncul setelah memberi Anda akses, biasanya saat membuat appointment.");
  return page(
    greeting(),
    el("div", { className: "stat-grid" }, items.map((s) => statCard(...s))),
    card("Transaksi rekam medis tertunda", "Draft yang belum tercatat diperiksa ulang langsung ke blockchain.", check, pendingNote),
    card("Pasien Terbaru", "Pilih pasien untuk membuka rekam medisnya.", linkBtn("#/patients", "Lihat semua"), list),
  );
}

async function dashPatient() {
  const [u, records] = await Promise.all([api.getMyProfile(), api.getMyRecords()]);
  const profile = u
    ? el("section", { className: "card card-pad profile-card" }, [
        avatar(u.full_name, "avatar-lg"),
        el("div", { className: "profile-main" }, [
          el("h2", { className: "card-title" }, u.full_name),
          el("p", { className: "muted" }, [addressNode(me)]),
          el("dl", { className: "meta-row" }, [
            el("div", {}, [el("dt", {}, "Umur"), el("dd", {}, ageOf(u.birth_date))]),
            el("div", {}, [el("dt", {}, "Jenis kelamin"), el("dd", {}, genderLabel(u.gender))]),
            el("div", {}, [el("dt", {}, "Telepon"), el("dd", {}, u.phone)]),
          ]),
        ]),
        el("a", { href: "#/profile", className: "btn btn-secondary btn-sm" }, "Ubah profil"),
      ])
    : el("section", { className: "card" }, [emptyState("Profil belum ada", "Lengkapi profil Anda di menu Profil.", "user")]);
  const latest = records.slice(0, 3);
  const list = latest.length
    ? el("ul", { className: "list" }, latest.map((r) => el("li", {}, [
        el("button", { type: "button", className: "list-link", onclick: () => recordDetailModal(r) }, [
          el("span", { className: "stat-icon" }, [renderIcon("file-text")]),
          el("div", { className: "list-main" }, [el("div", { className: "person-name" }, truncate(r.diagnosis)), el("div", { className: "muted" }, `${formatDate(r.created_at)} · ${r.doctorName}`)]),
          integrityBadge(r),
        ]),
      ])))
    : emptyState("Belum ada rekam medis", "Rekam medis akan muncul setelah dibuat dokter.");
  return page(
    greeting(),
    profile,
    card("Integritas rekam medis", null, null, el("div", { className: "card-pad" }, [verifyAllBox(records)])),
    card("Rekam Medis Terbaru", null, linkBtn("#/my-records", "Lihat semua"), list),
  );
}

// Data Pasien / Dokter (satu komponen)
async function pagePeople(personRole) {
  const label = PEOPLE[personRole];
  const isPatient = personRole === "patient";
  // Daftar ini hanya berisi profil (tanpa appointment/akses/aktivitas), agar tidak bisa dicocokkan dengan tampilan lain.
  let rows = await api.getUsers(personRole);
  let table;
  const reload = async () => { rows = await api.getUsers(personRole); table.refresh(); };
  // Kandidat dokter yang pernah pasien: wallet disembunyikan backend, hanya dibuka lewat resolve-wallet (tercatat).
  const nameCell = (u) => u.former_patient
    ? el("div", {}, [personCell(u.full_name, null), el("div", { className: "muted" }, "Pernah terdaftar sebagai pasien: wallet dibuka saat memberi role (tercatat)")])
    : personCell(u.full_name, u.wallet);
  const columns = [
    { label: "Nama", render: nameCell },
    { label: "Jenis kelamin", render: (u) => genderLabel(u.gender) },
    isAdmin ? { label: "Status", render: userStatus } : null,
    isPatient ? { label: "Umur", render: ageText } : { label: "Spesialisasi", render: (u) => u.specialization || "-" },
    // Admin: nomor tersamar dari API (minimisasi data).
    { label: "Telepon", render: (u) => el("span", { className: u.masked ? "mono" : "" }, u.phone) },
    role === "doctor" ? { label: "Akses sejak", render: (u) => formatDate(u.accessSince) } : { label: "Diperbarui", render: (u) => formatDate(u.updated_at) },
    // Tombol aksi hanya untuk Admin. rowActions mencegah klik ikut membuka detail.
    isAdmin ? { label: el("span", { className: "sr-only" }, "Aksi"), render: (u) => rowActions([
      iconButton("pencil", `Ubah profil ${u.full_name}`, () => profileModal(u, personRole, reload)),
      u.status === "pending"
        ? (personRole === "doctor" ? iconButton("user-check", `Beri role Dokter ke ${u.full_name}`, () => grantRole(u, reload)) : null)
        : iconButton("user-cog", `Cabut role ${u.full_name}`, () => revokeRole(u, reload)),
      u.status === "pending" && personRole === "doctor"
        ? iconButton("calendar", `Batalkan appointment aktif ${u.full_name}`, () => cancelDoctorAppointments(u, reload))
        : null,
      iconButton("trash-2", `Hapus profil ${u.full_name}`, () => deleteProfile(u, reload)),
    ]) } : null,
  ].filter(Boolean);
  table = dataTable({
    columns,
    rows: () => [...rows].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    // Cari hanya nama & wallet (sama dengan backend; telepon/alamat tidak bisa dicari).
    search: (u) => `${u.full_name} ${u.wallet ?? ""}`, // Admin: pasien tanpa wallet, dicari lewat nama
    filter: { label: "Jenis kelamin", options: GENDER, match: (u, v) => u.gender === v },
    empty: [`Belum ada data ${label.toLowerCase()}`, role === "doctor" ? "Pasien muncul setelah memberi Anda akses, biasanya saat membuat appointment." : isPatient ? "Pasien muncul setelah mendaftar lewat halaman login." : isAdmin ? `Klik "Tambah ${label}" untuk menambahkan.` : "Data akan muncul setelah Admin mendaftarkannya."],
    ...(isPatient ? { onRowClick: (u) => { location.hash = `#/patients/${u.key}`; }, rowLabel: (u) => `Buka detail pasien ${u.full_name}` } : {}),
  });
  // Pasien mendaftar sendiri (registerAsPatient), jadi Admin hanya bisa menambah Dokter.
  const add = isAdmin && !isPatient ? el("button", { type: "button", className: "btn", onclick: () => profileModal(null, personRole, reload) }, [renderIcon("plus"), `Tambah ${label}`]) : null;
  const subtitle = role === "doctor" ? "Hanya pasien yang memberi Anda akses. Klik baris untuk membuka rekam medisnya."
    : isPatient ? "Klik baris untuk membuka detail pasien." : "Data profil off-chain; role tercatat di kontrak. Status Pending = profil belum diberi role on-chain.";
  return page(card(role === "doctor" ? "Pasien Saya" : `Daftar ${label}`, subtitle, add, table));
}

function profileFields(u, showSpecialization) {
  return el("div", { className: "form-grid" }, [
    field({ name: "full_name", label: "Nama lengkap", required: true, value: u.full_name ?? "", attrs: { autocomplete: "name", maxlength: 100 } }),
    field({ name: "phone", label: "Telepon", type: "tel", required: true, value: u.phone ?? "", attrs: { autocomplete: "tel", inputmode: "tel", placeholder: "08…" } }),
    field({ name: "birth_date", label: "Tanggal lahir", type: "date", required: true, value: u.birth_date ?? "", attrs: { max: new Date().toISOString().slice(0, 10) } }),
    field({ name: "gender", label: "Jenis kelamin", type: "select", required: true, value: u.gender ?? "", options: [["", "Pilih…"], ...GENDER] }),
    field({ name: "address", label: "Alamat", type: "textarea", required: true, value: u.address ?? "", attrs: { maxlength: 255, rows: 2 } }),
    showSpecialization ? field({ name: "specialization", label: "Spesialisasi", required: true, value: u.specialization ?? "", attrs: { maxlength: 100 } }) : null,
  ]);
}

// Modal tambah Dokter / ubah profil oleh Admin. user = null berarti tambah baru.
async function profileModal(user, personRole, done) {
  if (!isAdmin) return toast("Hanya Admin yang dapat mengelola profil pengguna lain.", "error");
  const isNew = !user;
  // Data Admin tersamar: form edit butuh kontak lengkap lewat endpoint contact (tercatat di access_log).
  // Hanya disimpan di form ini; hilang saat modal ditutup.
  if (!isNew && user.masked) {
    try { user = { ...user, ...(await api.getContact(user.key)) }; }
    catch (err) { return toast(err.message || "Gagal memuat data kontak.", "error"); }
  }
  const needSpec = personRole === "doctor";
  const form = el("form", { novalidate: true }, [
    isNew ? field({ name: "wallet", label: "Alamat wallet", required: true, hint: "Wallet yang belum punya role. 0x diikuti 40 karakter heksadesimal.", attrs: { autocomplete: "off", spellcheck: "false" } }) : null,
    profileFields(user ?? {}, needSpec),
  ]);
  const save = el("button", { type: "submit", className: "btn" }, isNew ? "Simpan & kirim transaksi" : "Simpan");
  const box = el("div", { className: "progress-box" });
  form.append(box, el("div", { className: "form-actions" }, [el("button", { type: "button", className: "btn btn-secondary", onclick: () => close() }, "Batal"), save]));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (save.disabled) return; // anti klik ganda
    const d = formData(form);
    if (!showErrors(form, validateProfile(d, needSpec))) return;
    setLoading(save, true);
    try {
      if (isNew) {
        // 1. profil (pending) -> 2. grantRole(wallet, Doctor) di MetaMask -> 3. dicatat (grant_role).
        let show = null;
        const { tx } = await api.addStaff(d.wallet, d, { onStage: (ev) => { show ??= txProgress(box, "grantRole"); show(ev); } });
        await done();
        if (tx && tx.status !== "confirmed") {
          box.append(resultNote("warning", "triangle-alert", "Profil tersimpan sebagai Pending", "Role Dokter belum diberikan. Beri role lewat tombol di daftar Dokter."));
          setLoading(save, false);
          save.disabled = true;
          return;
        }
        close();
        toast(tx?.logError ? `Role diberikan on-chain, tetapi pencatatan gagal: ${tx.logError.message}` : `${PEOPLE[personRole]} terdaftar on-chain.`, tx?.logError ? "warning" : "success");
      } else {
        await api.updateUserProfile(user.key, d, needSpec);
        close();
        await done();
        toast("Profil diperbarui.", "success");
      }
    } catch (err) {
      setLoading(save, false);
      if (err.fields) showErrors(form, err.fields);
      toast(err.message || "Gagal menyimpan.", "error");
    }
  });
  const close = openModal({ title: isNew ? `Tambah ${PEOPLE[personRole]}` : "Ubah Profil", body: form });
}

// revokeRole (Admin). Untuk mengganti role: cabut dulu, lalu daftarkan lagi.
// Dokter: setelah tx terkonfirmasi, appointment aktifnya langsung dibatalkan agar kuota & slot pasien
// tidak terkunci. Gagal -> peringatan; Admin bisa mengulang lewat tombol di daftar Dokter.
// Pasien: Admin tidak memegang wallet pasien; wallet dibuka lewat resolve-wallet (alasan wajib, tercatat)
// tepat sebelum MetaMask, hanya sebagai variabel lokal transaksi.
function revokeRole(u, done) {
  if (!isAdmin) return toast("Hanya Admin yang dapat mengubah role.", "error");
  const isDoc = u.role === "doctor";
  const why = u.ref ? reasonField("Alasan mencabut role") : null;
  txModal({
    title: `Cabut role ${ROLE_LABEL[u.role]}?`,
    message: `${u.full_name} tidak lagi punya akses ${ROLE_LABEL[u.role]}. ${isDoc ? "Semua appointment aktifnya akan dibatalkan. " : ""}${why ? "Wallet pasien dibuka hanya untuk transaksi ini dan tercatat di log audit. " : ""}Untuk mengganti role, cabut dulu lalu daftarkan lagi. Transaksi revokeRole tercatat di blockchain.`,
    extra: why?.node,
    confirmText: "Cabut role", label: "revokeRole",
    run: async (onStage) => {
      if (why) return api.revokePatientRole(u.ref, why.value(), { onStage });
      const r = await api.revokeRole(u.wallet, { onStage });
      if (r.status === "confirmed" && isDoc) {
        try {
          const { cancelled } = await api.cancelDoctorAppointments(u.wallet);
          if (cancelled) toast(`${cancelled} appointment aktif ${u.full_name} dibatalkan.`, "info", 6000);
        } catch (err) {
          toast(`Role dicabut, tetapi pembatalan appointment gagal: ${err.message}. Ulangi lewat tombol kalender di daftar Dokter.`, "warning", 10000);
        }
      }
      return r;
    },
    successText: "Role dicabut.", done,
  });
}

// Admin: batalkan semua appointment aktif dokter yang role-nya sudah dicabut (server menolak 409 jika masih Doctor).
// Tanpa tx on-chain: backend mencari wallet dari key (wallet atau ref).
async function cancelDoctorAppointments(u, done) {
  if (!(await confirmDialog({ title: "Batalkan appointment aktif?", message: `Semua appointment aktif ${u.full_name} dibatalkan. Pasien melihatnya sebagai "Dibatalkan oleh Admin: dokter tidak lagi aktif", dan jatah/slotnya bebas kembali.`, confirmText: "Batalkan semua", danger: true }))) return;
  try {
    const { cancelled } = await api.cancelDoctorAppointments(u.key);
    toast(cancelled ? `${cancelled} appointment dibatalkan.` : "Tidak ada appointment aktif.", "success");
  } catch (err) { toast(err.message || "Gagal membatalkan.", "error"); }
  await done();
}
// grantRole Doctor untuk profil dokter yang masih Pending (wallet tanpa role).
// Kandidat yang pernah pasien (ref, tanpa wallet): wallet dibuka lewat resolve-wallet (alasan wajib, tercatat).
function grantRole(u, done) {
  if (!isAdmin) return toast("Hanya Admin yang dapat mengubah role.", "error");
  const why = u.ref ? reasonField("Alasan membuka wallet") : null;
  txModal({
    title: "Beri role Dokter?",
    message: `${u.full_name} akan diberi role Dokter di kontrak lewat transaksi grantRole. Hanya wallet tanpa role yang bisa diberi role.${why ? " Wallet ini pernah terdaftar sebagai pasien: wallet dibuka hanya untuk transaksi ini dan tercatat di log audit." : ""}`,
    extra: why?.node,
    confirmText: "Beri role", label: "grantRole", danger: false,
    run: (onStage) => (why ? api.grantDoctorRoleByRef(u.ref, why.value(), { onStage }) : api.grantDoctorRole(u.wallet, { onStage })),
    successText: `${u.full_name} kini Dokter on-chain.`, done,
  });
}

async function deleteProfile(u, done) {
  if (!isAdmin) return toast("Hanya Admin yang dapat menghapus profil pengguna lain.", "error");
  if (!(await confirmDialog({ title: "Hapus profil?", message: `Profil ${u.full_name} akan dihapus dari database. Role on-chain tidak berubah.`, confirmText: "Hapus", danger: true }))) return;
  try {
    await api.deleteProfile(u.key);
    await done();
    toast("Profil dihapus.", "success");
  } catch (err) { toast(err.message || "Gagal menghapus profil.", "error"); }
}

// Detail Pasien (#/patients/:wallet)
// Admin: parameter = ref "U-…" dari Data Pasien, profil tanpa wallet.
async function pagePatientDetail({ wallet }) {
  let p = null;
  // Dokter: status akses dari kontrak (GET /api/access/doctor): aktif / kedaluwarsa; dicabut = tidak ada di daftar.
  const access = isDoctor ? (await api.getDoctorAccess()).items.find((a) => a.patient_wallet === String(wallet).toLowerCase()) ?? null : null;
  try { p = await api.getUser(wallet); } catch (err) {
    // Dokter tanpa akses berlaku: tampilkan alasannya, tanpa data pasien sama sekali.
    if (err.code === "NO_ACCESS") {
      const expired = access?.status === "expired";
      return page(el("section", { className: "card" }, [
        emptyState(expired ? "Akses kedaluwarsa" : "Akses dicabut", expired
          ? `${accessDetail(access)}. Rekam medis dan profil pasien tidak bisa dibuka sampai pasien membuat atau mengonfirmasi appointment baru.`
          : "Pasien ini belum atau tidak lagi memberi Anda akses. Rekam medis dan profilnya tidak bisa dibuka sampai pasien memberi akses lagi.", "shield-alert"),
        el("div", { className: "empty-actions" }, [el("a", { href: "#/patients", className: "btn btn-secondary" }, [renderIcon("chevron-left"), "Kembali ke Pasien Saya"])]),
      ]));
    }
    /* alamat tidak valid / tidak boleh dibuka -> tidak ditemukan */
  }
  if (!p || p.role !== "patient") {
    return page(el("section", { className: "card" }, [
      emptyState("Pasien tidak ditemukan", "Alamat wallet tidak valid atau bukan milik pasien terdaftar.", "search"),
      el("div", { className: "empty-actions" }, [el("a", { href: "#/patients", className: "btn btn-secondary" }, [renderIcon("chevron-left"), "Kembali ke Data Pasien"])]),
    ]));
  }
  setTitle(p.full_name);

  const header = el("section", { className: "card card-pad detail-head" }, [
    el("nav", { className: "breadcrumb", "aria-label": "Breadcrumb" }, [
      el("a", { href: "#/patients" }, role === "doctor" ? "Pasien Saya" : "Data Pasien"),
      el("span", { "aria-hidden": "true" }, "›"),
      el("span", { "aria-current": "page" }, p.full_name),
    ]),
    el("div", { className: "detail-id" }, [
      avatar(p.full_name, "avatar-lg"),
      el("div", { className: "detail-main" }, [
        el("div", { className: "detail-title" }, [el("h2", {}, p.full_name), roleBadge(p.role)]),
        p.wallet ? el("div", { className: "wallet-inline" }, [addressNode(p.wallet), iconButton("copy", "Salin alamat wallet pasien", () => copyText(p.wallet, "Alamat wallet"))]) : null,
        el("dl", { className: "meta-row" }, [
          el("div", {}, [el("dt", {}, "Umur"), el("dd", {}, ageText(p))]),
          el("div", {}, [el("dt", {}, "Jenis kelamin"), el("dd", {}, genderLabel(p.gender))]),
          // Admin: telepon tetap tersamar di sini; data lengkap hanya lewat tombol Tampilkan di tab Profil.
          el("div", {}, [el("dt", {}, "Telepon"), el("dd", { className: p.masked ? "mono" : "" }, p.phone)]),
        ]),
        // Dokter: status akses + sisa waktu (remainingSeconds dari server, waktu blok) + lepas akses.
        access ? el("div", { className: "access-meta" }, [
          accessBadge(access.status),
          el("span", { className: "muted" }, accessDetail(access)),
          access.status === "active" ? el("button", { type: "button", className: "btn btn-ghost btn-sm text-danger", onclick: () => renounceModal(p.wallet, p.full_name, rerender) }, "Lepas akses") : null,
        ]) : null,
      ]),
    ]),
  ]);

  const items = [{ id: "profil", label: "Profil", render: () => profilePanel(p) }];
  // Tab Rekam Medis hanya untuk Doctor ber-akses. Admin tidak membaca isi rekam medis.
  if (isDoctor) {
    const table = await recordsTable(() => api.getRecords(p.wallet), `Belum ada rekam medis untuk ${p.full_name}.`);
    const add = role === "doctor"
      ? el("button", { type: "button", className: "btn", onclick: () => recordFormModal(null, { wallet: p.wallet, name: p.full_name }, table.reload) }, [renderIcon("plus"), "Tambah Rekam Medis"])
      : null;
    const panel = el("div", {}, [
      el("div", { className: "card-header" }, [el("div", {}, [el("h3", { className: "card-title" }, "Riwayat Rekam Medis"), el("p", { className: "card-subtitle" }, "Klik baris untuk melihat isi lengkap.")]), add]),
      table,
    ]);
    items.push({ id: "rekam", label: "Rekam Medis", render: () => panel });
  }
  return page(header, el("section", { className: "card" }, [tabs(items)]));
}

function profilePanel(p) {
  // Admin menerima data tersamar (p.masked). Kontak lengkap hanya dimuat saat "Tampilkan" diklik
  // (tercatat di access_log) dan hilang lagi saat pindah halaman karena halaman dirender ulang.
  const phone = el("span", { className: p.masked ? "mono" : "" }, p.phone);
  const address = el("span", {}, p.address || "-");
  const birth = el("span", {}, p.masked ? ageText(p) : `${formatDate(p.birth_date)} (${ageOf(p.birth_date)})`);
  const rows = [
    ["Nama lengkap", p.full_name],
    p.wallet ? ["Alamat wallet", copyable(checksumAddress(p.wallet), "Alamat wallet")] : null,
    ["Jenis kelamin", genderLabel(p.gender)],
    [p.masked ? "Umur" : "Tanggal lahir", birth], ["Telepon", phone], ["Alamat", address],
    ["Terdaftar", formatDate(p.created_at)], ["Terakhir diperbarui", formatDate(p.updated_at, true)],
  ].filter(Boolean);
  const list = el("dl", { className: "detail-list" }, rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, [v])]));
  const panel = el("div", { className: "card-pad" });

  if (p.masked) {
    const birthLabel = [...list.querySelectorAll("dt")].find((d) => d.textContent === "Umur");
    let shown = false;
    const reveal = el("button", { type: "button", className: "btn btn-secondary btn-sm", "aria-label": "Tampilkan kontak lengkap", "aria-pressed": "false" }, [renderIcon("eye"), "Tampilkan"]);
    reveal.addEventListener("click", async () => {
      if (shown) {
        phone.textContent = p.phone; address.textContent = p.address; birth.textContent = ageText(p); birthLabel.textContent = "Umur";
        reveal.replaceChildren(renderIcon("eye"), "Tampilkan");
        reveal.setAttribute("aria-label", "Tampilkan kontak lengkap");
      } else {
        setLoading(reveal, true);
        let c;
        try { c = await api.getContact(p.key); } catch (err) { setLoading(reveal, false); return toast(err.message || "Gagal memuat kontak.", "error"); }
        setLoading(reveal, false);
        phone.textContent = c.phone; address.textContent = c.address;
        birth.textContent = `${formatDate(c.birth_date)} (${ageOf(c.birth_date)})`; birthLabel.textContent = "Tanggal lahir";
        reveal.replaceChildren(renderIcon("eye-off"), "Sembunyikan");
        reveal.setAttribute("aria-label", "Sembunyikan kontak lengkap");
      }
      shown = !shown;
      reveal.setAttribute("aria-pressed", String(shown));
    });
    panel.append(el("div", { className: "masked-note" }, [
      renderIcon("shield-check"),
      el("p", {}, "Telepon dan alamat disamarkan. Membuka data lengkap dicatat di log akses."),
      reveal,
    ]));
  }
  panel.append(list);
  if (isAdmin) {
    panel.append(el("div", { className: "form-actions panel-actions" }, [
      el("button", { type: "button", className: "btn btn-secondary", onclick: () => profileModal(p, "patient", rerender) }, [renderIcon("pencil"), "Ubah profil"]),
    ]));
  }
  return panel;
}

// Rekam Medis Saya (Patient, read-only)
async function pageMyRecords() {
  const records = await api.getMyRecords();
  const status = el("span", {}, "Belum diperiksa");
  const header = el("section", { className: "card card-pad records-head" }, [
    summaryRow([
      ["Jumlah rekam medis", String(records.length)],
      ["Terakhir", records[0] ? formatDate(records[0].created_at) : "—"],
      ["Status verifikasi", status],
    ]),
    verifyAllBox(records, (res) => {
      status.textContent = `${res.ok}/${res.total} terverifikasi`;
      status.className = res.ok === res.total ? "text-success" : "text-danger";
    }),
  ]);
  const table = await recordsTable(() => api.getMyRecords(), "Rekam medis akan muncul setelah dibuat dokter.", records);
  return page(header, card("Daftar Rekam Medis", "Klik baris untuk melihat isi lengkap dan Blockchain Proof.", null, table));
}

// Riwayat Aktivitas Blockchain
function activityFeed(list) {
  if (!list.length) return emptyState("Belum ada aktivitas", "");
  return el("ul", { className: "feed" }, list.map((e) => el("li", { className: "feed-item" }, [
    eventIcon(e),
    el("div", {}, [
      el("p", {}, [el("strong", {}, activityInfo(e).label), eventSummary(e) ? ` · ${eventSummary(e)}` : ""]),
      el("p", { className: "muted" }, [`${e.actorName} · `, timeNode(e.timestamp)]),
    ]),
  ])));
}

const RANGES = [["", "Semua waktu"], ["1", "24 jam terakhir"], ["7", "7 hari terakhir"], ["30", "30 hari terakhir"]];

async function pageActivity() {
  let all = await api.getActivity();
  const f = { event: "", range: "", address: "" };
  const error = el("p", { className: "field-error filter-error", id: "flt-error", role: "alert" });

  const rows = () => all.filter((e) => {
    const addr = f.address.toLowerCase();
    return (!f.event || e.event === f.event)
      && (!f.range || withinDays(e.timestamp, Number(f.range)))
      && (!addr || [e.actor, ...Object.values(e.args)].some((v) => typeof v === "string" && v.toLowerCase().includes(addr)));
  });

  const table = dataTable({
    columns: [
      { label: "Aktivitas", render: eventCell },
      { label: "Pengirim", render: (e) => personCell(e.actorName, e.actor) },
      { label: "Tx hash", render: (e) => hashCell(e.txHash) },
      { label: "Block", render: (e) => e.blockNumber ? el("span", { className: "mono" }, `#${e.blockNumber}`) : el("span", { className: "muted" }, "—") },
      { label: "Waktu", render: (e) => timeNode(e.timestamp) },
      { label: "Status", render: (e) => statusIcon(e.status) },
    ],
    rows,
    pageSize: 8,
    empty: ["Belum ada aktivitas", ""],
    onRowClick: activityModal,
    rowLabel: (e) => `Detail transaksi: ${activityInfo(e).label} ${eventSummary(e)}`,
  });

  // Validasi filter alamat: hanya 0x + heksadesimal.
  function apply() {
    const bad = f.address && !/^(0x)?[0-9a-f]{1,40}$/i.test(f.address);
    error.textContent = bad ? "Alamat hanya boleh berisi 0x dan karakter heksadesimal (0-9, a-f)." : "";
    addrInput.setAttribute("aria-invalid", String(Boolean(bad)));
    if (!bad) table.refresh();
  }

  // Chip jenis aktivitas: radio button asli (aksesibel tanpa JS tambahan).
  const chips = el("fieldset", { className: "segmented" }, [
    el("legend", { className: "sr-only" }, "Jenis aktivitas"),
    ...[["", "Semua"], ...Object.entries(EVENTS).map(([k, v]) => [k, v.label])].map(([value, text]) => {
      const input = el("input", { type: "radio", name: "flt-event", value, className: "sr-only", onchange: () => { f.event = value; apply(); } });
      input.checked = value === "";
      return el("label", { className: "chip-option" }, [input, el("span", {}, text)]);
    }),
  ]);
  const rangeSel = el("select", { id: "flt-range", className: "select", onchange: (e) => { f.range = e.target.value; apply(); } },
    RANGES.map(([v, t]) => el("option", { value: v }, t)));
  const addrInput = el("input", { id: "flt-addr", type: "search", className: "input mono", placeholder: "0x…", autocomplete: "off", spellcheck: "false", "aria-describedby": "flt-error",
    oninput: (e) => { f.address = e.target.value.trim(); apply(); } });
  const reset = el("button", { type: "button", className: "btn btn-ghost", onclick: () => {
    Object.assign(f, { event: "", range: "", address: "" });
    chips.querySelector('input[value=""]').checked = true;
    rangeSel.value = "";
    addrInput.value = "";
    apply();
  } }, "Reset");
  const control = (id, label, node) => el("div", { className: "field filter-field" }, [el("label", { className: "label", for: id }, label), node]);
  const refresh = el("button", { type: "button", className: "btn btn-secondary btn-sm", onclick: async () => {
    setLoading(refresh, true);
    try { all = await api.getActivity(); table.refresh(); } catch (err) { toast(err.message, "error"); }
    setLoading(refresh, false);
  } }, [renderIcon("history"), "Muat ulang"]);

  const toolbar = el("div", { className: "activity-filters" }, [
    chips,
    el("div", { className: "filter-bar" }, [control("flt-range", "Rentang waktu", rangeSel), control("flt-addr", "Alamat wallet", addrInput), reset]),
    error,
  ]);
  const subtitle = isAdmin ? "Semua event kontrak + transaksi aplikasi yang masih pending atau gagal (semua pengguna)."
    : "Event kontrak & transaksi pending/gagal yang melibatkan wallet Anda.";
  return page(card("Transaksi", subtitle, refresh, el("div", {}, [toolbar, table])));
}

// Modal detail transaksi: semua nilai panjang bisa disalin.
function activityModal(e) {
  const named = (addr) => el("span", { className: "addr-value" }, [el("span", { className: "addr-name" }, e.names?.[addr] ?? ""), copyable(addr, "Alamat")]);
  const value = (v) => isAddr(v) ? named(v) : isHash(v) ? copyable(v, "Hash") : el("span", { className: "mono" }, String(v));
  const kv = (rows) => el("table", { className: "kv" }, [el("tbody", {}, rows.map(([k, v]) => el("tr", {}, [el("th", { scope: "row" }, k), el("td", {}, [v ?? el("span", { className: "muted" }, "—")])])))]);
  const info = activityInfo(e);
  const body = el("div", { className: "record-detail" }, [
    kv([
      ["Status", statusBadge(e.status)],
      ["Tx hash", copyable(e.txHash, "Tx hash")],
      ["Block", e.blockNumber ? el("span", { className: "mono" }, String(e.blockNumber)) : el("span", { className: "muted" }, "Belum masuk block")],
      ["Waktu", el("span", {}, [formatDate(e.timestamp, true), el("span", { className: "muted" }, ` (${timeAgo(e.timestamp)})`)])],
      ["From", named(e.from)],
      ["To", named(e.to)],
      ["Keterangan", e.error ? el("span", {}, e.error) : null],
    ]),
    el("section", { className: "proof", "aria-labelledby": "event-title" }, [
      el("div", { className: "proof-head" }, [el("h3", { id: "event-title" }, [renderIcon(info.icon), info.label]), el("span", { className: "mono muted" }, e.event ?? e.action)]),
      kv(Object.entries(e.args).map(([k, v]) => [el("span", { className: "mono" }, k), k === "role" || k === "previousRole" ? el("span", {}, [roleBadge(roleFromEnum(v)), el("span", { className: "mono muted" }, ` ${v}`)])
        // Masa berlaku akses (detik Unix waktu blok) ditampilkan dalam WIB + nilai mentahnya.
        : /expiresAt$/i.test(k) ? el("span", {}, [formatDate(new Date(Number(v) * 1000), true), el("span", { className: "mono muted" }, ` (${v})`)])
        : value(v)])),
    ]),
  ]);
  openModal({ title: "Detail Transaksi", body, wide: true });
}

// Profil (milik sendiri, semua role)
async function pageProfile() {
  const u = await api.getMyProfile();
  const needSpec = isDoctor;
  if (!u && role !== "patient") {
    return page(card("Profil", null, null, emptyState("Profil belum ada", "Hubungi Admin untuk membuat profil Anda.", "user")));
  }

  // Kartu profil
  const nameEl = el("h2", { className: "profile-name" }, u?.full_name ?? "Profil belum lengkap");
  const avatarBox = el("span", {}, [avatar(u?.full_name ?? "?", "avatar-xl")]);
  const head = el("section", { className: "card card-pad profile-hero" }, [
    avatarBox,
    el("div", { className: "profile-main" }, [
      el("div", { className: "detail-title" }, [nameEl, roleBadge(role)]),
      el("div", { className: "wallet-inline" }, [addressNode(me), iconButton("copy", "Salin alamat wallet", () => copyText(me, "Alamat wallet"))]),
      el("p", { className: "muted profile-joined" }, u ? `Bergabung ${formatDate(u.created_at)}` : "Lengkapi data diri di bawah ini."),
    ]),
  ]);

  // Form edit profil sendiri. Wallet & role read-only.
  const identity = el("dl", { className: "detail-list identity" }, [
    el("dt", {}, "Alamat wallet"), el("dd", {}, [copyable(me, "Alamat wallet")]),
    el("dt", {}, "Role"), el("dd", {}, [roleBadge(role)]),
  ]);
  const save = el("button", { type: "submit", className: "btn", disabled: true }, "Simpan perubahan");
  const form = el("form", { novalidate: true, className: "card-pad" }, [profileFields(u ?? {}, needSpec)]);
  let original = JSON.stringify(formData(form));
  const touched = new Set();
  // Validasi inline: pesan muncul untuk field yang sudah disentuh; tombol aktif hanya jika ada perubahan.
  function check() {
    const d = formData(form);
    if (!needSpec) d.specialization = "";
    const errors = validateProfile(d, needSpec);
    form.querySelectorAll(".field").forEach((fEl) => {
      const c = fEl.querySelector("input, select, textarea");
      if (!c || !touched.has(c.name)) return;
      const msg = errors[c.name] ?? "";
      fEl.classList.toggle("has-error", Boolean(msg));
      c.setAttribute("aria-invalid", msg ? "true" : "false");
      fEl.querySelector(".field-error").textContent = msg;
    });
    save.disabled = JSON.stringify(formData(form)) === original;
    return errors;
  }
  form.addEventListener("input", (e) => { if (e.target.name) touched.add(e.target.name); check(); });
  form.addEventListener("focusout", (e) => { if (e.target.name) { touched.add(e.target.name); check(); } });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(form);
    if (!showErrors(form, check())) return;
    setLoading(save, true);
    try {
      const saved = await api.saveProfile(d);
      myProfile = saved;
      original = JSON.stringify(formData(form));
      nameEl.textContent = saved.full_name;
      avatarBox.replaceChildren(avatar(saved.full_name, "avatar-xl"));
      renderUserCard();
      toast("Profil disimpan.", "success");
    } catch (err) {
      if (err.fields) showErrors(form, err.fields);
      toast(err.message || "Gagal menyimpan profil.", "error");
    } finally {
      setLoading(save, false);
      save.disabled = JSON.stringify(formData(form)) === original;
    }
  });
  // Patient boleh menghapus profilnya sendiri (CRUD profil miliknya).
  const del = role === "patient" && u ? el("button", { type: "button", className: "btn btn-ghost text-danger", onclick: async () => {
    if (!(await confirmDialog({ title: "Hapus profil saya?", message: "Data profil di database akan dihapus. Rekam medis on-chain tidak terhapus.", confirmText: "Hapus profil", danger: true }))) return;
    try { await api.deleteProfile(me); myProfile = null; toast("Profil dihapus.", "success"); renderUserCard(); rerender(); }
    catch (err) { toast(err.message || "Gagal menghapus profil.", "error"); }
  } }, [renderIcon("trash-2"), "Hapus profil"]) : null;
  form.append(el("div", { className: "form-actions" }, [del, save]));

  const editCard = el("section", { className: "card" }, [
    el("div", { className: "card-header" }, [el("div", {}, [el("h2", { className: "card-title" }, "Data diri"), el("p", { className: "card-subtitle" }, u ? `Terakhir diperbarui ${formatDate(u.updated_at)}.` : "Data disimpan di database, bukan di blockchain.")])]),
    el("div", { className: "card-pad identity-wrap" }, [identity, el("p", { className: "field-hint identity-note" }, [renderIcon("shield-check"), "Wallet dan role diatur oleh smart contract dan tidak bisa diubah di sini."])]),
    form,
  ]);

  // Sesi
  const sessionCard = card("Sesi", null, null, el("div", { className: "card-pad session" }, [
    summaryRow([
      ["Network", el("span", { className: "net-chip" }, `${api.NETWORK.name} · ${api.NETWORK.chainId}`)],
      ["Waktu login", el("span", {}, [formatDate(session.loginAt, true), el("span", { className: "muted" }, ` · ${timeAgo(session.loginAt)}`)])],
    ]),
    el("button", { type: "button", className: "btn btn-secondary", onclick: logout }, [renderIcon("log-out"), "Keluar"]),
  ]));
  return page(head, editCard, sessionCard);
}

// Daftar route
// Menu per role:
//   Patient: Dashboard, Appointment, Rekam Medis Saya, Resep Digital, Akses Dokter, Riwayat Aktivitas, Profil
//   Doctor : Dashboard, Appointment, Pasien Saya, Riwayat Aktivitas, Profil
//   Admin  : Dashboard, Data Pasien, Data Dokter, Akses Dokter, Riwayat Aktivitas, Profil
const STAFF = ["admin", "doctor"];
const ALL = ["admin", "doctor", "patient"];
const ROUTES = [
  { path: "/dashboard",        title: "Dashboard",         sub: "Ringkasan hari ini.",                      icon: "layout-dashboard", group: "main",       roles: ALL,                            render: pageDashboard },
  { path: "/appointments",     title: "Appointment",       sub: "Jadwal konsultasi pasien dan dokter.",     icon: "calendar",         group: "main",       roles: ["patient", "doctor"],          render: pageAppointments },
  { path: "/patients",         title: "Data Pasien",       sub: "Profil pasien terdaftar.",                 icon: "users",            group: "main",       roles: ["admin"],                      render: () => pagePeople("patient") },
  { path: "/patients",         title: "Pasien Saya",       sub: "Pasien dengan akses yang masih berlaku.",          icon: "users",            group: "main",       roles: ["doctor"],                     render: () => pagePeople("patient") },
  { path: "/patients/:wallet", title: "Detail Pasien",     sub: "Profil dan rekam medis pasien.",           icon: "user",             group: "main",       roles: STAFF, menu: false, parent: "/patients", render: pagePatientDetail },
  { path: "/doctors",          title: "Data Dokter",       sub: "Dokter yang diberi role oleh Admin.",      icon: "stethoscope",      group: "main",       roles: ["admin"],                      render: () => pagePeople("doctor") },
  { path: "/my-records",       title: "Rekam Medis Saya",  sub: "Riwayat pemeriksaan dan verifikasi data.", icon: "file-text",        group: "main",       roles: ["patient"],                    render: pageMyRecords },
  { path: "/prescriptions",    title: "Resep Digital",     sub: "Resep dari rekam medis Anda.",             icon: "pill",             group: "main",       roles: ["patient"],                    render: pagePrescriptions },
  { path: "/access",           title: "Akses Dokter",      sub: "Izin dokter membuka rekam medis (on-chain).", icon: "shield-check",  group: "blockchain", roles: ["patient", "admin"],           render: pageAccess },
  { path: "/activity",         title: "Riwayat Aktivitas", sub: "Transaksi ke kontrak HospitalRecords.",    icon: "history",          group: "blockchain", roles: ["admin", "doctor", "patient"], render: pageActivity },
  { path: "/profile",          title: "Profil",            sub: "Data diri dan identitas wallet.",          icon: "user",             group: "account",    roles: ALL,                            render: pageProfile },
];

// Kerangka: topbar, drawer, menu akun
const $ = (id) => document.getElementById(id);
const app = $("app"), content = $("content"), nav = $("nav");
let current = null; // { route, params }

function setTitle(text, sub) {
  $("page-title").textContent = text;
  if (sub !== undefined) $("page-sub").textContent = sub;
  document.title = `${text} · BioCare`;
}
async function logout() { await api.authLogout(); location.replace("index.html"); }

// Loading (skeleton) -> konten, atau error state dengan tombol coba lagi.
async function render(route, params) {
  const ticket = (current = { route, params });
  setTitle(route.title, route.sub);
  content.replaceChildren(el("div", { className: "card", "aria-busy": "true" }, [skeletonRows(4)]));
  try {
    const node = await route.render(params);
    if (current !== ticket) return; // user sudah pindah halaman
    content.replaceChildren(node);
  } catch (err) {
    if (current !== ticket) return;
    console.error(err);
    content.replaceChildren(el("div", { className: "card" }, [
      emptyState("Gagal memuat halaman", err instanceof api.ApiError ? err.message : "Terjadi kesalahan. Coba lagi.", "circle-alert"),
      el("div", { className: "empty-actions" }, [el("button", { type: "button", className: "btn btn-secondary", onclick: rerender }, "Coba lagi")]),
    ]));
  }
}
function rerender() { return current && render(current.route, current.params); }

function setDrawer(open) {
  app.classList.toggle("drawer-open", open);
  app.querySelector(".main").inert = open; // fokus tidak bisa lari ke konten di balik overlay
  $("drawer-open").setAttribute("aria-expanded", String(open));
  if (open) nav.querySelector(".nav-link")?.focus();
}

const displayName = () => myProfile?.full_name ?? ROLE_LABEL[role];
function renderUserCard() {
  $("user-card").replaceChildren(avatar(displayName()), el("div", { className: "user-card-main" }, [el("span", { className: "user-card-name", title: displayName() }, displayName()), roleBadge(role)]));
  $("account-btn").replaceChildren(avatar(displayName()), renderIcon("chevron-right"));
  $("account-name").textContent = displayName();
}

// Menu akun: tombol avatar -> daftar Profil & Keluar. Esc / klik di luar menutup.
function setupAccountMenu() {
  const btn = $("account-btn"), menu = $("account-menu");
  // Pola disclosure (tombol + daftar biasa), bukan role="menu" yang butuh navigasi panah.
  menu.append(
    el("div", { className: "account-head" }, [
      el("p", { id: "account-name" }),
      el("p", { className: "muted mono" }, shortAddress(me)),
      el("p", { className: "muted" }, `${api.NETWORK.name} · ${api.NETWORK.chainId}`),
    ]),
    el("a", { className: "menu-item", href: "#/profile" }, [renderIcon("user"), "Profil"]),
    el("button", { type: "button", className: "menu-item danger", onclick: logout }, [renderIcon("log-out"), "Keluar"]),
  );
  const toggle = (open) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector(".menu-item").focus();
  };
  btn.addEventListener("click", () => toggle(menu.hidden));
  menu.addEventListener("click", (e) => { if (e.target.closest(".menu-item")) toggle(false); });
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest(".account")) toggle(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { toggle(false); btn.focus(); } });
}

async function start() {
  hydrateIcons();
  $("network-chip").textContent = `${api.NETWORK.name} · ${api.NETWORK.chainId}`;
  $("wallet-short").textContent = shortAddress(me);
  $("wallet-short").title = me;
  $("copy-wallet").addEventListener("click", () => copyText(me, "Alamat wallet"));
  setupAccountMenu();
  // Akun/network MetaMask berganti -> sesi ini bukan milik wallet aktif lagi: logout + ke login.
  // (akun terkunci -> [] -> juga logout; pindah ke chain yang sama tidak.)
  window.ethereum?.on?.("accountsChanged", (accounts) => { if (String(accounts?.[0] ?? "").toLowerCase() !== authed.address) logout(); });
  window.ethereum?.on?.("chainChanged", (chainId) => { if (Number(chainId) !== api.NETWORK.chainId) logout(); });
  try { myProfile = await api.getMyProfile(); } catch { myProfile = null; }
  renderUserCard();

  $("drawer-open").addEventListener("click", () => setDrawer(true));
  $("drawer-close").addEventListener("click", () => { setDrawer(false); $("drawer-open").focus(); });
  $("drawer-backdrop").addEventListener("click", () => setDrawer(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && app.classList.contains("drawer-open")) { setDrawer(false); $("drawer-open").focus(); } });

  // MetaMask harus di chainId 31337 dan kontrak ada di alamatnya. Gagal -> layar error yang
  // jelas (bukan halaman kosong); tanpa ini semua transaksi akan gagal.
  const provider = getBrowserProvider();
  const chain = provider ? await checkContractDeployed(provider) : { ok: false, message: "MetaMask tidak ditemukan. Pasang ekstensi MetaMask, lalu muat ulang halaman." };
  if (!chain.ok) {
    setTitle("Blockchain belum siap", "");
    content.replaceChildren(el("div", { className: "card", role: "alert" }, [
      emptyState("Blockchain lokal belum siap", chain.message, "circle-alert"),
      el("div", { className: "empty-actions" }, [
        el("button", { type: "button", className: "btn", onclick: () => location.reload() }, "Muat ulang"),
        el("button", { type: "button", className: "btn btn-secondary", onclick: logout }, "Keluar"),
      ]),
    ]));
    return;
  }

  const allowed = routesFor(ROUTES, role);
  renderMenu(nav, allowed);
  hydrateIcons(nav);
  startRouter({ routes: allowed, navEl: nav, onRoute: (r, params) => { setDrawer(false); render(r, params); } });
}

if (role && role !== "unregistered") start();
