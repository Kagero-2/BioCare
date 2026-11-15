// common.mjs — fungsi bersama runner Windows BioCare (setup, start, stop, test-all).
// Hanya modul bawaan Node: setup.mjs jalan sebelum `npm ci`, jadi tidak boleh bergantung pada node_modules.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const at = (...parts) => join(ROOT, ...parts);
export const MYSQL_BIN = process.env.MYSQL_BIN || "C:\\xampp\\mysql\\bin\\mysql.exe";
export const MIN_NODE = [22, 10]; // syarat Hardhat 3
export const ARTIFACT = at("artifacts", "contracts", "HospitalRecords.sol", "HospitalRecords.json");
export const flag = (name) => process.argv.includes(name);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ok = (m) => console.log(`[OK]     ${m}`);
export const note = (m) => console.log(`[INFO]   ${m}`);
export const warn = (m) => console.log(`[PERINGATAN] ${m}`);

/** Kegagalan yang pesannya sudah ramah pengguna (dicetak tanpa stack trace). */
export class Fail extends Error {}

/** Bungkus fungsi utama: Fail dicetak rapi, exit code 1. */
export function main(fn) {
  fn().catch((e) => {
    console.error(e instanceof Fail ? `\n[GAGAL]  ${e.message}` : e);
    process.exit(1);
  });
}

export function checkNode() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) {
    throw new Fail(`Node.js ${process.versions.node} terlalu lama; butuh minimal ${MIN_NODE.join(".")} (syarat Hardhat 3). Pasang dari nodejs.org.`);
  }
  ok(`Node.js ${process.versions.node}`);
}

export const portOpen = (port) => new Promise((res) => {
  const s = createConnection({ host: "127.0.0.1", port }, () => { s.end(); res(true); });
  s.on("error", () => res(false));
});

export async function waitFor(fn, label, ms) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(500)) if (await fn()) return;
  throw new Fail(`Timeout ${ms / 1000} detik menunggu ${label}.`);
}

/** Isi .env sebagai objek (tanpa menyentuh process.env). */
export const readEnv = () => parseEnv(readFileSync(at(".env"), "utf8"));

export function checkMysqlRunning(port = 3306) {
  return portOpen(port).then((up) => {
    if (!up) throw new Fail(`MySQL belum jalan di port ${port}. Start MySQL di XAMPP Control Panel dulu, lalu ulangi.`);
    ok(`MySQL listening di port ${port}`);
  });
}

// Input pengguna

/** Tanya satu baris. Input ditutup (tanpa terminal) dianggap jawaban kosong. */
export function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("close", () => resolve(""));
    rl.question(question, (a) => { rl.removeAllListeners("close"); rl.close(); resolve(a.trim()); });
  });
}

/** Y/N. `--yes` menjawab Y otomatis (untuk uji otomatis, bukan pemakaian biasa). */
export async function confirm(question) {
  if (flag("--yes")) return true;
  return /^(y|ya|yes)$/i.test(await ask(`${question} (Y/N): `));
}

/** Baca password tanpa menampilkannya (butuh terminal interaktif). */
export function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Fail("Butuh terminal interaktif untuk memasukkan password root MySQL."));
    process.stdout.write(question);
    let text = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(text);
        }
        if (c === "\u0003") process.exit(130); // Ctrl+C
        else if (c === "\b" || c === "\x7f") text = text.slice(0, -1);
        else text += c;
      }
    };
    process.stdin.on("data", onData);
  });
}

// Proses & port

/** Jalankan perintah npm (lewat shell karena npm.cmd) dan tampilkan keluarannya. */
export function npm(command, { capture = false } = {}) {
  return spawnSync(`npm ${command}`, { cwd: ROOT, shell: true, stdio: capture ? "pipe" : "inherit", encoding: "utf8" });
}

/** Matikan satu proses beserta anak-anaknya. */
export const killTree = (pid) => spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });

/** Tabel semua proses: Map pid -> { ppid, name, cmd }. */
function processTable() {
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rows = JSON.parse(out.stdout || "[]");
  return new Map(rows.map((r) => [r.ProcessId, { ppid: r.ParentProcessId, name: r.Name ?? "", cmd: r.CommandLine ?? "" }]));
}

/** PID yang LISTENING di port TCP itu. */
export function listeners(port) {
  const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" }).stdout ?? "";
  const pids = new Set();
  for (const m of out.matchAll(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/gm)) if (Number(m[1]) === port) pids.add(Number(m[2]));
  return [...pids];
}

/**
 * Matikan proses di port HANYA bila node.exe. `node --watch` memakai proses induk pengawas yang akan
 * menunggu perubahan file setelah anaknya mati, jadi induk berargumen --watch ikut dimatikan.
 * Mengembalikan "kosong" | "dimatikan" | "bukan-node" (proses lain dibiarkan).
 */
export async function stopPort(port) {
  const pids = listeners(port);
  if (!pids.length) return "kosong";
  const table = processTable();
  let result = "dimatikan";
  for (const pid of pids) {
    const me = table.get(pid);
    if (me?.name.toLowerCase() !== "node.exe") {
      warn(`Port ${port} dipakai ${me?.name || "proses tak dikenal"} (PID ${pid}), bukan node.exe: TIDAK dimatikan.`);
      result = "bukan-node";
      continue;
    }
    let top = pid;
    for (let up = table.get(top)?.ppid; table.get(up)?.name.toLowerCase() === "node.exe" && table.get(up).cmd.includes("--watch"); up = table.get(top)?.ppid) top = up;
    killTree(top);
    ok(`Port ${port}: node.exe PID ${top} dimatikan.`);
  }
  if (result === "dimatikan") await waitFor(async () => !(await portOpen(port)), `port ${port} bebas`, 15_000);
  return result;
}

/** Buka jendela konsol baru berjudul `title` yang menjalankan `command`. Mengembalikan PID jendelanya. */
export function openWindow(title, command) {
  const child = spawn("cmd.exe", ["/d", "/c", `title ${title} & ${command}`], {
    cwd: ROOT, detached: true, stdio: "ignore", windowsVerbatimArguments: true,
  });
  child.unref();
  return child.pid;
}

/** eth_chainId node RPC, atau null bila tidak terjangkau. */
export async function chainId(url) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
    return (await r.json()).result ?? null;
  } catch { return null; }
}

/** Reset + seed DB dev sebagai hospital_reset lewat scripts/dev-db.js (proses terpisah: pengaman dev-db memakai process.exit). */
export function resetDb(env = process.env) {
  const code = "process.loadEnvFile('.env'); const m = await import('./scripts/dev-db.js'); await m.resetDevDb();";
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env, encoding: "utf8" });
  if (r.status !== 0) throw new Fail(`Reset database gagal: ${(r.stderr || r.stdout).trim()}`);
}

export const hasFile = (...parts) => existsSync(at(...parts));
