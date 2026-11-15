// Salin ABI HospitalRecords hasil compile Hardhat. Dipanggil oleh `npm run compile`.
//  - backend : JSON biasa (dibaca Node).
//  - frontend: modul JS `export default [...]`, agar bisa di-import browser tanpa
//              import attribute JSON (`with { type: "json" }`) dan tanpa syarat MIME JSON.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SRC = "artifacts/contracts/HospitalRecords.sol/HospitalRecords.json";
const { abi } = JSON.parse(await readFile(SRC, "utf8"));
if (!Array.isArray(abi) || abi.length === 0) throw new Error(`ABI kosong di ${SRC}`);
const json = JSON.stringify(abi, null, 2);

const outputs = {
  "backend/abi/HospitalRecords.json": json + "\n",
  "frontend/js/abi/HospitalRecords.js": `// Dibuat otomatis oleh scripts/export-abi.js (npm run compile). Jangan diedit manual.\nexport default ${json};\n`,
};
for (const [out, content] of Object.entries(outputs)) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, content);
  console.log(`ABI -> ${out}`);
}
