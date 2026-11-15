// setup.mjs — pemasangan pertama / ulang BioCare: prasyarat, dependensi, .env, database, verifikasi.
// Opsi: --dry-run (cetak langkah tanpa mengubah apa pun), --yes (jawab Y untuk konfirmasi, untuk uji otomatis).
// MySQL tidak pernah dinyalakan/dimatikan di sini; hanya dicek port 3306.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Fail, MYSQL_BIN, askHidden, at, checkMysqlRunning, checkNode, confirm, flag, hasFile, main, note, npm, ok, readEnv, warn,
} from "./common.mjs";
import { envProblems, newEnvText, renderUsersSql } from "./env-file.mjs";

const dry = flag("--dry-run");
/** Langkah yang mengubah sesuatu: di mode --dry-run hanya dicetak. */
const step = async (desc, fn) => {
  if (dry) return console.log(`[DRY-RUN] ${desc}`);
  return fn();
};

main(async () => {
  console.log(`\n=== BioCare setup${dry ? " (DRY-RUN: tidak ada yang diubah)" : ""} ===\n`);

  // a) Prasyarat
  checkNode();
  const mysqlBin = MYSQL_BIN;
  if (!existsSync(mysqlBin)) throw new Fail(`mysql.exe tidak ditemukan di ${mysqlBin}. Pasang XAMPP, atau set env MYSQL_BIN ke lokasi mysql.exe.`);
  ok(`mysql.exe: ${mysqlBin}`);
  const port = Number((existsSync(at(".env")) ? readEnv().DB_PORT : "") || 3306);
  try { await checkMysqlRunning(port); } catch (e) { if (!dry) throw e; warn(e.message); }

  // b) Dependensi, aset lokal, compile kontrak
  await step("npm ci (atau npm install bila tanpa package-lock.json)", () => {
    note("Memasang dependensi...");
    if (npm(hasFile("package-lock.json") ? "ci" : "install").status !== 0) throw new Fail("Instal dependensi gagal.");
  });
  await step("npm run vendor", () => { if (npm("run vendor").status !== 0) throw new Fail("npm run vendor gagal."); });
  await step("npm run compile", () => { if (npm("run compile").status !== 0) throw new Fail("npm run compile gagal."); });

  // c) .env
  if (existsSync(at(".env"))) {
    ok(".env sudah ada: dipakai apa adanya (tidak ditimpa).");
  } else {
    await step("membuat .env dari .env.example dengan JWT_SECRET, DB_PASSWORD, DB_RESET_PASSWORD acak (tidak ditampilkan)", () => {
      writeFileSync(at(".env"), newEnvText(readFileSync(at(".env.example"), "utf8")), { flag: "wx" });
      ok(".env dibuat dari .env.example; tiga secret acak sudah diisi (tidak ditampilkan).");
    });
  }
  if (!existsSync(at(".env"))) return console.log("\n(dry-run selesai: langkah database & verifikasi butuh .env)");
  const env = readEnv();
  const problems = envProblems(env);
  if (problems.length) throw new Fail(`.env belum benar (file TIDAK diubah; perbaiki manual lalu jalankan setup lagi):\n  - ${problems.join("\n  - ")}`);
  ok(".env lengkap; user DB bukan root dan password terisi.");

  // d) Database sebagai root
  console.log("\nLangkah database memakai user root MySQL. schema.sql akan MENGHAPUS database hospital_dapp lalu membuatnya ulang.");
  if (dry) return console.log("[DRY-RUN] konfirmasi Y/N → schema.sql → users.sql (salinan sementara) → seed.sql → verifikasi login & GRANT");
  if (!(await confirm("Lanjutkan dan hapus database hospital_dapp?"))) throw new Fail("Dibatalkan. Setup belum selesai; jalankan setup.bat lagi bila siap.");

  const secrets = [env.DB_PASSWORD, env.DB_RESET_PASSWORD];
  let rootPassword; // undefined = tanpa password
  const mysql = (sql) => {
    const childEnv = { ...process.env };
    delete childEnv.MYSQL_PWD;
    if (rootPassword !== undefined) childEnv.MYSQL_PWD = rootPassword; // lewat env, bukan argumen
    const r = spawnSync(mysqlBin, ["-u", "root", "-h", "127.0.0.1", "-P", String(port), "--default-character-set=utf8mb4"],
      { input: sql, env: childEnv, encoding: "utf8" });
    // stderr bisa mengutip potongan SQL; password disensor sebelum dicetak.
    const err = secrets.reduce((t, s) => t.replaceAll(s, "***"), r.stderr ?? "");
    return { status: r.status, err, errno: Number(/ERROR (\d+)/.exec(err)?.[1]) || null };
  };
  const explain = (errno) => ({
    1044: "Hak akses root tidak cukup / GRANT tidak tersimpan.",
    1045: "Password salah.",
    1030: "Tabel sistem MySQL (Aria) rusak: lihat README bagian Troubleshooting (REPAIR TABLE mysql.global_priv).",
    1034: "Tabel sistem MySQL rusak: lihat README bagian Troubleshooting (REPAIR TABLE mysql.db).",
  })[errno] ?? "";
  const runSql = (label, sql) => {
    const r = mysql(sql);
    if (r.status !== 0) throw new Fail(`${label} gagal.\n${r.err.trim()}\n${explain(r.errno)}`.trim());
    ok(label);
  };

  // Root: coba tanpa password dulu; bila ditolak (1045) minta password.
  for (let attempt = 1; ; attempt++) {
    const r = mysql("SELECT 1;");
    if (r.status === 0) break;
    if (r.errno !== 1045 || attempt > 3) throw new Fail(`Tidak bisa login sebagai root MySQL.\n${r.err.trim()}\n${explain(r.errno)}`.trim());
    rootPassword = await askHidden("Password root MySQL (tidak ditampilkan): ");
  }
  ok("Login root MySQL berhasil.");

  runSql("schema.sql (DROP + CREATE database hospital_dapp)", readFileSync(at("database", "schema.sql")));
  // users.sql: salinan sementara berisi password dari .env; selalu dihapus.
  const dir = mkdtempSync(join(tmpdir(), "biocare-"));
  try {
    const file = join(dir, "users.sql");
    writeFileSync(file, renderUsersSql(readFileSync(at("database", "users.sql"), "utf8"), env), { mode: 0o600 });
    runSql("users.sql (user hospital_app & hospital_reset)", readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  runSql("seed.sql (8 profil + 2 appointment contoh)", readFileSync(at("database", "seed.sql")));

  // e) Verifikasi akhir
  const { default: mysql2 } = await import("mysql2/promise");
  const connect = (user, password) => mysql2.createConnection({ host: "127.0.0.1", port, user, password, database: "hospital_dapp" });
  const wants = [["DB_USER", env.DB_USER, env.DB_PASSWORD, "DELETE, INSERT, SELECT, UPDATE"], ["DB_RESET_USER", env.DB_RESET_USER, env.DB_RESET_PASSWORD, "DROP, INSERT"]];
  const failures = [];
  for (const [key, user, password, wantPrivs] of wants) {
    let conn;
    try {
      conn = await connect(user, password);
      ok(`Login ${user} dengan password dari .env berhasil.`);
    } catch (e) {
      failures.push(`Login ${user} gagal (${e.code}). ${e.errno === 1045 ? `Password di MySQL beda dengan ${key} di .env (users.sql sudah menyetel ulang; cek MYSQL_BIN / server lain di port ${port}).` : explain(e.errno)}`);
      continue;
    }
    try {
      const grants = (await conn.query("SHOW GRANTS"))[0].map((row) => Object.values(row)[0]);
      const onDb = grants.find((g) => g.includes("`hospital_dapp`.*"));
      const privs = onDb ? /^GRANT (.+?) ON /.exec(onDb)?.[1].split(/,\s*/).sort().join(", ") : null;
      if (privs === wantPrivs) ok(`${user}: hak di hospital_dapp.* = ${wantPrivs}.`);
      else failures.push(`${user}: hak di hospital_dapp.* = ${privs ?? "(tidak ada, hanya USAGE)"}; seharusnya ${wantPrivs}. Penyebab umum: GRANT tidak tersimpan (error 1044 / tabel sistem rusak 1030) → lihat README bagian Troubleshooting.`);
    } finally { await conn.end(); }
    try {
      (await connect(user, undefined)).end();
      failures.push(`${user} BISA login tanpa password: berbahaya, periksa akun MySQL.`);
    } catch (e) {
      if (e.errno === 1045) ok(`Login ${user} tanpa password ditolak (1045).`);
      else failures.push(`Login ${user} tanpa password gagal dengan kode tak terduga (${e.code}).`);
    }
  }
  if (failures.length) throw new Fail(`Verifikasi database GAGAL:\n  - ${failures.join("\n  - ")}`);

  // f) Ringkasan
  console.log("\n=== Setup selesai ===");
  console.log("Dependensi, aset lokal, ABI kontrak, .env, dan database sudah siap.");
  console.log("Langkah berikutnya: jalankan start.bat (double-click).");
});
