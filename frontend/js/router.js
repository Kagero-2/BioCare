// router.js — navigasi antar section berbasis hash (#/dashboard, #/patients/0xabc…).
// Menu disaring sesuai role. Ini hanya MENYEMBUNYIKAN menu; akses data
// tetap harus ditolak oleh kontrak & backend.
// Route: { path: "/patients/:wallet", title, icon, group, roles, menu?, parent?, render }
//  - ":nama" = parameter, dikirim ke render(params)
//  - menu: false  -> tidak tampil di sidebar (mis. halaman detail)
//  - parent       -> menu yang disorot saat halaman detail dibuka
import { el, renderIcon } from "./ui.js";

// Grup tanpa judul ("") tetap dipisah agar Profil selalu di urutan terakhir.
const GROUPS = [["main", "Menu"], ["blockchain", "Blockchain"], ["account", ""]];

// Ambil hanya route yang boleh dilihat role ini.
export const routesFor = (routes, role) => routes.filter((r) => r.roles.includes(role));

// Cocokkan "/patients/0xabc" dengan "/patients/:wallet" -> { wallet: "0xabc" }; null jika tidak cocok.
function match(pattern, path) {
  const a = pattern.split("/"), b = path.split("/");
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) {
      try { params[a[i].slice(1)] = decodeURIComponent(b[i]); } catch { return null; }
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}

// Gambar menu sidebar, dikelompokkan; grup kosong tidak ditampilkan.
export function renderMenu(navEl, routes) {
  const menu = routes.filter((r) => r.menu !== false);
  navEl.replaceChildren(...GROUPS.map(([key, label]) => {
    const items = menu.filter((r) => r.group === key);
    if (!items.length) return null;
    const labelId = `nav-${key}`;
    return el("div", { className: "nav-group" }, [
      label ? el("p", { className: "nav-label", id: labelId }, label) : null,
      el("ul", { className: "nav-list", ...(label ? { "aria-labelledby": labelId } : { "aria-label": "Akun" }) }, items.map((r) =>
        el("li", {}, [el("a", { className: "nav-link", href: `#${r.path}`, dataset: { path: r.path } }, [renderIcon(r.icon), r.title])]))),
    ]);
  }).filter(Boolean));
}

// Mulai router: panggil onRoute(route, params) tiap kali hash berubah.
export function startRouter({ routes, navEl, onRoute }) {
  function go() {
    const path = location.hash.slice(1);
    let route = null, params = null;
    for (const r of routes) { params = match(r.path, path); if (params) { route = r; break; } }
    if (!route) { // hash tidak dikenal / tidak diizinkan -> ke halaman pertama yang boleh
      location.replace(`#${routes[0].path}`);
      return;
    }
    const active = route.parent ?? route.path;
    navEl.querySelectorAll(".nav-link").forEach((a) => {
      if (a.dataset.path === active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    onRoute(route, params);
  }
  window.addEventListener("hashchange", go);
  go();
}
