// start.mjs — menjalankan BioCare untuk demo/uji manual: node Hardhat, deploy kontrak, reset+seed DB, backend.
// Opsi: --no-open (jangan tawarkan membuka browser), --yes (jawab Y untuk konfirmasi).
// MySQL tidak pernah dinyalakan/dimatikan di sini; hanya dicek port 3306.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  Fail, at, chainId, checkMysqlRunning, confirm, flag, hasFile, killTree, main, note, npm, ok, openWindow,
  readEnv, resetDb, stopPort, waitFor,
} from "./common.mjs";

const CHAIN_LOG = at("scripts", "run", "logs", "chain.log");
const windows = []; // PID jendela yang dibuka runner ini, untuk dibersihkan bila ada langkah gagal

main(async () => {
  console.log("\n=== BioCare start ===\n");

  // a) Prasyarat
  const missing = [["node_modules", "node_modules"], ["frontend/vendor", "frontend/vendor"], ["backend/abi", "backend/abi/HospitalRecords.json"], [".env", ".env"]]
    .filter(([, path]) => !hasFile(...path.split("/"))).map(([name]) => name);
  if (!hasFile("artifacts", "contracts", "HospitalRecords.sol", "HospitalRecords.json")) missing.push("artifacts (hasil compile)");
  if (missing.length) throw new Fail(`Belum lengkap: ${missing.join(", ")}.\nJalankan setup.bat dulu.`);
  const env = readEnv();
  const appPort = Number(env.PORT) || 3000;
  const rpcPort = Number(new URL(env.RPC_URL || "http://127.0.0.1:8545").port) || 8545;
  await checkMysqlRunning(Number(env.DB_PORT) || 3306);
  ok("node_modules, frontend/vendor, artifacts, .env ada.");

  try {
    // b) Bersihkan proses node lama (proses non-node dibiarkan)
    for (const port of [rpcPort, appPort]) {
      if ((await stopPort(port)) === "bukan-node") throw new Fail(`Port ${port} dipakai proses lain (bukan node.exe). Hentikan sendiri, lalu ulangi.`);
    }

    // c) Node Hardhat
    // Keluaran node tampil di jendela dan ikut disalin ke logs/chain.log (lewat chain-window.mjs).
    mkdirSync(at("scripts", "run", "logs"), { recursive: true });
    try { rmSync(CHAIN_LOG, { force: true }); } catch { /* log lama masih terkunci: ditimpa saat jendela baru mulai */ }
    windows.push(openWindow("BioCare Chain", `node scripts\\run\\chain-window.mjs`));
    note(`Jendela "BioCare Chain" dibuka; menunggu RPC (maks 60 detik)...`);
    try {
      await waitFor(async () => (await chainId(`http://127.0.0.1:${rpcPort}`)) === "0x7a69", `RPC chainId 31337 di port ${rpcPort}`, 60_000);
    } catch (e) {
      // Tampilkan 20 baris terakhir log supaya penyebabnya (mis. port dipakai, Node terlalu lama) langsung terlihat.
      const tail = existsSync(CHAIN_LOG) ? readFileSync(CHAIN_LOG, "utf8").trimEnd().split(/\r?\n/).slice(-20).join("\n") : "(log kosong)";
      throw new Fail(`${e.message}\n20 baris terakhir ${CHAIN_LOG}:\n${tail}`);
    }
    ok(`Node Hardhat siap (chainId 31337, port ${rpcPort}).`);

    // d) Deploy kontrak + role awal
    const deploy = npm("run deploy:local", { capture: true });
    if (deploy.status !== 0) throw new Fail(`npm run deploy:local gagal:\n${deploy.stdout}${deploy.stderr}`);
    const address = /HospitalRecords: (0x[0-9a-fA-F]{40})/.exec(deploy.stdout)?.[1];
    const inFrontend = /CONTRACT_ADDRESS = "(0x[0-9a-fA-F]{40})"/.exec(readFileSync(at("frontend", "js", "config.js"), "utf8"))?.[1];
    if (!address) throw new Fail(`Alamat kontrak tidak terbaca dari keluaran deploy:\n${deploy.stdout}`);
    const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
    if (!same(address, env.CONTRACT_ADDRESS) || !same(address, inFrontend)) {
      throw new Fail(`Alamat kontrak hasil deploy (${address}) tidak sama dengan .env (${env.CONTRACT_ADDRESS}) / frontend/js/config.js (${inFrontend}).`);
    }
    ok(`Kontrak HospitalRecords di ${address} (sama dengan .env & frontend).`);
    const roles = new Map([...deploy.stdout.matchAll(/#(\d+) (0x[0-9a-fA-F]{40}) -> (\w+)/g)].map((m) => [Number(m[1]), { address: m[2], role: m[3] }]));

    // e) Reset + seed database (hospital_reset)
    resetDb();
    ok("Database di-reset dan di-seed ulang (hospital_reset).");

    // f) Backend
    windows.push(openWindow("BioCare Backend", "npm run dev"));
    const url = `http://127.0.0.1:${appPort}`;
    note(`Jendela "BioCare Backend" dibuka; menunggu ${url} (maks 30 detik)...`);
    await waitFor(() => fetch(url).then(() => true, () => false), `${url} merespons. Lihat pesan error di jendela "BioCare Backend"`, 30_000);
    ok(`Backend merespons di ${url}.`);

    // g) Ringkasan
    const notes = { 1: "Doctor (Umum)", 2: "Doctor (Anak)", 5: "Doctor (Penyakit Dalam)", 4: "tanpa role (uji registrasi pasien)", 9: "tanpa role" };
    const { HDNodeWallet } = await import("ethers"); // mnemonic Hardhat publik, hanya untuk alamat
    console.log(`\n=== BioCare siap: ${url} ===`);
    console.log("Akun uji (akun default Hardhat; private key tampil di jendela \"BioCare Chain\", HANYA untuk lokal):");
    for (let i = 0; i < 10; i++) {
      const addr = HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`).address;
      const role = roles.get(i)?.role ?? "None";
      console.log(`  #${i}  ${addr}  ${role.padEnd(8)} ${notes[i] ?? ""}`);
    }
    console.log("\nIngat:");
    console.log("  - Buka lewat http://127.0.0.1:" + appPort + " (BUKAN localhost).");
    console.log("  - MetaMask: network Hardhat Local (RPC http://127.0.0.1:" + rpcPort + ", chainId 31337).");
    console.log("  - Karena node baru: MetaMask > Settings > Advanced > \"Clear activity tab data\" untuk tiap akun yang dipakai.");
    console.log("  - Akses pasien #3 -> Doctor #1 berlaku 3 hari sejak start ini.");
    console.log("  - Berhenti: stop.bat. Jendela Chain & Backend jangan ditutup selama demo.\n");
    if (!flag("--no-open") && (await confirm("Buka di browser default?"))) spawn("cmd.exe", ["/d", "/c", "start", '""', url], { stdio: "ignore", detached: true, windowsVerbatimArguments: true }).unref();
  } catch (e) {
    for (const pid of windows) killTree(pid);
    if (windows.length) console.error("\nJendela yang dibuka runner ini sudah dihentikan.");
    throw e;
  }
});
