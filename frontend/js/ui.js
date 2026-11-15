// ui.js — helper UI. ATURAN: data user hanya lewat textContent / createElement,
// tidak pernah innerHTML, supaya aman dari XSS.
import { ROLE_LABEL } from "./session.js";

// Pembuat elemen
// el("button", { className: "btn", type: "button", onclick }, ["Teks", node])
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "className" || k === "textContent" || k === "value" || k === "checked") node[k] = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    // Lewat CSSOM, bukan atribut style: CSP style-src 'self' memblokir atribut style inline.
    else if (k === "style") node.style.cssText = String(v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c))); // string = teks biasa
  }
  return node;
}

// Ikon
// Ikon dekoratif disembunyikan dari pembaca layar; label ada di tombol (aria-label).
export function renderIcon(name, className = "") {
  const span = el("span", { className: `icon ${className}`.trim(), "aria-hidden": "true" });
  setIcon(span, name);
  return span;
}
function setIcon(span, name) {
  if (!/^[a-z0-9-]+$/.test(name)) return; // nama ikon hanya dari kode kita, tetap dicek
  const url = `url("vendor/icons/${name}.svg")`;
  span.style.maskImage = url;
  span.style.webkitMaskImage = url;
}
// Isi semua <span data-icon="..."> yang ditulis langsung di HTML.
export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((s) => {
    s.classList.add("icon");
    s.setAttribute("aria-hidden", "true");
    setIcon(s, s.dataset.icon);
  });
}

// Tombol ikon saja: aria-label WAJIB karena tidak ada teks terlihat.
export function iconButton(icon, label, onclick, variant = "btn-ghost") {
  return el("button", { type: "button", className: `btn btn-icon btn-sm ${variant}`, "aria-label": label, title: label, onclick }, [renderIcon(icon)]);
}

// Format
// 0x1234a8…d6ab. Alamat lengkap tetap ditaruh di atribut title.
export function shortAddress(addr, head = 6, tail = 4) {
  if (typeof addr !== "string" || addr.length <= head + tail) return addr ?? "-";
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
export function addressNode(addr) {
  return el("span", { className: "mono", title: addr }, shortAddress(addr));
}
// Semua tanggal & jam ditampilkan dalam WIB (Asia/Jakarta), tidak bergantung zona waktu browser.
const dateFmt = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function formatDate(value, withTime = false) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return withTime ? `${dateTimeFmt.format(d)} WIB` : dateFmt.format(d);
}

// Waktu relatif: "5 menit yang lalu", "kemarin".
const relFmt = new Intl.RelativeTimeFormat("id-ID", { numeric: "auto" });
export function timeAgo(value) {
  const sec = (new Date(value).getTime() - Date.now()) / 1000;
  if (Number.isNaN(sec)) return "-";
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(sec) >= size) return relFmt.format(Math.round(sec / size), unit);
  }
  return "baru saja";
}

// Badge
// Role tak dikenal (null / nilai enum di luar 0..3) -> "Tidak dikenal", tidak pernah dianggap role lain.
export const roleBadge = (role) => ROLE_LABEL[role]
  ? el("span", { className: `badge badge-${role}` }, ROLE_LABEL[role])
  : el("span", { className: "badge badge-unregistered" }, "Tidak dikenal");
const STATUS_LABEL = { confirmed: "Confirmed", pending: "Pending", failed: "Failed" };
export const statusBadge = (s) => el("span", { className: `badge badge-${s}` }, STATUS_LABEL[s] ?? s);

// Toast
const TOAST_ICON = { success: "circle-check", error: "circle-alert", warning: "triangle-alert", info: "info" };
export function toast(message, type = "info", ms = 4000) {
  let region = document.getElementById("toast-region");
  if (!region) {
    // role="status" + aria-live agar pesan dibacakan pembaca layar
    region = el("div", { id: "toast-region", className: "toast-region", role: "status", "aria-live": "polite" });
    document.body.append(region);
  }
  const item = el("div", { className: `toast toast-${type}` }, [renderIcon(TOAST_ICON[type] ?? "info"), el("p", { className: "toast-msg" }, message)]);
  item.append(iconButton("x", "Tutup notifikasi", () => item.remove()));
  region.append(item);
  setTimeout(() => item.remove(), ms);
}

// Modal
// openModal({ title, body: Node, footer: [Node] }) -> fungsi close()
// sheet: true -> di layar kecil muncul dari bawah (bottom sheet).
export function openModal({ title, body, footer = [], onClose, wide = false, sheet = false }) {
  const opener = document.activeElement;
  const titleId = `modal-title-${Date.now()}`;
  const dialog = el("div", { className: `modal${wide ? " modal-wide" : ""}${sheet ? " modal-sheet" : ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId }, [
    el("div", { className: "modal-header" }, [
      el("h2", { className: "modal-title", id: titleId }, title),
      iconButton("x", "Tutup dialog", () => close()),
    ]),
    el("div", { className: "modal-body" }, [body]),
    footer.length ? el("div", { className: "modal-footer form-actions" }, footer) : null,
  ]);
  const backdrop = el("div", { className: "modal-backdrop" }, [dialog]);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });

  // Jaga fokus tetap di dalam modal (focus trap sederhana) + Esc untuk menutup.
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const f = [...dialog.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((n) => !n.disabled);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);
  (dialog.querySelector("input, select, textarea") ?? dialog.querySelector(".modal-footer .btn:last-child") ?? dialog.querySelector("button"))?.focus();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    opener?.focus?.();
    onClose?.();
  }
  return close;
}

// Konfirmasi: menghasilkan Promise<boolean>.
export function confirmDialog({ title, message, confirmText = "Ya, lanjutkan", danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const cancel = el("button", { type: "button", className: "btn btn-secondary", onclick: () => close() }, "Batal");
    const ok = el("button", { type: "button", className: `btn ${danger ? "btn-danger" : ""}`, onclick: () => { answer = true; close(); } }, confirmText);
    const close = openModal({ title, body: el("p", {}, message), footer: [cancel, ok], onClose: () => resolve(answer) });
  });
}

// Form
// field({ name, label, type, options, required, value, hint }) -> elemen .field
export function field({ name, label, type = "text", options, required = false, value = "", hint, attrs = {} }) {
  const id = `f-${name}`;
  let control;
  if (type === "select") {
    control = el("select", { id, name, className: "select", required, ...attrs },
      options.map(([v, t]) => el("option", { value: v }, t)));
    control.value = value;
  } else if (type === "textarea") {
    control = el("textarea", { id, name, className: "textarea", required, ...attrs });
    control.value = value;
  } else {
    control = el("input", { id, name, type, className: "input", required, ...attrs });
    control.value = value;
  }
  const errId = `${id}-error`;
  control.setAttribute("aria-describedby", errId);
  return el("div", { className: "field" }, [
    el("label", { className: "label", for: id }, [label, required ? el("span", { className: "req", "aria-hidden": "true" }, "*") : null]),
    control,
    hint ? el("p", { className: "field-hint" }, hint) : null,
    el("p", { className: "field-error", id: errId }),
  ]);
}

// Tampilkan pesan error per field; errors = { namaField: "pesan" }.
export function showErrors(form, errors) {
  form.querySelectorAll(".field").forEach((f) => {
    const control = f.querySelector("input, select, textarea");
    if (!control || !f.querySelector(".field-error")) return; // .field yang hanya menampilkan info
    const msg = errors[control.name] ?? "";
    f.classList.toggle("has-error", Boolean(msg));
    control?.setAttribute("aria-invalid", msg ? "true" : "false");
    f.querySelector(".field-error").textContent = msg;
  });
  const firstBad = form.querySelector(".has-error input, .has-error select, .has-error textarea");
  firstBad?.focus();
  return !firstBad;
}

// Progres transaksi MetaMask
// Catatan hasil di bawah langkah-langkah transaksi. tone: success | info | warning | danger.
export const resultNote = (tone, icon, title, text) => el("div", { className: `progress-result tone-${tone}`, ...(tone === "danger" ? { role: "alert" } : {}) },
  [renderIcon(icon), el("div", {}, [el("p", { className: "person-name" }, title), text ? el("p", {}, text) : null])]);

/**
 * Tampilkan tahap runTx (chain.js) di `box`: tanda tangan MetaMask -> konfirmasi block -> hasil.
 * Mengembalikan fungsi onStage untuk runTx. Ditolak pengguna = pilihan sah (info), bukan error.
 */
export function txProgress(box, label) {
  const step = (t) => el("li", { className: "progress-step" }, [el("span", { className: "progress-mark", "aria-hidden": "true" }), el("span", {}, t)]);
  const li = { sign: step(`Menunggu tanda tangan ${label} di MetaMask`), mine: step("Menunggu konfirmasi block") };
  const live = el("p", { className: "sr-only", "aria-live": "polite" });
  box.replaceChildren(el("ol", { className: "progress-steps" }, [li.sign, li.mine]), live);
  let cur = "sign";
  const mark = (k, st, say) => { li[k].className = `progress-step${st ? ` is-${st}` : ""}`; live.textContent = say; };
  return (ev) => {
    if (ev.stage === "awaiting_signature") mark("sign", "active", "Menunggu tanda tangan di MetaMask.");
    else if (ev.stage === "pending") { mark("sign", "done", ""); cur = "mine"; mark("mine", "active", "Transaksi dikirim. Menunggu konfirmasi block."); }
    else if (ev.stage === "confirmed") mark("mine", "done", "Transaksi berhasil.");
    else if (ev.stage === "rejected") {
      mark(cur, "", "Transaksi dibatalkan.");
      box.append(resultNote("info", "info", "Transaksi dibatalkan", "Anda menolak permintaan di MetaMask. Tidak ada yang berubah; Anda bisa mencoba lagi."));
    } else {
      mark(cur, "error", "Transaksi gagal.");
      box.append(resultNote("danger", "circle-alert", "Transaksi gagal", ev.message));
    }
  };
}

/**
 * Modal satu transaksi (cabut/lepas akses, cabut/beri role, hapus rekam medis):
 * konfirmasi -> run(onStage) -> hasil. run mengembalikan hasil runTx ({ status, logError? }) dan boleh
 * melempar ApiError (mis. ditolak backend sebelum tx dikirim). Tombol dikunci selama proses (anti klik ganda).
 */
// extra = node tambahan di bawah pesan (mis. reasonField().node); run boleh melempar Error -> ditampilkan + "Coba lagi".
export function txModal({ title, message, extra = null, confirmText, label, run, successText, done, danger = true }) {
  const box = el("div", { className: "progress-box" });
  const cancel = el("button", { type: "button", className: "btn btn-secondary", onclick: () => close() }, "Batal");
  const go = el("button", { type: "button", className: `btn${danger ? " btn-danger" : ""}` }, confirmText);
  go.addEventListener("click", async () => {
    setLoading(go, true);
    cancel.disabled = true;
    let r;
    try { r = await run(txProgress(box, label)); }
    catch (err) { r = { status: "error" }; box.replaceChildren(resultNote("danger", "circle-alert", "Gagal", err.message || "Coba lagi.")); }
    cancel.disabled = false;
    if (r.status !== "confirmed") { setLoading(go, false); go.textContent = "Coba lagi"; await done?.(); return; }
    box.append(r.logError
      ? resultNote("warning", "triangle-alert", "Tercatat di blockchain, pencatatan aplikasi gagal", r.logError.message)
      : resultNote("success", "circle-check", "Berhasil", successText));
    go.remove();
    cancel.textContent = "Tutup";
    cancel.focus();
    await done?.();
  });
  const close = openModal({ title, body: el("div", { className: "booking" }, [el("p", {}, message), extra, box]), footer: [cancel, go] });
}

// Alasan wajib Admin sebelum membuka wallet/nama pasien: 10–200 karakter; backend memvalidasi ulang & mencatatnya.
export function reasonField(label = "Alasan") {
  const node = field({ name: "reason", label, required: true, hint: "Wajib, 10–200 karakter. Dicatat permanen di log audit beserta waktu dan nama Anda.", attrs: { maxlength: 200, autocomplete: "off" } });
  const input = node.querySelector("input");
  return {
    node,
    value() {
      const v = input.value.trim();
      const n = [...v].length;
      if (n < 10 || n > 200) { input.focus(); throw new Error("Alasan wajib 10–200 karakter."); }
      return v;
    },
  };
}

// Ambil nilai form sebagai objek string yang sudah di-trim.
export const formData = (form) => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));

// Sel "orang": avatar + nama + alamat singkat.
// wallet kosong (pasien di tampilan Admin) -> tanpa baris alamat.
export function personCell(name, wallet) {
  return el("div", { className: "person" }, [avatar(name), el("div", {}, [el("div", { className: "person-name" }, name), wallet ? el("div", { className: "muted" }, [addressNode(wallet)]) : null])]);
}

// Hash panjang (tx/data): versi singkat + tooltip alamat lengkap + tombol salin.
export function hashCell(hash, label = "Tx hash") {
  if (!hash) return el("span", { className: "muted" }, "—");
  return el("span", { className: "hash-cell" }, [addressNode(hash), iconButton("copy", `Salin ${label.toLowerCase()}`, (e) => { e.stopPropagation(); copyText(hash, label); })]);
}

// Wadah tombol aksi di dalam baris yang bisa diklik: klik/keyboard tidak ikut membuka baris.
export function rowActions(buttons) {
  const stop = (e) => e.stopPropagation();
  return el("div", { className: "actions", onclick: stop, onkeydown: stop }, buttons);
}

// Avatar inisial nama (mis. "Sari Wulandari" -> "SW").
export function avatar(name, size = "") {
  const initials = String(name ?? "?").replace(/^(dr|drg)\.?\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  return el("span", { className: `avatar ${size}`.trim(), "aria-hidden": "true" }, initials);
}

// Salin teks ke clipboard + toast.
export async function copyText(text, label = "Teks") {
  try { await navigator.clipboard.writeText(text); toast(`${label} disalin.`, "success"); }
  catch { toast(`Gagal menyalin ${label.toLowerCase()}.`, "error"); }
}

// Tab yang aksesibel: tabs = [{ id, label, render() -> Node }]. Panah kiri/kanan untuk pindah tab.
// start: indeks tab awal (mis. tetap di tab yang sama setelah data dimuat ulang).
export function tabs(items, start = 0) {
  const list = el("div", { className: "tabs", role: "tablist" });
  const panel = el("div", { className: "tab-panel", role: "tabpanel", tabIndex: 0 });
  const buttons = items.map((t, i) => el("button", {
    type: "button", className: "tab", role: "tab", id: `tab-${t.id}`, "aria-controls": "tab-panel",
    onclick: () => select(i),
    onkeydown: (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) { e.preventDefault(); select((i + d + items.length) % items.length, true); }
    },
  }, t.label));
  panel.id = "tab-panel";
  list.append(...buttons);
  function select(i, focus = false) {
    buttons.forEach((b, j) => { b.setAttribute("aria-selected", String(i === j)); b.tabIndex = i === j ? 0 : -1; });
    panel.setAttribute("aria-labelledby", buttons[i].id);
    panel.replaceChildren(items[i].render());
    if (focus) buttons[i].focus();
  }
  select(Math.min(Math.max(0, start), items.length - 1));
  return el("div", {}, [list, panel]);
}

// Tombol dengan status loading (teks disembunyikan, spinner tampil).
export function setLoading(btn, loading) {
  btn.classList.toggle("is-loading", loading);
  btn.disabled = loading;
  btn.setAttribute("aria-busy", loading ? "true" : "false");
}

// Kerangka halaman
export const page = (...children) => el("div", { className: "page" }, children);
export const card = (title, subtitle, actions, body) => el("section", { className: "card" }, [
  el("div", { className: "card-header" }, [el("div", {}, [el("h2", { className: "card-title" }, title), subtitle ? el("p", { className: "card-subtitle" }, subtitle) : null]), actions]),
  body,
]);
// Waktu relatif dengan tooltip waktu absolut.
export const timeNode = (iso) => el("time", { datetime: iso, title: formatDate(iso, true) }, timeAgo(iso));

// Empty state & skeleton
export function emptyState(title, text, icon = "inbox") {
  return el("div", { className: "empty" }, [
    el("div", { className: "empty-icon" }, [renderIcon(icon)]),
    el("p", { className: "empty-title" }, title),
    text ? el("p", { className: "empty-text" }, text) : null,
  ]);
}
export function skeletonRows(n = 4) {
  return el("div", { className: "card-pad", "aria-busy": "true", "aria-label": "Memuat data" },
    Array.from({ length: n }, (_, i) => el("span", { className: "skeleton", style: `margin-bottom:12px;width:${90 - i * 12}%` })));
}

// Tabel aman (search, filter, pagination)
// columns: [{ key, label, render?(row) -> Node|string }]
// search: fungsi(row) -> teks yang dicari; filter: { label, options: [[nilai, teks]], match(row, nilai) }
// onRowClick(row) + rowLabel(row): seluruh baris bisa diklik / dibuka dengan Enter atau Space.
export function dataTable({ columns, rows, search, filter, pageSize = 5, empty = ["Belum ada data", ""], onRowClick, rowLabel }) {
  let page = 1, query = "", filterValue = "";
  const tbody = el("tbody");
  const info = el("span");
  const prev = iconButton("chevron-left", "Halaman sebelumnya", () => { page--; draw(); }, "btn-secondary");
  const next = iconButton("chevron-right", "Halaman berikutnya", () => { page++; draw(); }, "btn-secondary");
  const pageNo = el("span", { "aria-live": "polite" });
  const body = el("div");

  const toolbar = el("div", { className: "table-toolbar" });
  if (search) {
    const input = el("input", { type: "search", className: "input", placeholder: "Cari…", "aria-label": "Cari di tabel", oninput: (e) => { query = e.target.value.trim().toLowerCase(); page = 1; draw(); } });
    toolbar.append(el("div", { className: "search" }, [renderIcon("search"), input]));
  }
  if (filter) {
    const sel = el("select", { className: "select", "aria-label": filter.label, style: "width:auto", onchange: (e) => { filterValue = e.target.value; page = 1; draw(); } },
      [el("option", { value: "" }, `Semua ${filter.label.toLowerCase()}`), ...filter.options.map(([v, t]) => el("option", { value: v }, t))]);
    toolbar.append(sel);
  }

  const table = el("table", { className: "table" }, [
    el("thead", {}, [el("tr", {}, columns.map((c) => el("th", { scope: "col" }, c.label)))]),
    tbody,
  ]);
  const wrap = el("div", { className: "table-wrap" }, [table]);
  const pager = el("div", { className: "pagination" }, [info, el("div", { className: "pagination-controls" }, [prev, pageNo, next])]);

  function draw() {
    const list = (typeof rows === "function" ? rows() : rows).filter((r) =>
      (!query || search(r).toLowerCase().includes(query)) && (!filterValue || filter.match(r, filterValue)));
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const slice = list.slice((page - 1) * pageSize, page * pageSize);
    tbody.replaceChildren(...slice.map((r) => {
      // data-label dipakai CSS untuk menampilkan tabel sebagai kartu di layar < 640px
      const tr = el("tr", {}, columns.map((c) => el("td", { dataset: { label: typeof c.label === "string" ? c.label : "" } }, [c.render ? c.render(r) : String(r[c.key] ?? "-")])));
      if (onRowClick) {
        Object.assign(tr, { tabIndex: 0, className: "row-link" });
        tr.setAttribute("role", "link");
        if (rowLabel) tr.setAttribute("aria-label", rowLabel(r));
        tr.addEventListener("click", () => onRowClick(r));
        tr.addEventListener("keydown", (e) => {
          if (e.target !== tr) return; // Enter pada tombol di dalam baris bukan untuk baris
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(r); }
        });
      }
      return tr;
    }));
    if (!list.length) body.replaceChildren(emptyState(empty[0], query || filterValue ? "Coba ubah kata kunci atau filter." : empty[1]));
    else body.replaceChildren(wrap, pager);
    info.textContent = list.length ? `Menampilkan ${(page - 1) * pageSize + 1}–${(page - 1) * pageSize + slice.length} dari ${list.length}` : "";
    pageNo.textContent = `${page} / ${pages}`;
    prev.disabled = page <= 1;
    next.disabled = page >= pages;
  }
  draw();
  const root = el("div", {}, [toolbar.childElementCount ? toolbar : null, body]);
  root.refresh = draw; // dipanggil setelah data dimuat ulang
  return root;
}
