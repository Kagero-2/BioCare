// login.js — alur masuk ASLI dengan MetaMask + backend:
//   1. Connect: eth_requestAccounts, lalu pastikan network Hardhat Local (chainId 31337)
//      (wallet_switchEthereumChain; jika belum ada di MetaMask -> wallet_addEthereumChain).
//   2. Sign: pesan SIWE (EIP-4361) DIBUAT SERVER -> personal_sign (tanpa gas) -> server memverifikasi
//      & membaca role dari kontrak -> cookie sesi HttpOnly (JWT).
//   3. Wallet tanpa role (403 NO_ROLE) -> registerAsPatient() via MetaMask -> tunggu receipt ->
//      tanda tangan ulang -> login -> form profil pasien (POST /api/users/register).
// Frontend hanya mengatur tampilan: keamanan ditegakkan backend & kontrak.
import { BrowserProvider } from "../vendor/ethers.min.js";
import * as api from "./api.js";
import { ROLE_LABEL } from "./session.js";
import { CHAIN_ID, CHAIN_NAME, RPC_URL, checkContractDeployed } from "./config.js";
import { runTx, isRejected } from "./chain.js";
import { el, renderIcon, hydrateIcons, shortAddress, roleBadge, copyText, formData } from "./ui.js";
import { validateProfile } from "./validation.js";

hydrateIcons();
const $ = (id) => document.getElementById(id);
const stage = $("stage");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const METAMASK_URL = "https://metamask.io/download/";
const CHAIN_HEX = `0x${CHAIN_ID.toString(16)}`; // 31337 -> 0x7a69
const eth = window.ethereum; // disuntikkan MetaMask; undefined jika belum terpasang

// State halaman login. regTx = tx registerAsPatient yang belum dicatat ke tx_log (butuh sesi dulu).
const s = { wallet: null, role: null, regTx: null };

// Utilitas tampilan
// Ganti isi panggung dengan crossfade + perubahan tinggi yang mulus.
function show(view, focusEl) {
  const from = stage.offsetHeight;
  stage.replaceChildren(view);
  if (from === 0) return; // tampilan pertama: jangan rebut fokus saat halaman baru dibuka
  if (!reduceMotion.matches) {
    const to = stage.offsetHeight;
    view.classList.add("enter");
    if (from !== to) {
      stage.classList.add("is-animating");
      stage.style.height = `${from}px`;
      void stage.offsetHeight; // paksa reflow agar transisi berjalan
      stage.style.height = `${to}px`;
      setTimeout(() => { stage.style.height = ""; stage.classList.remove("is-animating"); }, 380);
    }
  }
  (focusEl ?? view.querySelector(".cta"))?.focus({ preventScroll: true });
}
const announce = (msg) => { $("announce").textContent = msg; };

// Sorot langkah aktif: 0 Connect, 1 Sign, 2 Masuk.
function setStep(i) {
  document.querySelectorAll(".step").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("is-done", n < i);
    if (n === i) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
}

const view = (children) => el("div", { className: "view" }, children);
function cta(label, icon, onclick) {
  return el("button", { type: "button", className: "cta", onclick }, [icon ? renderIcon(icon) : null, label]);
}
const ghost = (label, onclick) => el("button", { type: "button", className: "ghost", onclick }, label);
// Status loading tombol: spinner + teks "Menunggu MetaMask…".
function busy(btn, text = "Menunggu MetaMask…") {
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.replaceChildren(el("span", { className: "spinner", "aria-hidden": "true" }), text);
}

// Baris info: wallet (singkat + salin), network, role.
function infoRows({ withRole }) {
  const rows = [
    ["Wallet", [
      el("span", { className: "mono", title: s.wallet }, shortAddress(s.wallet)),
      el("button", { type: "button", className: "copy-btn", "aria-label": "Salin alamat wallet", title: "Salin alamat wallet", onclick: () => copyText(s.wallet, "Alamat wallet") }, [renderIcon("copy")]),
    ]],
    ["Network", [el("span", { className: "chip" }, `${CHAIN_NAME} · ${CHAIN_ID}`)]],
  ];
  if (withRole) rows.push(["Role", [s.role === "unregistered" ? el("span", { className: "badge badge-unregistered" }, "Belum terdaftar") : roleBadge(s.role)]]);
  return el("dl", { className: "info" }, rows.map(([k, v]) => el("div", { className: "info-row" }, [el("dt", {}, k), el("dd", {}, v)])));
}

// Pesan error sopan di dalam card (bukan alert browser). Teks dirender dengan textContent (lewat el()).
function errorView(title, text, actions) {
  announce(title);
  const heading = el("p", { className: "alert-title", tabindex: "-1" }, title);
  show(view([
    el("div", { className: "alert", role: "alert" }, [renderIcon("circle-alert"), el("div", {}, [heading, el("p", { className: "alert-text" }, text)])]),
    ...actions,
  ]), heading);
}

// Utilitas MetaMask
// Pesan aman untuk error lain (tanpa menampilkan objek error mentah).
function friendly(err, fallback) {
  if (err instanceof api.ApiError) return err.message;
  if (err?.code === "CALL_EXCEPTION") return err.revert?.name === "AlreadyHasRole" ? "Wallet ini sudah punya role di kontrak." : "Transaksi ditolak kontrak (revert).";
  if (err?.code === -32002) return "Masih ada permintaan yang menunggu di MetaMask. Buka MetaMask untuk melanjutkan.";
  return fallback;
}
// Tampilan tenang setelah pengguna menekan "Tolak/Batal" di MetaMask.
function rejectedView(what, retry) {
  errorView("Permintaan dibatalkan", `Anda membatalkan ${what} di MetaMask. Tidak ada yang dikirim; silakan coba lagi kapan saja.`, [
    cta("Coba lagi", null, retry),
    ghost("Mulai dari awal", connectView),
  ]);
}
const signer = () => new BrowserProvider(eth).getSigner(s.wallet);

/** Pastikan MetaMask di chain 31337. Melempar error MetaMask (mis. ditolak) apa adanya. */
async function ensureChain() {
  if ((await eth.request({ method: "eth_chainId" })) === CHAIN_HEX) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (err) {
    // 4902 = network belum dikenal MetaMask -> tambahkan (MetaMask sekaligus berpindah ke sana).
    if (err?.code !== 4902 && err?.data?.originalError?.code !== 4902) throw err;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: CHAIN_HEX, chainName: CHAIN_NAME, rpcUrls: [RPC_URL], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
    });
  }
  if ((await eth.request({ method: "eth_chainId" })) !== CHAIN_HEX) throw new Error("chain belum berpindah");
}

// Akun/network MetaMask berganti -> sesi lama tidak boleh dipakai: logout + kembali ke langkah awal.
let restarting = false;
async function restart(reason) {
  if (restarting) return;
  restarting = true;
  await api.authLogout();
  restarting = false;
  connectView();
  announce(reason);
}

// Langkah 1: Connect
function connectView() {
  setStep(0);
  Object.assign(s, { wallet: null, role: null, regTx: null });
  const btn = cta("Connect Wallet", "wallet", () => connect(btn));
  show(view([btn, el("p", { className: "note" }, `Gunakan MetaMask yang terhubung ke ${CHAIN_NAME}.`)]));
}

async function connect(btn) {
  if (!eth) {
    return errorView("MetaMask belum terpasang", "Pasang ekstensi MetaMask di browser ini, lalu muat ulang halaman.", [
      el("a", { className: "cta", href: METAMASK_URL, target: "_blank", rel: "noopener noreferrer" }, [renderIcon("wallet"), "Pasang MetaMask"]),
      ghost("Coba lagi", connectView),
    ]);
  }
  busy(btn);
  try {
    const [account] = await eth.request({ method: "eth_requestAccounts" });
    s.wallet = String(account).toLowerCase();
  } catch (err) {
    if (isRejected(err)) return rejectedView("koneksi wallet", connectView);
    return errorView("Gagal terhubung", friendly(err, "MetaMask tidak merespons. Coba lagi."), [cta("Coba lagi", "wallet", connectView)]);
  }
  await switchNetwork();
}

async function switchNetwork(btn) {
  if (btn) busy(btn);
  try {
    await ensureChain();
  } catch (err) {
    const retry = cta(`Ganti ke ${CHAIN_NAME}`, "network", () => switchNetwork(retry));
    return errorView("Network tidak sesuai", isRejected(err)
      ? `Penggantian network dibatalkan. Aplikasi ini hanya berjalan di ${CHAIN_NAME} (chainId ${CHAIN_ID}).`
      : `Wallet terhubung ke jaringan lain. Aplikasi ini memakai ${CHAIN_NAME} (chainId ${CHAIN_ID}).`, [retry, ghost("Batal", connectView)]);
  }
  signView();
}

// Langkah 2: Sign
function signView(lead = "Tanda tangan membuktikan Anda pemilik wallet ini. Gratis, tanpa biaya gas.") {
  setStep(1);
  announce("Wallet terhubung. Tanda tangani pesan untuk masuk.");
  const btn = cta("Tanda tangani untuk masuk", "shield-check", () => sign(btn));
  show(view([infoRows({ withRole: false }), el("p", { className: "lead" }, lead), btn, ghost("Ganti wallet", connectView)]));
}

async function sign(btn) {
  busy(btn);
  let message, signature;
  try {
    message = await api.authNonce(s.wallet); // pesan lengkap dari server; ditandatangani APA ADANYA
    signature = await (await signer()).signMessage(message); // personal_sign
  } catch (err) {
    if (isRejected(err)) return rejectedView("tanda tangan", () => signView());
    return errorView("Gagal masuk", friendly(err, "Tanda tangan gagal. Coba lagi."), [cta("Coba lagi", "shield-check", () => signView())]);
  }
  btn.replaceChildren(el("span", { className: "spinner", "aria-hidden": "true" }), "Memverifikasi…");
  let session;
  try {
    session = await api.authVerify(message, signature);
  } catch (err) {
    if (err.code === "NO_ROLE") { s.role = "unregistered"; return registerView(); }
    return errorView("Gagal masuk", friendly(err, "Coba lagi beberapa saat lagi."), [cta("Coba lagi", "shield-check", () => signView())]);
  }
  s.role = session.role;
  // Role on-chain tak dikenal: jangan dianggap role lain -> logout.
  if (!ROLE_LABEL[s.role] || s.role === "unregistered") {
    await api.authLogout();
    return errorView("Role tidak dikenal", "Role wallet ini di kontrak tidak dikenali aplikasi. Anda sudah dikeluarkan; hubungi Admin.", [cta("Kembali", "log-out", connectView)]);
  }
  // registerAsPatient baru saja dikirim: catat ke tx_log sekarang (sesi sudah ada). Gagal mencatat tidak
  // menghalangi login; role on-chain sudah sah.
  if (s.regTx && s.role === "patient") {
    await api.logAccessTx({ action: "register_patient", txHash: s.regTx }).catch(() => {});
    s.regTx = null;
  }
  // Pasien yang belum punya profil (mis. baru registerAsPatient) -> isi profil dulu.
  let me = null;
  try { me = await api.authMe(); } catch { /* profil dicek ulang di dashboard */ }
  if (s.role === "patient" && me && !me.hasProfile) return profileView();
  readyView();
}

// Langkah 3: Masuk
function readyView(justRegistered = false) {
  setStep(2);
  announce(`Masuk sebagai ${ROLE_LABEL[s.role]}.`);
  show(view([
    infoRows({ withRole: true }),
    el("p", { className: "lead" }, justRegistered ? "Pendaftaran berhasil. Selamat datang!" : `Anda masuk sebagai ${ROLE_LABEL[s.role]}.`),
    cta("Masuk ke Dashboard", "layout-dashboard", () => { location.href = "dashboard.html#/dashboard"; }),
  ]));
}

// Wallet tanpa role: registerAsPatient() on-chain
function registerView() {
  setStep(2);
  announce("Wallet belum terdaftar. Anda bisa mendaftar sebagai pasien.");
  const title = el("h2", { className: "reg-title", tabindex: "-1" }, "Daftar sebagai Pasien");
  const btn = cta("Daftar sebagai Pasien", "user", () => registerOnChain(btn));
  show(view([
    infoRows({ withRole: true }),
    title,
    el("p", { className: "lead" }, "Wallet ini belum punya role. Pendaftaran pasien dicatat di blockchain lewat satu transaksi MetaMask, lalu Anda menandatangani pesan masuk sekali lagi."),
    btn,
    ghost("Ganti wallet", connectView),
    el("p", { className: "note" }, ["Dokter? ", el("strong", {}, "Hubungi admin"), " untuk didaftarkan."]),
  ]), title);
}

async function registerOnChain(btn) {
  busy(btn, "Menunggu konfirmasi MetaMask…");
  try {
    await ensureChain(); // jangan kirim transaksi ke network lain
  } catch (err) {
    if (isRejected(err)) return rejectedView("penggantian network", registerView);
    return errorView("Network tidak sesuai", `Aplikasi ini memakai ${CHAIN_NAME} (chainId ${CHAIN_ID}).`, [cta("Coba lagi", "user", registerView)]);
  }
  // Belum ada sesi (wallet tanpa role), jadi signer diberikan langsung: akun MetaMask yang terhubung.
  const r = await runTx((c) => c.registerAsPatient(), {
    signer: signer(),
    onStage: (ev) => { if (ev.stage === "pending") btn.replaceChildren(el("span", { className: "spinner", "aria-hidden": "true" }), "Menunggu blok…"); },
  });
  if (r.status === "rejected") return rejectedView("transaksi pendaftaran", registerView);
  if (r.status !== "confirmed") {
    return errorView("Pendaftaran gagal", r.message, [cta("Coba lagi", "user", registerView), ghost("Ganti wallet", connectView)]);
  }
  s.regTx = r.txHash;
  announce("Terdaftar di blockchain. Tanda tangani sekali lagi untuk masuk.");
  signView("Terdaftar sebagai pasien di blockchain. Tanda tangani pesan sekali lagi untuk masuk, lalu lengkapi profil Anda.");
}

// Profil pasien (off-chain)
function regField(name, label, control) {
  control.id = `reg-${name}`;
  control.name = name;
  control.required = true;
  control.setAttribute("aria-describedby", `reg-${name}-err`);
  return el("div", { className: "auth-field" }, [el("label", { for: control.id }, label), control, el("p", { className: "err", id: `reg-${name}-err` })]);
}

function profileView() {
  setStep(2);
  announce("Lengkapi profil pasien.");
  const title = el("h2", { className: "reg-title", tabindex: "-1" }, "Profil Pasien");
  const submit = el("button", { type: "submit", className: "cta" }, "Simpan profil");
  const form = el("form", { className: "reg-form", novalidate: true }, [
    regField("full_name", "Nama lengkap", el("input", { autocomplete: "name", maxlength: 100 })),
    el("div", { className: "reg-row" }, [
      regField("phone", "Telepon", el("input", { type: "tel", autocomplete: "tel", inputmode: "tel", placeholder: "08…" })),
      regField("birth_date", "Tanggal lahir", el("input", { type: "date", max: new Date().toISOString().slice(0, 10) })),
    ]),
    regField("gender", "Jenis kelamin", el("select", {}, [el("option", { value: "" }, "Pilih…"), el("option", { value: "L" }, "Laki-laki"), el("option", { value: "P" }, "Perempuan")])),
    regField("address", "Alamat", el("textarea", { rows: 2, maxlength: 255, autocomplete: "street-address" })),
    submit,
  ]);
  const controls = () => form.querySelectorAll("input, select, textarea");
  // Tampilkan pesan per field (validasi frontend ATAU respons 400 backend). Mengembalikan field pertama yang salah.
  const showFieldErrors = (errors) => {
    let first = null;
    controls().forEach((c) => {
      const msg = errors[c.name] ?? "";
      c.setAttribute("aria-invalid", msg ? "true" : "false");
      $(`reg-${c.name}-err`).textContent = msg;
      if (msg && !first) first = c;
    });
    return first;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(form);
    const first = showFieldErrors(validateProfile(d));
    if (first) { first.focus(); return; }
    busy(submit, "Menyimpan…");
    controls().forEach((c) => { c.disabled = true; });
    try {
      await api.registerProfile(d); // wallet diambil backend dari sesi, bukan dari form
    } catch (err) {
      if (err.status === 400 && err.fields) {
        controls().forEach((c) => { c.disabled = false; });
        submit.disabled = false;
        submit.removeAttribute("aria-busy");
        submit.replaceChildren("Simpan profil");
        showFieldErrors(err.fields)?.focus();
        return;
      }
      if (err.status === 409) return readyView(); // profil sudah ada (mis. tab lain)
      return errorView("Profil gagal disimpan", friendly(err, "Coba lagi."), [cta("Isi ulang formulir", null, profileView)]);
    }
    readyView(true);
  });
  show(view([infoRows({ withRole: true }), title, form]), title);
}

// Mulai
// Membuka halaman login = mulai sesi baru: sesi lama (jika ada) dicabut di server lebih dulu.
await api.authLogout();
if (eth?.on) {
  // Abaikan event yang memang bagian dari alur ini: koneksi pertama (akun = s.wallet) dan pindah KE chain 31337.
  eth.on("accountsChanged", (accounts) => {
    if (s.wallet && String(accounts?.[0] ?? "").toLowerCase() !== s.wallet) restart("Akun MetaMask berganti. Silakan masuk lagi.");
  });
  eth.on("chainChanged", (chainId) => {
    if (s.wallet && chainId !== CHAIN_HEX) restart("Network MetaMask berganti. Silakan masuk lagi.");
  });
}
// Cek node & kontrak di awal; tampilkan pesan yang jelas, bukan error mentah.
const chainCheck = await checkContractDeployed();
if (!chainCheck.ok) errorView("Blockchain lokal belum siap", chainCheck.message, [cta("Muat ulang", "network", () => location.reload())]);
else connectView();
