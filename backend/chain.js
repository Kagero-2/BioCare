// chain.js — akses READ-ONLY ke kontrak HospitalRecords.
// Backend tidak punya private key dan tidak pernah mengirim transaksi: transaksi dikirim
// pengguna lewat MetaMask, backend hanya MEMBACA role dan MEMVERIFIKASI receipt-nya.
import { readFileSync } from "node:fs";
import { JsonRpcProvider, Contract, Interface } from "ethers";
import config from "./config.js";
import { ApiError } from "./lib/errors.js";
import { roleFromEnum } from "./lib/roles.js";

export { ROLES } from "./lib/roles.js";

const abi = JSON.parse(readFileSync(new URL("./abi/HospitalRecords.json", import.meta.url), "utf8"));
export const iface = new Interface(abi);
// cacheTimeout -1: tanpa cache respons RPC. Default ethers menyimpan hasil panggilan identik 250 ms,
// sehingga hasAccess/event tepat setelah grant/revoke bisa basi. Otorisasi harus selalu segar.
export const provider = new JsonRpcProvider(config.RPC_URL, config.CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 });
const contract = new Contract(config.CONTRACT_ADDRESS, abi, provider);

const lower = (v) => String(v).toLowerCase();
const chainDown = (err) => {
  console.error("[chain]", err);
  return new ApiError(503, "CHAIN_UNAVAILABLE", "Blockchain lokal tidak terjangkau. Coba lagi nanti.");
};
// Panggilan kontrak: revert custom error dikembalikan sebagai { revert: "NamaError" }.
async function callContract(fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    if (err.code === "CALL_EXCEPTION" && err.revert?.name) return { revert: err.revert.name };
    throw chainDown(err);
  }
}
// Fungsi view yang SEHARUSNYA tidak pernah revert: revert berarti kontrak/ABI tidak cocok -> 503.
async function mustCall(fn, label) {
  const r = await callContract(fn);
  if (r.revert) throw chainDown(new Error(`${label} revert ${r.revert}`));
  return r.value;
}

/**
 * Role on-chain sebuah wallet: "admin" | "doctor" | "patient" | "unregistered".
 * FAIL CLOSED: gagal membaca kontrak -> 503; nilai enum di luar 0..3 -> 403.
 * Tidak pernah jatuh ke role lain.
 */
export async function getRole(wallet) {
  const value = await mustCall(() => contract.getRole(wallet), "getRole");
  const role = roleFromEnum(value);
  if (role === null) {
    console.error(`[chain] getRole(${wallet}) mengembalikan enum tak dikenal: ${value}`);
    throw new ApiError(403, "UNKNOWN_ROLE", "Role on-chain tidak dikenali. Akses ditolak.");
  }
  return role;
}

/**
 * Data rekam medis on-chain, dibaca SEBAGAI `asWallet` (eth_call dengan from).
 * Kontrak membatasi getRecord untuk Doctor ber-akses aktif / Patient pemilik; backend tidak punya
 * role, jadi panggilan disimulasikan atas nama pengguna yang sedang meminta (tanpa tanda
 * tangan — aman karena view, dan pembatasan view memang bukan kerahasiaan).
 * Mengembalikan { record } atau { revert: "RecordNotFound" | "RecordAlreadyDeleted" | "NotAuthorized" | "NoAccess" | "AccessExpired" }.
 */
export async function getRecordOnChain(id, asWallet) {
  const r = await callContract(() => contract.getRecord(BigInt(id), { from: asWallet }));
  if (r.revert) return r;
  const v = r.value;
  return { record: { id: Number(v.id), patient: lower(v.patient), doctor: lower(v.doctor), dataHash: lower(v.dataHash), createdAt: Number(v.createdAt), updatedAt: Number(v.updatedAt), isDeleted: v.isDeleted } };
}

/** hasAccess(patient, doctor) kontrak: true jika akses belum kedaluwarsa (dinilai dengan WAKTU BLOK). */
export async function hasAccess(patient, doctor) {
  return (await mustCall(() => contract.hasAccess(patient, doctor), "hasAccess")) === true;
}

/** getAccessExpiry(patient, doctor): unix detik; 0 = tidak pernah diberi / dicabut. */
export async function getAccessExpiry(patient, doctor) {
  return Number(await mustCall(() => contract.getAccessExpiry(patient, doctor), "getAccessExpiry"));
}

/** Timestamp block terakhir = "jam" yang dipakai kontrak (bukan jam server). */
export async function blockTime() {
  try {
    return (await provider.getBlock("latest")).timestamp;
  } catch (err) {
    throw chainDown(err);
  }
}

/**
 * Status akses per pasangan pasien–dokter.
 * Event (AccessGranted/Extended/Revoked) HANYA dipakai untuk menemukan pasangan & metadata
 * (sejak kapan, tx terakhir, siapa pencabut). Status & masa berlaku SELALU dari kontrak:
 *   status = hasAccess ? "active" : (expiresAt === 0 ? "revoked" : "expired")
 *   remainingSeconds = expiresAt - waktu blok terakhir (0 jika tidak aktif).
 * revokedReason (hanya untuk "revoked"):
 *   "access_revoked" = AccessRevoked sesudah grant/extend terakhir (revokedBy = args.by: pasien/Admin/dokter);
 *   "role_revoked"   = tidak ada AccessRevoked sesudahnya, tetapi kontrak memberi expiry 0 -> akses mati karena
 *                      role Doctor dicabut (epoch dokter naik). revokedBy = Admin (satu-satunya pencabut role).
 * Mengembalikan [{ patient, doctor, status, expiresAt, remainingSeconds, since, txHash, revokedBy, revokedReason }].
 */
export async function accessRelations({ patient = null, doctor = null } = {}) {
  let logs;
  try {
    const f = contract.filters;
    const parts = await Promise.all([
      contract.queryFilter(f.AccessGranted(patient, doctor), 0),
      contract.queryFilter(f.AccessExtended(patient, doctor), 0),
      contract.queryFilter(f.AccessRevoked(patient, doctor), 0),
    ]);
    logs = parts.flat().sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  } catch (err) {
    throw chainDown(err);
  }
  const pairs = new Map(); // "patient|doctor" -> { lastGrant, lastTx, lastRevoke }
  for (const l of logs) {
    const key = `${lower(l.args.patient)}|${lower(l.args.doctor)}`;
    const p = pairs.get(key) ?? {};
    if (l.eventName === "AccessGranted") p.lastGrant = l;
    if (l.eventName !== "AccessRevoked") p.lastTx = l;
    else p.lastRevoke = l;
    pairs.set(key, p);
  }
  const now = await blockTime();
  const admin = lower(await mustCall(() => contract.admin(), "admin"));
  const after = (a, b) => !b || (a && (a.blockNumber - b.blockNumber || a.index - b.index) > 0);
  // shortcut: 2 eth_call + 1 getBlock per pasangan; untuk data besar perlu indeks event off-chain.
  return Promise.all([...pairs.entries()].map(async ([key, p]) => {
    const [pat, doc] = key.split("|");
    const [active, expiresAt] = await Promise.all([hasAccess(pat, doc), getAccessExpiry(pat, doc)]);
    const status = active ? "active" : expiresAt === 0 ? "revoked" : "expired";
    const since = p.lastGrant ? (await provider.getBlock(p.lastGrant.blockNumber).catch((err) => { throw chainDown(err); })).timestamp : null;
    const byEvent = status === "revoked" && p.lastRevoke && after(p.lastRevoke, p.lastTx);
    const revokedReason = status !== "revoked" ? null : byEvent ? "access_revoked" : "role_revoked";
    return {
      patient: pat, doctor: doc, status,
      expiresAt: expiresAt || null,
      remainingSeconds: active ? Math.max(0, expiresAt - now) : 0,
      since, txHash: p.lastTx?.transactionHash ?? null,
      revokedBy: revokedReason === "access_revoked" ? lower(p.lastRevoke.args.by) : revokedReason === "role_revoked" ? admin : null,
      revokedReason,
    };
  }));
}

/**
 * Dipanggil server.js saat start: kontrak ada di alamat .env DAN versinya terbaru
 * (punya getAccessExpiry & enum baru). Melempar Error berisi pesan jelas jika tidak.
 */
export async function checkContractDeployed() {
  let code;
  try {
    code = await provider.getCode(config.CONTRACT_ADDRESS);
  } catch {
    throw new Error(`Node blockchain tidak terjangkau di ${config.RPC_URL}. Jalankan: npm run chain`);
  }
  if (code === "0x") throw new Error(`Kontrak belum di-deploy di ${config.CONTRACT_ADDRESS}. Jalankan: npm run deploy:local`);
  try {
    // staticcall fungsi yang hanya ada di versi terbaru (akses bermasa berlaku)
    await contract.getAccessExpiry.staticCall(config.CONTRACT_ADDRESS, config.CONTRACT_ADDRESS);
  } catch {
    throw new Error("Kontrak di alamat ini bukan versi terbaru (getAccessExpiry gagal). Compile ulang, restart node, lalu deploy ulang.");
  }
}

/** getStats() kontrak: jumlah rekam medis aktif on-chain. */
export async function getStats() {
  const { value } = await callContract(() => contract.getStats());
  return Number(value);
}

// Argumen event/call sama dengan nilai server? Alamat & hash dibandingkan lowercase, angka sebagai BigInt.
const sameArg = (actual, expected) => (typeof expected === "bigint" || typeof expected === "number"
  ? BigInt(actual) === BigInt(expected)
  : lower(actual) === lower(expected));

/**
 * Blok deploy kontrak = blok event RoleGranted dari constructor (account = admin = deployer;
 * grantRole tidak pernah bisa memberi role ke admin lagi, jadi event ini unik).
 * Tidak di-cache: node bisa di-restart lalu kontrak di-deploy ulang di alamat yang sama.
 */
async function deployBlock() {
  const admin = await contract.admin();
  const [first] = await contract.queryFilter(contract.filters.RoleGranted(admin, null, admin), 0);
  return first?.blockNumber ?? 0;
}

/** Event `name` dengan filter argumen indexed (urutan = ABI, null = bebas), sejak blok deploy. */
export async function findEvents(name, args) {
  try {
    return await contract.queryFilter(contract.filters[name](...args), await deployBlock());
  } catch (err) {
    throw chainDown(err);
  }
}

// Pelaku tiap event = argumen ini (kontrak selalu menyertakan pelakunya).
const ACTOR_ARG = {
  RoleGranted: "admin", RoleRevoked: "admin", PatientRegistered: "patient",
  RecordAdded: "doctor", RecordUpdated: "doctor", RecordDeleted: "doctor",
  AccessGranted: "patient", AccessExtended: "patient", AccessRevoked: "by",
};
const blockTimes = new Map(); // blockHash -> timestamp (isi block dengan hash yang sama tidak pernah berubah)
const plain = (v) => (typeof v === "bigint" ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : lower(v));

/**
 * SEMUA event kontrak sejak blok deploy, urut lama -> baru:
 * [{ event, args (alamat lowercase, angka Number), actor, txHash, blockNumber, logIndex, timestamp (unix detik waktu blok) }].
 * Event hanya berisi alamat, id, hash & waktu — tidak ada data medis.
 * shortcut: memindai semua event setiap request; untuk chain besar perlu indeks event off-chain.
 */
export async function contractEvents() {
  try {
    const logs = (await contract.queryFilter("*", await deployBlock())).filter((l) => l.eventName);
    const missing = [...new Set(logs.map((l) => l.blockHash))].filter((h) => !blockTimes.has(h));
    await Promise.all(missing.map(async (h) => blockTimes.set(h, (await provider.getBlock(h)).timestamp)));
    return logs.map((l) => {
      const args = Object.fromEntries(l.fragment.inputs.map((inp, i) => [inp.name, plain(l.args[i])]));
      return { event: l.eventName, args, actor: args[ACTOR_ARG[l.eventName]] ?? null, txHash: lower(l.transactionHash),
        blockNumber: l.blockNumber, logIndex: l.index, timestamp: blockTimes.get(l.blockHash) };
    });
  } catch (err) {
    throw chainDown(err);
  }
}

/** Receipt transaksi: null = belum masuk block / tidak dikenal node. */
export async function txReceipt(txHash) {
  try {
    return await provider.getTransactionReceipt(txHash);
  } catch (err) {
    throw chainDown(err);
  }
}
/** true jika node masih mengenal transaksi ini (mis. masih di mempool). */
export async function txKnown(txHash) {
  try {
    return (await provider.getTransaction(txHash)) !== null;
  } catch (err) {
    throw chainDown(err);
  }
}

/**
 * Transaksi yang BARU dikirim (boleh belum masuk block) harus panggilan kontrak yang persis diharapkan:
 * dikirim `from`, ke alamat kontrak, fungsi `fn` dengan argumen `args` (diambil dari database).
 * Dipakai saat txHash dicatat ke draft agar hash transaksi lain tidak bisa ditempelkan. Gagal -> 422.
 */
export async function verifySentTx(txHash, from, fn, args) {
  const reject = (msg) => new ApiError(422, "TX_INVALID", msg);
  let tx;
  try {
    tx = await provider.getTransaction(txHash);
  } catch (err) {
    throw chainDown(err);
  }
  if (!tx) throw reject("Transaksi tidak ditemukan di node.");
  if (lower(tx.from) !== lower(from)) throw reject("Transaksi tidak dikirim oleh wallet Anda.");
  if (lower(tx.to) !== config.CONTRACT_ADDRESS) throw reject("Transaksi tidak ditujukan ke kontrak HospitalRecords.");
  let call = null;
  try { call = iface.parseTransaction({ data: tx.data }); } catch { /* bukan fungsi kontrak ini */ }
  if (call?.name !== fn || args.some((v, i) => !sameArg(call.args[i], v))) throw reject(`Transaksi bukan ${fn} untuk draft ini.`);
}

/**
 * Verifikasi transaksi yang dilaporkan client SEBELUM database diperbarui:
 *  1. receipt ada & status sukses (1),
 *  2. transaksi ditujukan ke alamat kontrak kita,
 *  3. TEPAT SATU event `expectedEvent` dari kontrak kita dengan argumen = expectedArgs
 *     (alamat & hash dibandingkan lowercase, angka sebagai BigInt).
 *     expectedEvent boleh berupa daftar nama (mis. ["AccessGranted", "AccessExtended"]):
 *     tepat satu event dari daftar itu yang boleh ada.
 * Mengembalikan { name, args, blockNumber, from } atau melempar ApiError 422.
 */
export async function verifyReceipt(txHash, expectedEvent, expectedArgs) {
  const names = [expectedEvent].flat();
  const label = names.join("/");
  const reject = (msg) => new ApiError(422, "TX_INVALID", msg);
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    throw chainDown(err);
  }
  if (!receipt) throw reject("Transaksi tidak ditemukan atau belum masuk block.");
  if (receipt.status !== 1) throw reject("Transaksi gagal (revert) di blockchain.");
  if (lower(receipt.to) !== config.CONTRACT_ADDRESS) throw reject("Transaksi tidak ditujukan ke kontrak HospitalRecords.");

  const events = receipt.logs
    .filter((log) => lower(log.address) === config.CONTRACT_ADDRESS)
    .map((log) => { try { return iface.parseLog(log); } catch { return null; } })
    .filter((e) => names.includes(e?.name));
  if (events.length !== 1) throw reject(`Event ${label} tidak ditemukan di transaksi ini.`);

  const args = events[0].args;
  for (const [key, expected] of Object.entries(expectedArgs)) {
    if (!sameArg(args[key], expected)) throw reject(`Argumen event ${events[0].name}.${key} tidak cocok dengan data di server.`);
  }
  return { name: events[0].name, args, blockNumber: receipt.blockNumber, from: lower(receipt.from) };
}
