// records-view.js — komponen rekam medis yang dipakai ulang di:
//   - Detail Pasien (Doctor dengan akses berlaku)
//   - Rekam Medis Saya & Dashboard (Patient)
// Isi: tabel, modal detail + Blockchain Proof + Verifikasi Integritas,
// form Doctor, dan "Verifikasi Semua". Semua data lewat api.js.
// Hak tombol mengikuti role, tetapi penegakan sebenarnya di kontrak & backend.
import * as api from "./api.js";
import { getSession } from "./session.js";
import {
  el, renderIcon, iconButton, formatDate, statusBadge, toast, openModal,
  field, showErrors, setLoading, dataTable, rowActions, formData, personCell, copyText, txProgress, txModal, resultNote, hashCell,
} from "./ui.js";

const session = getSession();
const role = session?.role;
const me = session?.wallet;
const truncate = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Integritas
// Status awal = hasil verifikasi backend saat data dimuat (api.js: integrity); tombol Verifikasi
// memeriksa ulang DI BROWSER (api.verifyInBrowser: hash dihitung hash.js, hash on-chain dibaca langsung
// dari kontrak lewat MetaMask). State: "ok" | "bad" | "deleted" | "none".
export const integrityOf = (r) => r.integrity ?? "none";
export function integrityBadge(state) {
  const s = typeof state === "string" ? state : integrityOf(state);
  if (s === "none") return el("span", { className: "badge badge-unregistered" }, "Belum tercatat");
  if (s === "deleted") return el("span", { className: "badge badge-unregistered" }, "Dihapus on-chain");
  return s === "ok"
    ? el("span", { className: "verify verify-ok" }, [renderIcon("badge-check"), "Terverifikasi"])
    : el("span", { className: "verify verify-bad" }, [renderIcon("shield-alert"), "Data tidak cocok"]);
}

// Tabel
// load: async () => daftar rekam medis; initial: data yang sudah dimuat (opsional).
// Mengembalikan elemen tabel dengan .reload().
export async function recordsTable(load, emptyText = "", initial) {
  let rows = initial ?? await load();
  let table;
  const reload = async () => { rows = await load(); table.refresh(); };
  table = dataTable({
    columns: [
      { label: "Tanggal", render: (r) => formatDate(r.created_at) },
      { label: "Diagnosis", render: (r) => truncate(r.diagnosis) },
      { label: "Dokter", render: (r) => r.doctorName },
      { label: "Status blockchain", render: (r) => statusBadge(r.status) },
      { label: "Integritas", render: (r) => integrityBadge(r) },
      // Kolom aksi hanya untuk Doctor, dan tombol hanya pada rekam medis buatannya.
      role === "doctor" ? { label: el("span", { className: "sr-only" }, "Aksi"), render: (r) =>
        r.doctor === me ? rowActions([
          iconButton("pencil", `Ubah rekam medis #${r.id}`, () => recordFormModal(r, { wallet: r.patient, name: r.patientName }, reload)),
          iconButton("trash-2", `Hapus rekam medis #${r.id}`, () => deleteRecord(r, reload)),
        ]) : el("span", { className: "muted", title: "Bukan rekam medis buatan Anda" }, "—") } : null,
    ].filter(Boolean),
    rows: () => rows,
    search: (r) => `${r.diagnosis} ${r.doctorName}`,
    filter: { label: "Status", options: [["confirmed", "Confirmed"], ["pending", "Pending"], ["failed", "Failed"]], match: (r, v) => r.status === v },
    empty: ["Belum ada rekam medis", emptyText],
    onRowClick: (r) => recordDetailModal(r),
    rowLabel: (r) => `Lihat rekam medis #${r.id}, ${formatDate(r.created_at)}`,
  });
  table.reload = reload;
  return table;
}

// Nilai panjang (hash/alamat) lengkap + tombol salin.
export const copyable = (value, label) => value
  ? el("span", { className: "copyable" }, [el("span", { className: "mono break" }, value), iconButton("copy", `Salin ${label.toLowerCase()}`, () => copyText(value, label))])
  : null;

// Resep (tampilan)
// Dipakai detail rekam medis (dokter & pasien), Resep Digital, dan cetak resep. Data user hanya lewat textContent.
// Satuan = satu baris; racikan = satu blok: nama + bentuk & jumlah, bahan menjorok, lalu aturan pakai & durasi.
const usage = (p) => [p.signa, p.duration && `selama ${p.duration}`, p.instructions].filter(Boolean).join(" · ");
export function rxList(items) {
  if (!items?.length) return el("p", { className: "muted" }, "Tidak ada resep pada rekam medis ini.");
  return el("ol", { className: "rx-list" }, items.map((p) => p.type === "compound"
    ? el("li", { className: "rx-item rx-compound" }, [
        el("p", { className: "rx-line" }, [
          el("span", { className: "rx-name" }, p.name),
          el("span", { className: "badge badge-info rx-kind" }, "Racikan"),
          el("span", { className: "rx-qty" }, `${p.form} · ${p.quantity} ${p.unit}`),
        ]),
        el("ul", { className: "rx-ingredients", "aria-label": `Bahan ${p.name}` }, (p.ingredients ?? []).map((g) =>
          el("li", {}, [el("span", {}, g.name), el("span", { className: "muted" }, ` · ${g.strength} · ${g.amount}`)]))),
        el("p", { className: "rx-usage" }, usage(p)),
      ])
    : el("li", { className: "rx-item" }, [
        el("p", { className: "rx-line" }, [
          el("span", { className: "rx-name" }, [p.name, p.strength].filter(Boolean).join(" ")),
          el("span", { className: "rx-qty" }, `${p.form} · ${p.quantity} ${p.unit}`),
          el("span", { className: "rx-usage" }, usage(p)),
        ]),
      ])));
}

// Modal detail + Blockchain Proof
const ACTION_LABEL = { create: "dibuat", update: "diubah", delete: "dihapus" };
const VERIFY_TEXT = { ok: "Cocok", bad: "Tidak cocok", deleted: "Dihapus on-chain", none: "Belum tercatat on-chain" };
export async function recordDetailModal(item) {
  let r;
  try { r = await api.getRecord(item.id); } catch (err) { return toast(err.message || "Gagal memuat rekam medis.", "error"); }
  const result = el("div", { className: "verify-result", "aria-live": "polite" }, [integrityBadge(r)]);
  // Verifikasi DI BROWSER, per versi: "" = versi yang berlaku (getRecord kontrak); angka = hash di event tx versi itu.
  const versions = (r.versions ?? []).filter((v) => v.status === "confirmed");
  const versionSel = el("select", { id: "verify-version", className: "select" }, [
    el("option", { value: "" }, "Versi yang berlaku (dibaca dari kontrak)"),
    ...versions.map((v) => el("option", { value: String(v.version_no) }, `Versi ${v.version_no} · ${ACTION_LABEL[v.action]} · ${formatDate(v.created_at)}`)),
  ]);
  const hashes = el("dl", { className: "detail-list", hidden: true });
  const verify = el("button", { type: "button", className: "btn btn-secondary", disabled: !versions.length }, [renderIcon("shield-check"), "Verifikasi"]);
  verify.addEventListener("click", async () => {
    setLoading(verify, true);
    try {
      const v = await api.verifyInBrowser(r, versionSel.value ? Number(versionSel.value) : null);
      result.replaceChildren(integrityBadge(v.state));
      hashes.replaceChildren(
        ...row("Hasil", el("span", {}, [el("strong", {}, VERIFY_TEXT[v.state]), v.reason ? el("span", { className: "muted" }, ` · ${v.reason}`) : null])),
        ...row("Hash dihitung browser", hashCell(v.localHash, "Hash lokal")),
        ...row("Hash on-chain", hashCell(v.chainHash, "Hash on-chain")),
      );
      hashes.hidden = false;
      const okText = v.state === "ok";
      toast(okText ? `Rekam medis #${r.id}: cocok dengan blockchain.` : `Rekam medis #${r.id}: ${VERIFY_TEXT[v.state].toLowerCase()}.`, okText ? "success" : v.state === "bad" ? "error" : "info");
    } catch (err) {
      toast(err.message || "Gagal memverifikasi. Coba lagi.", "error");
    } finally { setLoading(verify, false); }
  });
  const row = (k, v) => [el("dt", {}, k), el("dd", {}, v ?? "—")];
  const body = el("div", { className: "record-detail" }, [
    el("dl", { className: "detail-list" }, [
      ...row("Pasien", r.patientName),
      ...row("Dokter", r.doctorName),
      ...row("Tanggal", formatDate(r.created_at, true)),
      ...row("Diagnosis", r.diagnosis),
      ...row("Tindakan", r.treatment),
      ...row("Catatan", r.notes || "-"),
    ]),
    el("section", { className: "rx-section", "aria-labelledby": "rx-title" }, [
      el("div", { className: "rx-section-head" }, [
        el("h3", { id: "rx-title", className: "section-title" }, [renderIcon("pill"), `Resep (${r.prescriptions?.length ?? 0} obat)`]),
        // Resep ikut di-hash bersama rekam medis -> status integritasnya = status rekam medis ini.
        integrityBadge(r),
      ]),
      rxList(r.prescriptions),
    ]),
    el("section", { className: "proof", "aria-labelledby": "proof-title" }, [
      el("div", { className: "proof-head" }, [el("h3", { id: "proof-title" }, [renderIcon("shield-check"), "Blockchain Proof"]), statusBadge(r.status)]),
      el("dl", { className: "detail-list" }, [
        ...row("Record ID", el("span", { className: "mono" }, `#${r.id}${r.onchainId ? ` · on-chain #${r.onchainId}` : ""}`)),
        ...row("Versi", r.version ? el("span", { className: "mono" }, String(r.version)) : null),
        ...row("Data hash", copyable(r.chainHash, "Data hash")),
        ...row("Tx hash", copyable(r.tx, "Tx hash")),
        ...row("Waktu", r.chainHash ? formatDate(r.updated_at, true) : null),
      ]),
      hashes,
      el("div", { className: "proof-foot" }, [
        result,
        el("div", { className: "field filter-field" }, [el("label", { className: "label", for: "verify-version" }, "Versi yang diverifikasi"), versionSel]),
        verify,
      ]),
    ]),
  ]);
  openModal({ title: `Rekam Medis #${r.id}`, body, wide: true });
}

// Verifikasi Semua
// Memeriksa rekam medis satu per satu dengan progres. onDone(hasil) dipanggil di akhir.
export function verifyAllBox(records, onDone) {
  const bar = el("progress", { className: "progress", max: Math.max(1, records.length), value: 0, hidden: true, "aria-label": "Progres verifikasi" });
  const text = el("p", { className: "verify-result", "aria-live": "polite" },
    records.length ? "Bandingkan data di database dengan hash di blockchain." : "Belum ada rekam medis untuk diverifikasi.");
  const btn = el("button", { type: "button", className: "btn", disabled: !records.length }, [renderIcon("shield-check"), "Verifikasi Semua"]);
  btn.addEventListener("click", async () => {
    setLoading(btn, true);
    bar.hidden = false;
    const res = { ok: 0, bad: 0, deleted: 0, none: 0, error: 0, total: records.length };
    for (const [i, r] of records.entries()) {
      text.textContent = `Memeriksa ${i + 1} dari ${records.length}…`;
      try { res[await api.verifyRecord(r.id)]++; } catch { res.error++; }
      bar.value = i + 1;
    }
    const parts = [`${res.ok}/${res.total} terverifikasi`];
    if (res.bad) parts.push(`${res.bad} data tidak cocok`);
    if (res.deleted) parts.push(`${res.deleted} dihapus on-chain`);
    if (res.none) parts.push(`${res.none} belum tercatat on-chain`);
    if (res.error) parts.push(`${res.error} gagal diperiksa`);
    text.textContent = parts.join(" · ");
    setLoading(btn, false);
    bar.hidden = true;
    toast(res.bad ? "Ada rekam medis yang datanya tidak cocok dengan blockchain." : "Pemeriksaan integritas selesai.", res.bad ? "error" : "success");
    onDone?.(res);
  });
  return el("div", { className: "verify-all" }, [el("div", { className: "verify-all-main" }, [text, bar]), btn]);
}

// Form tambah/ubah (Doctor)
// patient = { wallet, name }. Pasien otomatis = pasien yang sedang dibuka.
// Resep = daftar KARTU; satu kartu = SATU item resep, bertipe Satuan atau Racikan (segmented control).
// Racikan = satu sediaan dari 2–10 bahan -> SATU objek { type: "compound", ..., ingredients: [...] },
// bukan beberapa obat satuan. Bahan diisi di DALAM kartu racikannya.
// Nama input = kunci error backend (prescriptions.<i>.<field>, prescriptions.<i>.ingredients.<j>.<field>),
// jadi pesan dari validator lokal maupun server tampil di field yang sama. Batas panjang/angka
// diambil dari api.js (cermin backend/lib/validate.js), bukan ditulis ulang di sini.
const LIMIT = { ...Object.fromEntries(api.RX_ITEM.map(([k, min, max]) => [k, [min, max]])), quantity: [1, api.RX_QTY_MAX] };
const INGR_LIMIT = Object.fromEntries(api.RX_INGR.map(([k, min, max]) => [k, [min, max]]));
// Placeholder diawali "mis." agar contoh tidak terbaca sebagai nilai yang sudah terisi.
const SINGLE_FIELDS = [
  ["name", "Nama obat", "mis. Parasetamol"], ["strength", "Kekuatan", "mis. 500 mg"], ["form", "Bentuk sediaan", "mis. tablet"],
  ["quantity", "Jumlah", "mis. 10"], ["unit", "Satuan", "mis. tablet"], ["signa", "Aturan pakai", "mis. 3x1 tablet"],
  ["duration", "Durasi", "mis. 5 hari"], ["instructions", "Instruksi", "mis. Sesudah makan"],
];
const COMPOUND_FIELDS = [
  ["name", "Nama racikan", "mis. Puyer batuk anak"], ["form", "Bentuk sediaan", "mis. puyer"],
  ["quantity", "Jumlah sediaan", "mis. 10"], ["unit", "Satuan", "mis. bungkus"], ["signa", "Aturan pakai", "mis. 3x1 bungkus"],
  ["duration", "Durasi", "mis. 3 hari"], ["instructions", "Instruksi", "mis. sesudah makan"],
];
const INGR_FIELDS = [["name", "Nama bahan", "mis. Parasetamol"], ["strength", "Kekuatan", "mis. 250 mg"], ["amount", "Jumlah per sediaan", "mis. 1/2 tablet"]];
const FORM_HINTS = ["tablet", "kaplet", "kapsul", "sirup", "puyer", "salep", "krim", "tetes", "inhaler", "injeksi"];
const blankIngr = () => ({ name: "", strength: "", amount: "" });
const blankItem = (type = "single") => ({ type, name: "", strength: "", form: "", quantity: "", unit: "", signa: "", duration: "", instructions: "",
  ingredients: type === "compound" ? [blankIngr(), blankIngr()] : [] });
// "Racikan: 3 bahan → 10 bungkus puyer, 3x1 bungkus sesudah makan, selama 3 hari"
const compoundSummary = (p) => `Racikan: ${p.ingredients.length} bahan → ${p.quantity || "…"} ${p.unit || "…"} ${p.form || "…"}`
  + `${p.signa ? `, ${p.signa}` : ""}${p.instructions ? ` ${p.instructions}` : ""}${p.duration ? `, selama ${p.duration}` : ""}`;

// Satu input resep. required/maxlength/min/max dari batas validator.
function rxInput(name, key, label, ph, value, [min, max], dataKey) {
  const num = key === "quantity";
  const f = field({ name, label, required: num || min > 0, type: num ? "number" : "text", value: value ?? "",
    attrs: num ? { min: 1, max: api.RX_QTY_MAX, step: 1, inputmode: "numeric", placeholder: ph }
      : { maxlength: max, placeholder: ph, autocomplete: "off", ...(key === "form" ? { list: "rx-form-hints" } : {}) } });
  f.querySelector("input").dataset[dataKey] = key;
  f.classList.add(`rx-f-${key}`);
  return f;
}

export async function recordFormModal(rec, patient, onChange) {
  if (role !== "doctor") return toast("Hanya Doctor yang dapat menulis rekam medis.", "error");
  const isNew = !rec;
  if (!isNew && rec.doctor !== me) return toast("Anda hanya bisa mengubah rekam medis buatan sendiri.", "error");
  // Ubah: isi + resep yang berlaku diambil dari API (daftar tidak memuat resep).
  if (!isNew) {
    try { rec = await api.getRecord(rec.id); } catch (err) { return toast(err.message || "Gagal memuat rekam medis.", "error"); }
  }

  // meta per kartu (kunci uid, stabil walau kartu diurutkan ulang):
  //   stash  = bahan racikan yang disimpan sementara saat tipe diganti ke Satuan (bisa dikembalikan);
  //   cStrength = kekuatan racikan lama dari data (tidak ada di form, dipertahankan agar edit tidak mengubahnya).
  let uidSeq = 0;
  const meta = new Map();
  const rxRows = el("div", { className: "rx-rows" });
  const rxMsg = el("p", { className: "field-hint", "aria-live": "polite" });
  const rxErr = el("p", { className: "field-error", dataset: { err: "prescriptions" }, tabIndex: -1 });
  const addRx = el("button", { type: "button", className: "btn btn-secondary btn-sm", onclick: () => {
    const list = readRx();
    drawRx([...list, blankItem()]);
    cardAt(list.length)?.querySelector(".rx-type input:checked")?.focus();
  } }, [renderIcon("plus"), "Tambah obat"]);

  const cardAt = (i) => rxRows.children[i];
  // Baca satu kartu dari DOM. quantity: angka bulat jika valid; selain itu teks apa adanya agar validator menolak.
  function readCard(card) {
    const val = (k) => card.querySelector(`[data-item="${k}"]`)?.value.trim() ?? "";
    const type = card.querySelector(".rx-type input:checked")?.value ?? "single";
    const q = val("quantity");
    return {
      uid: card.dataset.uid, type, name: val("name"),
      strength: type === "compound" ? meta.get(card.dataset.uid)?.cStrength ?? null : val("strength"),
      form: val("form"), quantity: /^\d{1,15}$/.test(q) ? Number(q) : q, unit: val("unit"), signa: val("signa"),
      duration: val("duration"), instructions: val("instructions"),
      ingredients: [...card.querySelectorAll(".ingr-row")].map((row) =>
        Object.fromEntries([...row.querySelectorAll("input")].map((c) => [c.dataset.ingr, c.value.trim()]))),
    };
  }
  const readRx = () => [...rxRows.children].map(readCard);
  // Bentuk yang dikirim ke API: tanpa uid; satuan selalu tanpa bahan.
  const toPayload = ({ uid, ...p }) => ({ ...p, ingredients: p.type === "compound" ? p.ingredients : [] });

  // aksi struktur: baca DOM -> ubah daftar -> gambar ulang (nomor, name, id & label selalu urut)
  function setType(i, type) {
    const list = readRx();
    const p = list[i];
    const m = meta.get(p.uid);
    if (type === "single") { m.stash = p.ingredients; p.ingredients = []; }
    else {
      p.ingredients = m.stash?.length ? m.stash : [];
      while (p.ingredients.length < api.RX_INGR_MIN) p.ingredients.push(blankIngr()); // racikan baru: otomatis 2 baris bahan
    }
    p.type = type;
    drawRx(list);
    cardAt(i).querySelector(`.rx-type input[value="${type}"]`).focus();
  }
  function move(i, d) {
    const list = readRx();
    [list[i], list[i + d]] = [list[i + d], list[i]];
    drawRx(list);
    const tools = cardAt(i + d).querySelectorAll(".rx-tools .btn");
    (d < 0 ? (tools[0].disabled ? tools[1] : tools[0]) : (tools[1].disabled ? tools[0] : tools[1])).focus();
  }
  function removeItem(i) {
    const list = readRx().filter((_, j) => j !== i);
    drawRx(list);
    (cardAt(Math.min(i, list.length - 1))?.querySelector(".rx-type input:checked") ?? addRx).focus();
  }
  function addIngr(i) {
    const list = readRx();
    list[i].ingredients.push(blankIngr());
    drawRx(list);
    [...cardAt(i).querySelectorAll(".ingr-row")].at(-1).querySelector("input").focus();
  }
  function removeIngr(i, j) {
    const list = readRx();
    list[i].ingredients.splice(j, 1);
    drawRx(list);
    const rows = cardAt(i).querySelectorAll(".ingr-row");
    (rows[Math.min(j, rows.length - 1)]?.querySelector("input") ?? cardAt(i).querySelector(".ingr-add")).focus();
  }

  function ingrSection(p, i, at) {
    const n = p.ingredients.length;
    const full = n >= api.RX_INGR_MAX;
    const rows = p.ingredients.map((g, j) => el("div", { className: "ingr-row" }, [
      ...INGR_FIELDS.map(([k, label, ph]) => rxInput(`${at}.ingredients.${j}.${k}`, k,
        el("span", {}, [label, el("span", { className: "sr-only" }, ` bahan ${j + 1}`)]), ph, g[k], INGR_LIMIT[k], "ingr")),
      // Minimal 2 bahan: tombol hapus nonaktif agar racikan tidak pernah kurang dari batas.
      el("button", { type: "button", className: "btn btn-icon btn-sm btn-ghost ingr-del", "aria-label": `Hapus bahan ${j + 1} dari obat ${i + 1}`,
        title: n <= api.RX_INGR_MIN ? `Racikan minimal ${api.RX_INGR_MIN} bahan` : "Hapus bahan", disabled: n <= api.RX_INGR_MIN, onclick: () => removeIngr(i, j) }, [renderIcon("trash-2")]),
    ]));
    return el("fieldset", { className: "rx-sub" }, [
      el("legend", { className: "rx-sub-title" }, `Bahan (${n} dari maks. ${api.RX_INGR_MAX})`),
      el("div", { className: "ingr-rows" }, rows),
      el("p", { className: "field-error", dataset: { err: `${at}.ingredients` }, tabIndex: -1 }),
      el("div", { className: "ingr-foot" }, [
        el("button", { type: "button", className: "btn btn-secondary btn-sm ingr-add", disabled: full, onclick: () => addIngr(i),
          "aria-describedby": `${at}-ingr-hint` }, [renderIcon("plus"), "Tambah bahan"]),
        el("p", { className: "field-hint", id: `${at}-ingr-hint` }, full
          ? `Maksimal ${api.RX_INGR_MAX} bahan per racikan.`
          : `Kekuatan tiap bahan wajib diisi. Minimal ${api.RX_INGR_MIN}, maksimal ${api.RX_INGR_MAX} bahan.`),
      ]),
    ]);
  }

  function rxCard(p, i, total) {
    const at = `prescriptions.${i}`;
    const uid = p.uid ?? String(++uidSeq);
    if (!meta.has(uid)) meta.set(uid, { stash: null, cStrength: p.type === "compound" ? p.strength ?? null : null });
    const compound = p.type === "compound";
    const typeSwitch = el("fieldset", { className: "segmented rx-type" }, [
      el("legend", { className: "sr-only" }, `Jenis obat ${i + 1}`),
      ...[["single", "Satuan"], ["compound", "Racikan"]].map(([v, t]) => {
        const input = el("input", { type: "radio", name: `${at}.type`, value: v, className: "sr-only", onchange: () => setType(i, v) });
        input.checked = p.type === v;
        return el("label", { className: "chip-option" }, [input, el("span", {}, t)]);
      }),
    ]);
    const tools = el("div", { className: "rx-tools" }, [
      el("button", { type: "button", className: "btn btn-icon btn-sm btn-ghost", "aria-label": `Pindahkan obat ${i + 1} ke atas`, title: "Naikkan", disabled: i === 0, onclick: () => move(i, -1) }, [renderIcon("arrow-up")]),
      el("button", { type: "button", className: "btn btn-icon btn-sm btn-ghost", "aria-label": `Pindahkan obat ${i + 1} ke bawah`, title: "Turunkan", disabled: i === total - 1, onclick: () => move(i, 1) }, [renderIcon("arrow-down")]),
      iconButton("trash-2", `Hapus obat ${i + 1}`, () => removeItem(i)),
    ]);
    const item = (fields) => fields.map(([k, label, ph]) => rxInput(`${at}.${k}`, k, label, ph, p[k], LIMIT[k], "item"));
    const summary = el("p", { className: "rx-summary", "aria-live": "polite" });
    const card = el("fieldset", { className: `rx-row${compound ? " is-compound" : ""}`, dataset: { uid } }, [
      el("legend", { className: "rx-legend" }, `Obat ${i + 1} · ${compound ? "Racikan" : "Satuan"}`),
      el("div", { className: "rx-head" }, [typeSwitch, tools]),
      el("p", { className: "field-error", dataset: { err: `${at}.type` } }),
      compound
        ? el("div", { className: "rx-compound-body" }, [
            ingrSection(p, i, at),
            el("fieldset", { className: "rx-sub" }, [
              el("legend", { className: "rx-sub-title" }, "Sediaan"),
              el("div", { className: "rx-fields" }, item(COMPOUND_FIELDS)),
            ]),
            summary,
          ])
        : el("div", { className: "rx-fields" }, item(SINGLE_FIELDS)),
    ]);
    if (compound) {
      const update = () => { summary.textContent = compoundSummary(readCard(card)); };
      card.addEventListener("input", update);
      update();
    }
    return card;
  }

  function drawRx(list) {
    rxRows.replaceChildren(...list.map((p, i) => rxCard(p, i, list.length)));
    addRx.disabled = list.length >= api.RX_MAX;
    rxMsg.textContent = list.length >= api.RX_MAX ? `Maksimal ${api.RX_MAX} obat per rekam medis.`
      : list.length ? `${list.length} obat. Resep ikut di-hash bersama rekam medis.` : "Belum ada obat. Resep opsional.";
  }
  drawRx(structuredClone(rec?.prescriptions ?? []));

  const form = el("form", { novalidate: true }, [
    el("div", { className: "field" }, [el("span", { className: "label" }, "Pasien"), personCell(patient.name, patient.wallet)]),
    field({ name: "diagnosis", label: "Diagnosis", required: true, value: rec?.diagnosis ?? "", attrs: { maxlength: 200 } }),
    field({ name: "treatment", label: "Tindakan", type: "textarea", required: true, value: rec?.treatment ?? "", attrs: { maxlength: 500, rows: 3 } }),
    field({ name: "notes", label: "Catatan", type: "textarea", value: rec?.notes ?? "", hint: "Opsional.", attrs: { maxlength: 1000, rows: 2 } }),
    el("section", { className: "rx-section", "aria-labelledby": "rx-form-title" }, [
      el("h3", { id: "rx-form-title", className: "section-title" }, [renderIcon("pill"), "Resep"]),
      rxRows,
      el("div", { className: "rx-add" }, [addRx, rxMsg]),
      rxErr,
      el("datalist", { id: "rx-form-hints" }, FORM_HINTS.map((v) => el("option", { value: v }))),
    ]),
    el("p", { className: "field-hint" }, "Detail disimpan di database. Yang dikirim ke blockchain hanya hash-nya."),
  ]);
  // Error per field lewat showErrors; error kelompok (jumlah bahan, jenis, jumlah obat) ke elemen data-err.
  function showAllErrors(errors) {
    form.querySelectorAll("[data-err]").forEach((p) => { p.textContent = errors[p.dataset.err] ?? ""; });
    const fieldsOk = showErrors(form, errors);
    if (fieldsOk) form.querySelector("[data-err]:not(:empty)")?.focus();
    return fieldsOk && !form.querySelector("[data-err]:not(:empty)");
  }
  const save = el("button", { type: "submit", className: "btn" }, isNew ? "Simpan & kirim transaksi" : "Simpan perubahan");
  const cancel = el("button", { type: "button", className: "btn btn-secondary", onclick: () => close() }, "Batal");
  const box = el("div", { className: "progress-box" });
  form.append(box, el("div", { className: "form-actions" }, [cancel, save]));
  // draft ke backend -> hash dihitung ulang & dicocokkan (api.saveRecord) -> MetaMask -> confirm / fail.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (save.disabled) return; // anti klik ganda selama proses
    const { diagnosis, treatment, notes } = formData(form);
    const d = { diagnosis, treatment, notes, prescriptions: readRx().map(toPayload) };
    if (!showAllErrors(api.validateRecord(d))) return;
    setLoading(save, true);
    cancel.disabled = true;
    box.replaceChildren();
    let show = null;
    const onStage = (ev) => { show ??= txProgress(box, isNew ? "addRecord" : "updateRecord"); show(ev); };
    try {
      const r = await api.saveRecord(isNew ? null : rec, patient.wallet, d, { onStage });
      if (r.status === "confirmed") {
        close();
        if (r.logError) toast(`Tercatat di blockchain, tetapi pencatatan aplikasi gagal: ${r.logError.message}`, "warning", 8000);
        else toast(`Rekam medis #${r.recordId} terkonfirmasi on-chain.`, "success");
      }
    } catch (err) {
      if (err.fields) showAllErrors(err.fields); // server tetap penentu
      box.replaceChildren(resultNote("danger", "circle-alert", "Rekam medis tidak disimpan", err.message || "Coba lagi."));
    }
    setLoading(save, false);
    cancel.disabled = false;
    await onChange();
  });
  const close = openModal({ title: isNew ? "Tambah Rekam Medis" : `Ubah Rekam Medis #${rec.id}`, body: form, wide: true });
}

// Soft delete: DELETE (versi pending) -> MetaMask deleteRecord -> confirm / fail.
function deleteRecord(r, onChange) {
  if (role !== "doctor" || r.doctor !== me) return toast("Anda hanya bisa menghapus rekam medis buatan sendiri.", "error");
  txModal({
    title: `Hapus rekam medis #${r.id}?`,
    message: "Rekam medis ditandai terhapus (soft delete) di kontrak lewat transaksi deleteRecord. Riwayatnya tetap tercatat.",
    confirmText: "Hapus", label: "deleteRecord",
    run: (onStage) => api.deleteRecord(r, { onStage }),
    successText: `Rekam medis #${r.id} dihapus.`, done: onChange,
  });
}
