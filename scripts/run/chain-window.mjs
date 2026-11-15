// chain-window.mjs — isi jendela "BioCare Chain": menjalankan node Hardhat, menampilkan keluarannya di jendela,
// dan menyalinnya ke scripts/run/logs/chain.log. Jendela tertutup sendiri saat node Hardhat berhenti (stop.bat).
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { ROOT, at } from "./common.mjs";

process.title = "BioCare Chain"; // judul jendela tetap, bukan nama proses

mkdirSync(at("scripts", "run", "logs"), { recursive: true });
const log = createWriteStream(at("scripts", "run", "logs", "chain.log"));
const child = spawn("npm run chain", { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"] });
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => { process.stdout.write(chunk); log.write(chunk); });
}
child.on("exit", (code) => log.end(() => process.exit(code ?? 1)));
