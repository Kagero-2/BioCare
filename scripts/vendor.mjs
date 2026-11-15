// Menyalin aset pihak ketiga dari node_modules ke frontend/vendor/ (tanpa CDN).
// Jalankan: npm run vendor   (setelah npm install)
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const NM = "node_modules";
const OUT = join("frontend", "vendor");

// Daftar ikon lucide yang dipakai UI. Tambahkan di sini jika butuh ikon baru.
const ICONS = [
  "layout-dashboard", "users", "user-cog", "shield-check", "stethoscope", "file-text",
  "user", "history", "badge-check", "log-out", "copy", "menu", "x", "plus", "pencil",
  "trash-2", "search", "circle-check", "circle-alert", "triangle-alert", "info", "wallet",
  "network", "activity", "hospital", "chevron-left", "chevron-right", "inbox",
  "loader-circle", "heart-pulse", "clipboard-list", "shield-alert",
  "calendar", "pill", "printer", "eye", "eye-off", "check", "clock",
  "arrow-up", "arrow-down", "shield-plus", "shield-off", "clock-arrow-up", "user-check",
];

rmSync(OUT, { recursive: true, force: true });

// 1. Font Inter 400/500/600/700: gabung CSS-nya dan salin hanya file font yang dirujuk.
const fontDir = join(NM, "@fontsource", "inter");
mkdirSync(join(OUT, "inter", "files"), { recursive: true });
let css = "";
for (const w of [400, 500, 600, 700]) {
  const part = readFileSync(join(fontDir, `${w}.css`), "utf8");
  for (const [, file] of part.matchAll(/url\(\.\/files\/([^)]+)\)/g)) {
    cpSync(join(fontDir, "files", file), join(OUT, "inter", "files", file));
  }
  css += part + "\n";
}
writeFileSync(join(OUT, "inter", "inter.css"), css);

// 2. Ikon SVG lucide.
mkdirSync(join(OUT, "icons"), { recursive: true });
for (const name of ICONS) {
  cpSync(join(NM, "lucide-static", "icons", `${name}.svg`), join(OUT, "icons", `${name}.svg`));
}

// 3. ethers.js v6 (versi ES module).
cpSync(join(NM, "ethers", "dist", "ethers.min.js"), join(OUT, "ethers.min.js"));

console.log(`Vendor selesai: Inter (4 bobot), ${ICONS.length} ikon, ethers.js -> ${OUT}`);
