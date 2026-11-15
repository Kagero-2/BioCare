// /api/records — rekam medis (+ resep) off-chain + alur konfirmasi transaksi on-chain.
// /api/prescriptions — tampilan resep dari rekam medis yang sudah confirmed.
// Alur (semua transaksi dikirim DOKTER lewat MetaMask, backend hanya memverifikasi):
//   create : POST /            -> addRecord(patient, dataHash)        -> POST /:id/confirm
//   update : PUT /:id          -> updateRecord(onchainId, newHash)    -> POST /:id/versions/:v/confirm
//   delete : DELETE /:id       -> deleteRecord(onchainId)             -> POST /:id/versions/:v/confirm
//   gagal  : POST /:id/fail  (transaksi ditolak di MetaMask / revert)
// medical_records hanya berubah SETELAH receipt terverifikasi, sehingga transaksi yang
// gagal tidak pernah membuat data MySQL berbeda dengan hash di kontrak.
// Resep (prescription_items) milik satu VERSI; isi resep yang berlaku = item milik versi
// yang data_hash-nya sama dengan medical_records.data_hash.
// Akses: Admin DITOLAK; Patient miliknya; Doctor hanya pasien yang sedang ia rawat
// (isTreating: hasAccess di kontrak + appointment yang sudah disepakati), dicek SETIAP request
// (assertPatientAccess).
// Draft BUKAN rekam medis: selain dokter pembuatnya, hanya record yang pernah tercatat on-chain
// (confirmed/deleted) dan hanya versi confirmed yang terlihat. Maks 1 draft create pending per pasangan
// dokter–pasien (UNIQUE uq_records_pending_draft). Draft tanpa txHash > DRAFT_EXPIRY_MINUTES dikedaluwarsakan
// saat dibaca siapa pun (expireStaleDrafts), dengan pemeriksaan event on-chain lebih dulu.
import { Router } from "express";
import { pool, withTransaction } from "../db.js";
import { getRole, getRecordOnChain, verifyReceipt, verifySentTx, findEvents, txReceipt, txKnown, provider } from "../chain.js";
import { requireRole, assertPatientAccess } from "../middleware/auth.js";
import { badRequest, forbidden, notFound, conflict, invalidText } from "../lib/errors.js";
import { isCleanText, textMessage } from "../lib/text.js";
import { validateRecordWithPrescriptions, assertValid, walletParam, hashParam, idParam } from "../lib/validate.js";
import { computeDataHash, newSalt } from "../lib/hash.js";

const router = Router();
const READERS = ["doctor", "patient"];
const REC_COLS = `r.id, r.onchain_id, r.patient_wallet, r.doctor_wallet, r.diagnosis, r.treatment, r.notes,
  r.salt, r.data_hash, r.status, r.created_at, r.updated_at, p.full_name AS patient_name, d.full_name AS doctor_name`;
const REC_FROM = `medical_records r
  LEFT JOIN users p ON p.wallet_address = r.patient_wallet
  LEFT JOIN users d ON d.wallet_address = r.doctor_wallet`;
// Kolom item resep, urutan = JSON kanonik (lib/hash.js). ingredients ditambahkan terpisah.
const ITEM_COLS = "type, name, strength, form, quantity, unit, signa, duration, instructions";
const ACTION_TX = { create: "add_record", update: "update_record", delete: "delete_record" };

async function loadRecord(id) {
  const [rows] = await pool.execute(`SELECT ${REC_COLS} FROM ${REC_FROM} WHERE r.id = ?`, [id]);
  if (!rows[0]) throw notFound("Rekam medis tidak ditemukan.");
  return rows[0];
}
// Tulis: hanya Doctor pembuat (kontrak juga menolak dokter lain).
function assertCreator(req, rec) {
  if (rec.doctor_wallet !== req.wallet) throw forbidden("Hanya dokter pembuat yang dapat mengubah rekam medis ini.");
}
const isDup = (err) => err.code === "ER_DUP_ENTRY";
// draft (pending) & draft gagal (failed) hanya untuk dokter pembuatnya; yang lain -> 404.
const isCreator = (req, rec) => req.role === "doctor" && rec.doctor_wallet === req.wallet;
function assertVisible(req, rec) {
  if (!isCreator(req, rec) && rec.status !== "confirmed" && rec.status !== "deleted") throw notFound("Rekam medis tidak ditemukan.");
}
/** Record setelah draft kedaluwarsa dibereskan + cek akses + cek terlihat (dipakai semua endpoint baca). */
async function readableRecord(req, id) {
  await expireStaleDrafts("r.id = ?", [id]);
  const rec = await loadRecord(id);
  await assertPatientAccess(req, rec.patient_wallet);
  assertVisible(req, rec);
  return rec;
}

// Resep
// item_no = urutan di array (1..n), ingredient_no = urutan bahan (1..n) -> urutan JSON kanonik.
async function insertItems(conn, versionId, items) {
  for (const [i, it] of items.entries()) {
    const [r] = await conn.execute(
      `INSERT INTO prescription_items (record_version_id, item_no, ${ITEM_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [versionId, i + 1, it.type, it.name, it.strength, it.form, it.quantity, it.unit, it.signa, it.duration, it.instructions],
    );
    for (const [j, g] of it.ingredients.entries()) {
      await conn.execute(
        "INSERT INTO prescription_ingredients (item_id, ingredient_no, name, strength, amount) VALUES (?, ?, ?, ?, ?)",
        [r.insertId, j + 1, g.name, g.strength, g.amount],
      );
    }
  }
}
/**
 * Item resep per versi: Map(versionId -> [item...]) urut item_no, tiap item berisi
 * ingredients urut ingredient_no ([] untuk single). Bentuk = input JSON kanonik.
 */
async function itemsByVersion(versionIds) {
  const map = new Map(versionIds.map((id) => [Number(id), []]));
  if (!versionIds.length) return map;
  const [rows] = await pool.query(
    `SELECT id, record_version_id, ${ITEM_COLS} FROM prescription_items WHERE record_version_id IN (?) ORDER BY record_version_id, item_no`,
    [versionIds],
  );
  const byItem = new Map();
  for (const { id, record_version_id: v, ...it } of rows) {
    const item = { ...it, ingredients: [] };
    byItem.set(Number(id), item);
    map.get(Number(v))?.push(item);
  }
  if (byItem.size) {
    const [ingr] = await pool.query(
      "SELECT item_id, name, strength, amount FROM prescription_ingredients WHERE item_id IN (?) ORDER BY item_id, ingredient_no",
      [[...byItem.keys()]],
    );
    for (const { item_id: itemId, ...g } of ingr) byItem.get(Number(itemId)).ingredients.push(g);
  }
  return map;
}
/** Resep yang berlaku untuk record = item versi yang hash-nya = record.data_hash. */
async function currentItems(rec) {
  const [[ver]] = await pool.execute(
    "SELECT id FROM medical_record_versions WHERE record_id = ? AND data_hash = ? ORDER BY version_no LIMIT 1",
    [rec.id, rec.data_hash],
  );
  return ver ? (await itemsByVersion([ver.id])).get(Number(ver.id)) : [];
}

/**
 * Verifikasi integritas: hitung ulang hash dari ISI kolom MySQL + resep (bukan memakai kolom
 * data_hash) lalu bandingkan dengan kontrak, dibaca atas nama `asWallet`.
 */
export async function verifyRecordRow(rec, items, asWallet) {
  const localHash = computeDataHash(rec.salt, {
    patient: rec.patient_wallet, doctor: rec.doctor_wallet, diagnosis: rec.diagnosis,
    treatment: rec.treatment, notes: rec.notes, prescriptions: items,
  });
  if (rec.onchain_id === null) return { match: false, localHash, chainHash: null, reason: "Belum tercatat di blockchain." };
  const chain = await getRecordOnChain(rec.onchain_id, asWallet);
  if (chain.revert) return { match: false, localHash, chainHash: null, reason: `Kontrak menolak: ${chain.revert}` };
  const match = chain.record.dataHash === localHash.toLowerCase()
    && chain.record.patient === rec.patient_wallet && chain.record.doctor === rec.doctor_wallet;
  return { match, localHash, chainHash: chain.record.dataHash };
}

// Baca

// GET /api/records/patient/:wallet — daftar rekam medis aktif seorang pasien.
// confirmed untuk semua pembaca; draft pending hanya milik dokter yang meminta.
router.get("/patient/:wallet", requireRole(...READERS), async (req, res) => {
  const wallet = walletParam(req.params.wallet);
  await assertPatientAccess(req, wallet);
  await expireStaleDrafts("r.patient_wallet = ?", [wallet]);
  const [rows] = await pool.execute(
    `SELECT ${REC_COLS} FROM ${REC_FROM}
     WHERE r.patient_wallet = ? AND (r.status = 'confirmed' OR (r.status = 'pending' AND r.doctor_wallet = ?))
     ORDER BY r.created_at DESC, r.id DESC`,
    [wallet, req.wallet], // pasien: req.wallet = pasien != doctor_wallet (chk_records_diff) -> tanpa draft
  );
  res.json({ items: rows });
});

// GET /api/records/:id — detail + resep + riwayat versi (masing-masing dengan resepnya).
// Selain dokter pembuat: hanya versi confirmed (draft update & versi gagal tidak terlihat).
router.get("/:id", requireRole(...READERS), async (req, res) => {
  const rec = await readableRecord(req, idParam(req.params.id));
  const [all] = await pool.execute(
    `SELECT id, version_no, action, diagnosis, treatment, notes, salt, data_hash, tx_hash, status, created_by, created_at
     FROM medical_record_versions WHERE record_id = ? ORDER BY version_no`,
    [rec.id],
  );
  const versions = isCreator(req, rec) ? all : all.filter((v) => v.status === "confirmed");
  const items = await itemsByVersion(versions.map((v) => v.id));
  const current = versions.find((v) => v.data_hash === rec.data_hash);
  res.json({
    ...rec,
    prescriptions: current ? items.get(Number(current.id)) : [],
    versions: versions.map(({ id, ...v }) => ({ ...v, prescriptions: items.get(Number(id)) })),
  });
});

// GET /api/records/:id/verify — { match, localHash, chainHash }
router.get("/:id/verify", requireRole(...READERS), async (req, res) => {
  const rec = await readableRecord(req, idParam(req.params.id));
  res.json(await verifyRecordRow(rec, await currentItems(rec), req.wallet));
});

// GET /api/records/:id/versions/:v/verify — verifikasi versi LAMA (riwayat).
// Kontrak hanya menyimpan hash TERAKHIR, tetapi hash setiap versi tercatat permanen di event
// transaksinya (RecordAdded.dataHash / RecordUpdated.newHash). Hash dihitung ulang dari isi versi
// + resep MILIK versi itu (prescription_items.record_version_id), lalu dibandingkan dengan event.
router.get("/:id/versions/:v/verify", requireRole(...READERS), async (req, res) => {
  const rec = await readableRecord(req, idParam(req.params.id));
  const versionNo = idParam(req.params.v, "v");
  const [[ver]] = await pool.execute("SELECT * FROM medical_record_versions WHERE record_id = ? AND version_no = ?", [rec.id, versionNo]);
  if (!ver || (ver.status !== "confirmed" && !isCreator(req, rec))) throw notFound("Versi rekam medis tidak ditemukan.");
  const localHash = computeDataHash(ver.salt, {
    patient: rec.patient_wallet, doctor: rec.doctor_wallet, diagnosis: ver.diagnosis, treatment: ver.treatment,
    notes: ver.notes, prescriptions: (await itemsByVersion([ver.id])).get(Number(ver.id)),
  });
  const out = { versionNo, localHash, chainHash: null, txHash: ver.tx_hash };
  if (ver.status !== "confirmed") return res.json({ ...out, match: false, reason: `Versi berstatus ${ver.status}; belum tercatat di blockchain.` });
  if (ver.action === "delete") return res.json({ ...out, match: false, reason: "Versi hapus tidak membawa hash (event RecordDeleted)." });
  const [event, key] = ver.action === "create" ? ["RecordAdded", "dataHash"] : ["RecordUpdated", "newHash"];
  try {
    const { args } = await verifyReceipt(ver.tx_hash, event, { id: BigInt(rec.onchain_id), patient: rec.patient_wallet, doctor: rec.doctor_wallet });
    const chainHash = String(args[key]).toLowerCase();
    res.json({ ...out, chainHash, match: chainHash === localHash.toLowerCase() });
  } catch (err) {
    if (err.code !== "TX_INVALID") throw err;
    res.json({ ...out, match: false, reason: err.message }); // mis. node di-restart: transaksi hilang
  }
});

// Tulis (Doctor ber-akses)

// POST /api/records — body { patient, diagnosis, treatment, notes, prescriptions: [...] }
router.post("/", requireRole("doctor"), async (req, res) => {
  const patient = walletParam(req.body?.patient, "patient");
  const v = assertValid(validateRecordWithPrescriptions(req.body));
  if ((await getRole(patient)) !== "patient") throw badRequest("Data tidak valid.", { patient: "Wallet ini bukan pasien terdaftar di kontrak." });
  await assertPatientAccess(req, patient); // dokter wajib sedang merawat pasien (isTreating)
  await expireStaleDrafts("r.patient_wallet = ? AND r.doctor_wallet = ?", [patient, req.wallet]); // draft basi tidak memblokir

  const salt = newSalt();
  const dataHash = computeDataHash(salt, { patient, doctor: req.wallet, ...v });
  const recordId = await withTransaction(async (conn) => {
    const [r] = await conn.execute(
      `INSERT INTO medical_records (patient_wallet, doctor_wallet, diagnosis, treatment, notes, salt, data_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [patient, req.wallet, v.diagnosis, v.treatment, v.notes, salt, dataHash],
    );
    const [ver] = await conn.execute(
      `INSERT INTO medical_record_versions (record_id, version_no, diagnosis, treatment, notes, salt, data_hash, action, status, created_by)
       VALUES (?, 1, ?, ?, ?, ?, ?, 'create', 'pending', ?)`,
      [r.insertId, v.diagnosis, v.treatment, v.notes, salt, dataHash, req.wallet],
    );
    await insertItems(conn, ver.insertId, v.prescriptions);
    await conn.execute(
      "INSERT INTO tx_log (actor_wallet, action, target_wallet, record_id, status) VALUES (?, 'add_record', ?, ?, 'pending')",
      [req.wallet, patient, r.insertId],
    );
    return r.insertId;
  }).catch((err) => {
    // maks 1 draft pending per pasangan dokter–pasien, dijaga UNIQUE di DB (aman dari request paralel).
    if (isDup(err) && /uq_records_pending_draft/.test(err.sqlMessage ?? "")) {
      throw conflict("Masih ada draft rekam medis untuk pasien ini yang menunggu konfirmasi transaksi. Selesaikan dulu atau klik \"Periksa transaksi tertunda\".");
    }
    throw err;
  });
  // salt ikut dikirim agar frontend bisa MENGHITUNG ULANG dataHash sebelum dokter menandatanganinya.
  res.status(201).json({ recordId, versionNo: 1, patient, salt, dataHash });
});

// Buat versi baru (update/delete) berstatus pending TANPA menyentuh medical_records.
// content(rec) -> { diagnosis, treatment, notes, salt, data_hash, prescriptions }
async function createPendingVersion(req, action, content) {
  const id = idParam(req.params.id);
  const pre = await loadRecord(id);
  assertCreator(req, pre);
  await assertPatientAccess(req, pre.patient_wallet); // akses dicabut -> tidak bisa ubah/hapus record sendiri
  const c = await content(pre);
  return withTransaction(async (conn) => {
    const [[rec]] = await conn.execute("SELECT * FROM medical_records WHERE id = ? FOR UPDATE", [id]);
    if (rec.status !== "confirmed") throw conflict(`Rekam medis berstatus ${rec.status}; hanya rekam medis terkonfirmasi yang bisa diubah/dihapus.`);
    if (rec.data_hash !== pre.data_hash) throw conflict("Rekam medis berubah. Muat ulang lalu coba lagi.");
    const [[pending]] = await conn.execute("SELECT version_no FROM medical_record_versions WHERE record_id = ? AND status = 'pending' LIMIT 1", [id]);
    if (pending) throw conflict(`Masih ada versi ${pending.version_no} yang menunggu konfirmasi.`);

    const [[{ next }]] = await conn.execute("SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM medical_record_versions WHERE record_id = ?", [id]);
    const [ver] = await conn.execute(
      `INSERT INTO medical_record_versions (record_id, version_no, diagnosis, treatment, notes, salt, data_hash, action, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, next, c.diagnosis, c.treatment, c.notes, c.salt, c.data_hash, action, req.wallet],
    );
    await insertItems(conn, ver.insertId, c.prescriptions);
    await conn.execute(
      "INSERT INTO tx_log (actor_wallet, action, target_wallet, record_id, status) VALUES (?, ?, ?, ?, 'pending')",
      [req.wallet, ACTION_TX[action], rec.patient_wallet, id],
    );
    return { recordId: id, onchainId: Number(rec.onchain_id), versionNo: Number(next), oldHash: rec.data_hash, salt: c.salt, newHash: c.data_hash };
  });
}

// PUT /api/records/:id — body { diagnosis, treatment, notes, prescriptions } -> versi update (pending)
router.put("/:id", requireRole("doctor"), async (req, res) => {
  const v = assertValid(validateRecordWithPrescriptions(req.body));
  const out = await createPendingVersion(req, "update", (rec) => {
    const salt = newSalt();
    return { ...v, salt, data_hash: computeDataHash(salt, { patient: rec.patient_wallet, doctor: rec.doctor_wallet, ...v }) };
  });
  res.status(201).json(out);
});

// DELETE /api/records/:id -> versi delete (pending); isi & resep = salinan versi terakhir
router.delete("/:id", requireRole("doctor"), async (req, res) => {
  const out = await createPendingVersion(req, "delete", async (rec) => ({ ...rec, prescriptions: await currentItems(rec) }));
  const { newHash, salt, ...rest } = out;
  res.status(201).json(rest);
});

async function loadVersion(recordId, versionNo) {
  const [[ver]] = await pool.execute("SELECT * FROM medical_record_versions WHERE record_id = ? AND version_no = ?", [recordId, versionNo]);
  if (!ver) throw notFound("Versi rekam medis tidak ditemukan.");
  return ver;
}

// Konfirmasi satu versi setelah transaksinya masuk block. Respons TANPA isi medis.
// Tidak mensyaratkan akses: transaksi yang sudah SUKSES di kontrak harus bisa dicatat
// (kontrak sendiri sudah menolak transaksi dokter tanpa akses).
// Dipakai endpoint confirm DAN rekonsiliasi (verifikasi yang sama persis).
async function confirmVersion(wallet, recordId, versionNo, txHash) {
  const rec = await loadRecord(recordId);
  if (rec.doctor_wallet !== wallet) throw forbidden("Hanya dokter pembuat yang dapat mengubah rekam medis ini.");
  const ver = await loadVersion(recordId, versionNo);
  if (ver.status !== "pending") throw conflict(`Versi ini sudah berstatus ${ver.status}.`);
  // txHash yang sudah dicatat ke draft (POST .../tx) tidak bisa diganti hash lain lewat confirm biasa.
  if (ver.tx_hash && ver.tx_hash !== txHash) throw conflict("Versi ini sudah tercatat dengan transaksi lain. Gunakan rekonsiliasi.");
  const [used] = await pool.execute(
    "SELECT 1 FROM medical_record_versions WHERE tx_hash = ? AND id <> ? UNION ALL SELECT 1 FROM tx_log WHERE tx_hash = ? LIMIT 1",
    [txHash, ver.id, txHash],
  );
  if (used.length) throw conflict("txHash ini sudah pernah dipakai.");

  // Event & argumen yang WAJIB ada di receipt (nilai diambil dari database, bukan dari client).
  const who = { patient: rec.patient_wallet, doctor: rec.doctor_wallet };
  let expected;
  if (ver.action === "create") {
    if (rec.status !== "pending") throw conflict("Rekam medis ini sudah dikonfirmasi.");
    expected = ["RecordAdded", { ...who, dataHash: ver.data_hash }];
  } else {
    if (rec.status !== "confirmed") throw conflict(`Rekam medis berstatus ${rec.status}.`);
    const id = BigInt(rec.onchain_id);
    expected = ver.action === "update"
      ? ["RecordUpdated", { id, ...who, oldHash: rec.data_hash, newHash: ver.data_hash }]
      : ["RecordDeleted", { id, ...who }];
  }
  const { args } = await verifyReceipt(txHash, ...expected);

  try {
    await withTransaction(async (conn) => {
      // Kunci & cek ulang: cegah dua konfirmasi bersamaan untuk versi/record yang sama.
      const [[v2]] = await conn.execute("SELECT status FROM medical_record_versions WHERE id = ? FOR UPDATE", [ver.id]);
      const [[r2]] = await conn.execute("SELECT status, data_hash FROM medical_records WHERE id = ? FOR UPDATE", [recordId]);
      if (v2.status !== "pending" || r2.status !== rec.status || r2.data_hash !== rec.data_hash) throw conflict("Data berubah saat konfirmasi. Muat ulang lalu coba lagi.");

      await conn.execute("UPDATE medical_record_versions SET tx_hash = ?, status = 'confirmed' WHERE id = ?", [txHash, ver.id]);
      if (ver.action === "create") {
        await conn.execute("UPDATE medical_records SET onchain_id = ?, status = 'confirmed' WHERE id = ?", [Number(args.id), recordId]);
      } else if (ver.action === "update") {
        // Resep ikut berpindah otomatis: resep berlaku = item versi dengan data_hash ini.
        await conn.execute(
          "UPDATE medical_records SET diagnosis = ?, treatment = ?, notes = ?, salt = ?, data_hash = ? WHERE id = ?",
          [ver.diagnosis, ver.treatment, ver.notes, ver.salt, ver.data_hash, recordId],
        );
      } else {
        await conn.execute("UPDATE medical_records SET status = 'deleted' WHERE id = ?", [recordId]);
      }
      const [[log]] = await conn.execute(
        "SELECT id FROM tx_log WHERE record_id = ? AND action = ? AND status = 'pending' ORDER BY id DESC LIMIT 1 FOR UPDATE",
        [recordId, ACTION_TX[ver.action]],
      );
      if (log) await conn.execute("UPDATE tx_log SET tx_hash = ?, status = 'confirmed', error_message = NULL WHERE id = ?", [txHash, log.id]);
    });
  } catch (err) {
    if (isDup(err)) throw conflict("txHash atau id on-chain ini sudah dipakai rekam medis lain.");
    throw err;
  }
  return summary(recordId, { confirmedVersion: versionNo, txHash });
}
// Ringkasan status tanpa isi medis.
async function summary(id, extra = {}) {
  const [[r]] = await pool.execute("SELECT id, onchain_id, status, data_hash, updated_at FROM medical_records WHERE id = ?", [id]);
  return { recordId: Number(r.id), onchainId: r.onchain_id === null ? null : Number(r.onchain_id), status: r.status, dataHash: r.data_hash, updatedAt: r.updated_at, ...extra };
}

// POST /api/records/:id/confirm { txHash } — konfirmasi addRecord (versi 1)
router.post("/:id/confirm", requireRole("doctor"), async (req, res) => {
  res.json(await confirmVersion(req.wallet, idParam(req.params.id), 1, hashParam(req.body?.txHash)));
});

// POST /api/records/:id/versions/:v/confirm { txHash } — konfirmasi update/delete
router.post("/:id/versions/:v/confirm", requireRole("doctor"), async (req, res) => {
  res.json(await confirmVersion(req.wallet, idParam(req.params.id), idParam(req.params.v, "v"), hashParam(req.body?.txHash)));
});

// Panggilan kontrak yang WAJIB dikirim untuk sebuah draft (argumen dari database, bukan client).
function expectedCall(rec, ver) {
  if (ver.action === "create") return ["addRecord", [rec.patient_wallet, ver.data_hash]];
  return ver.action === "update" ? ["updateRecord", [BigInt(rec.onchain_id), ver.data_hash]] : ["deleteRecord", [BigInt(rec.onchain_id)]];
}

// POST /api/records/:id/versions/:v/tx { txHash } — catat txHash ke draft SEGERA setelah tx dikirim
// (sebelum receipt). Status tetap pending; jika confirm tidak sempat dipanggil (tab ditutup, koneksi
// putus), POST /reconcile memakai hash ini. Tx harus panggilan kontrak yang persis untuk draft ini.
router.post("/:id/versions/:v/tx", requireRole("doctor"), async (req, res) => {
  const recordId = idParam(req.params.id);
  const versionNo = idParam(req.params.v, "v");
  const txHash = hashParam(req.body?.txHash);
  const rec = await loadRecord(recordId);
  assertCreator(req, rec);
  const ver = await loadVersion(recordId, versionNo);
  if (ver.status !== "pending") throw conflict(`Versi ini sudah berstatus ${ver.status}.`);
  if (ver.tx_hash !== null && ver.tx_hash !== txHash) throw conflict("Versi ini sudah tercatat dengan transaksi lain.");
  await verifySentTx(txHash, req.wallet, ...expectedCall(rec, ver));
  try {
    await pool.execute("UPDATE medical_record_versions SET tx_hash = ? WHERE id = ? AND status = 'pending' AND (tx_hash IS NULL OR tx_hash = ?)", [txHash, ver.id, txHash]);
  } catch (err) {
    throw isDup(err) ? conflict("txHash ini sudah pernah dipakai.") : err;
  }
  res.json({ recordId, versionNo, txHash, status: "pending" });
});

/**
 * Tandai satu versi pending gagal (transaksi DB): versi -> failed, record create -> failed, tx_log -> failed.
 * versionNo null = versi pending terakhir. txHash wajib sama dengan yang sudah dicatat ke draft (jika ada):
 * draft yang txHash-nya tercatat tidak bisa ditandai "ditolak di MetaMask".
 */
async function failVersion(id, versionNo, txHash, reason) {
  let failedVersion;
  await withTransaction(async (conn) => {
    const [[ver]] = versionNo
      ? await conn.execute("SELECT * FROM medical_record_versions WHERE record_id = ? AND version_no = ? FOR UPDATE", [id, versionNo])
      : await conn.execute("SELECT * FROM medical_record_versions WHERE record_id = ? AND status = 'pending' ORDER BY version_no DESC LIMIT 1 FOR UPDATE", [id]);
    if (!ver) throw notFound("Tidak ada versi yang menunggu konfirmasi.");
    if (ver.status !== "pending") throw conflict(`Versi ini sudah berstatus ${ver.status}.`);
    if (ver.tx_hash !== null && ver.tx_hash !== txHash) throw conflict("Transaksi versi ini sudah terkirim; gunakan rekonsiliasi.");
    failedVersion = Number(ver.version_no);

    await conn.execute("UPDATE medical_record_versions SET status = 'failed', tx_hash = ? WHERE id = ?", [txHash, ver.id]);
    if (ver.action === "create") await conn.execute("UPDATE medical_records SET status = 'failed' WHERE id = ? AND status = 'pending'", [id]);
    const [[log]] = await conn.execute(
      "SELECT id FROM tx_log WHERE record_id = ? AND action = ? AND status = 'pending' ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [id, ACTION_TX[ver.action]],
    );
    if (log) await conn.execute("UPDATE tx_log SET status = 'failed', tx_hash = ?, error_message = ? WHERE id = ?", [txHash, reason, log.id]);
  }).catch((err) => { throw isDup(err) ? conflict("txHash ini sudah pernah dipakai.") : err; });
  return failedVersion;
}

/**
 * Tx tercatat di versi pending gagal, tetapi tx draft yang sukses ada on-chain. tx_hash yang sudah terisi tidak
 * pernah diganti (trigger): versi lama & baris tx_log-nya -> failed apa adanya, lalu isi + resep disalin ke VERSI
 * BARU (pending) dengan baris tx_log baru. Record tetap berstatus seperti sebelumnya. Mengembalikan version_no baru.
 */
async function supersedeVersion(rec, draft, reason) {
  const ver = await loadVersion(rec.id, draft.version_no);
  const items = (await itemsByVersion([ver.id])).get(Number(ver.id));
  return withTransaction(async (conn) => {
    const [[v2]] = await conn.execute("SELECT status, tx_hash FROM medical_record_versions WHERE id = ? FOR UPDATE", [ver.id]);
    if (v2.status !== "pending" || v2.tx_hash !== ver.tx_hash) throw conflict("Versi berubah saat rekonsiliasi.");
    await conn.execute("UPDATE medical_record_versions SET status = 'failed' WHERE id = ?", [ver.id]);
    const [[log]] = await conn.execute(
      "SELECT id FROM tx_log WHERE record_id = ? AND action = ? AND status = 'pending' ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [rec.id, ACTION_TX[ver.action]],
    );
    if (log) await conn.execute("UPDATE tx_log SET status = 'failed', tx_hash = ?, error_message = ? WHERE id = ?", [ver.tx_hash, reason, log.id]);

    const [[{ next }]] = await conn.execute("SELECT MAX(version_no) + 1 AS next FROM medical_record_versions WHERE record_id = ?", [rec.id]);
    const [nv] = await conn.execute(
      `INSERT INTO medical_record_versions (record_id, version_no, diagnosis, treatment, notes, salt, data_hash, action, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [rec.id, next, ver.diagnosis, ver.treatment, ver.notes, ver.salt, ver.data_hash, ver.action, ver.created_by],
    );
    await insertItems(conn, nv.insertId, items);
    await conn.execute(
      "INSERT INTO tx_log (actor_wallet, action, target_wallet, record_id, status) VALUES (?, ?, ?, ?, 'pending')",
      [ver.created_by, ACTION_TX[ver.action], rec.patient_wallet, rec.id],
    );
    return Number(next);
  }).catch((err) => { throw isDup(err) ? conflict("txHash ini sudah pernah dipakai.") : err; });
}

// POST /api/records/:id/fail { reason, txHash?, versionNo? } — tandai transaksi gagal.
// Tanpa txHash = ditolak di MetaMask (tidak pernah terkirim). Dengan txHash = harus transaksi DRAFT INI
// (pengirim = dokter, ke kontrak, fungsi & argumen = draft) yang benar-benar revert.
// Dalam kedua kasus: jika event draft ini SUDAH ada on-chain (mis. dikirim ulang & sukses), menandainya
// gagal membuat MySQL beda permanen dengan kontrak -> tolak, pakai rekonsiliasi.
router.post("/:id/fail", requireRole("doctor"), async (req, res) => {
  const id = idParam(req.params.id);
  const body = req.body ?? {};
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  // reason ditulis ke tx_log.error_message -> aturan karakter yang sama (frontend membersihkan pesan error dulu).
  if (reason && !isCleanText(body.reason, true)) throw invalidText("reason", textMessage("Alasan", true));
  if (reason.length < 1 || reason.length > 255) throw badRequest("Data tidak valid.", { reason: "Alasan wajib 1–255 karakter." });
  const txHash = body.txHash === undefined || body.txHash === null ? null : hashParam(body.txHash);
  const versionNo = body.versionNo === undefined ? null : idParam(String(body.versionNo), "versionNo");

  const rec = await loadRecord(id);
  assertCreator(req, rec);
  const [[ver]] = versionNo
    ? await pool.execute("SELECT * FROM medical_record_versions WHERE record_id = ? AND version_no = ?", [id, versionNo])
    : await pool.execute("SELECT * FROM medical_record_versions WHERE record_id = ? AND status = 'pending' ORDER BY version_no DESC LIMIT 1", [id]);
  if (ver?.status === "pending") { // versi tidak ada / sudah final -> failVersion menjawab 404/409
    if (txHash) {
      await verifySentTx(txHash, req.wallet, ...expectedCall(rec, ver)); // tx lain (milik siapa pun) -> 422
      let receipt;
      try { receipt = await provider.getTransactionReceipt(txHash); } catch { receipt = undefined; }
      if (receipt === undefined) throw badRequest("Tidak bisa memeriksa transaksi di blockchain.");
      if (receipt === null) throw conflict("Transaksi belum masuk block; tunggu sampai selesai sebelum menandai gagal.");
      if (receipt.status === 1) throw conflict("Transaksi ini sukses di blockchain. Gunakan endpoint confirm.");
    }
    if (await findDraftTx(rec, ver)) {
      throw conflict("Transaksi draft ini sudah tercatat di blockchain. Gunakan rekonsiliasi (Periksa transaksi tertunda).");
    }
  }
  const failedVersion = await failVersion(id, versionNo, txHash, reason);
  res.json(await summary(id, { failedVersion }));
});

// Rekonsiliasi draft pending
// Draft tanpa txHash yang lebih tua dari ini dianggap tidak pernah ditandatangani.
export const DRAFT_EXPIRY_MINUTES = 15;

// Event on-chain yang PERSIS cocok dengan draft (hash unik karena salt acak) -> txHash-nya, atau null.
// Menangani tx yang sah walau txHash-nya tidak sempat dicatat (tab ditutup tepat setelah MetaMask mengirim).
async function findDraftTx(rec, ver) {
  const who = [rec.patient_wallet, rec.doctor_wallet];
  let logs;
  if (ver.action === "create") logs = (await findEvents("RecordAdded", [null, ...who])).filter((l) => l.args.dataHash.toLowerCase() === ver.data_hash);
  else if (rec.onchain_id === null) return null;
  else if (ver.action === "update") logs = (await findEvents("RecordUpdated", [rec.onchain_id, ...who])).filter((l) => l.args.newHash.toLowerCase() === ver.data_hash);
  else logs = await findEvents("RecordDeleted", [rec.onchain_id, ...who]);
  return logs.length === 1 ? logs[0].transactionHash.toLowerCase() : null;
}

/**
 * Satu draft pending -> { result: "confirmed" | "failed" | "pending", reason } (tanpa isi medis).
 * Event on-chain = sumber kebenaran: tx tercatat yang revert/hilang/tidak cocok TIDAK menggagalkan draft bila
 * event draft yang sah ada di tx lain; draft dikonfirmasi dengan tx itu (calldata + receipt + event diverifikasi).
 */
async function reconcileVersion(wallet, ver, ageMinutes) {
  const rec = await loadRecord(ver.record_id);
  const expired = ageMinutes >= DRAFT_EXPIRY_MINUTES;
  const confirm = async (txHash, versionNo = ver.version_no) => {
    try {
      await confirmVersion(wallet, rec.id, versionNo, txHash);
      return { result: "confirmed", reason: null, txHash, versionNo: Number(versionNo) };
    } catch (err) {
      if (err.code === "TX_INVALID") {
        // Tx sukses tetapi BUKAN transaksi draft ini (event/argumen tidak cocok): jangan dikonfirmasi.
        if (versionNo !== ver.version_no) return { result: "pending", reason: err.message, versionNo: Number(versionNo) };
        return failed(ver.tx_hash, `Transaksi tercatat tidak cocok dengan draft: ${err.message}`.slice(0, 255));
      }
      if (err.status === 409) return { result: "pending", reason: err.message };
      throw err;
    }
  };
  const failed = async (txHash, reason) => {
    // Event on-chain = sumber kebenaran: tx tercatat gagal, tetapi tx draft yang sukses ada di tx lain.
    const onchain = ver.tx_hash ? await findDraftTx(rec, ver) : null;
    if (onchain && onchain !== ver.tx_hash) {
      try {
        await verifySentTx(onchain, rec.doctor_wallet, ...expectedCall(rec, ver));
      } catch (err) {
        if (err.code === "TX_INVALID") return { result: "pending", reason: err.message };
        throw err;
      }
      return confirm(onchain, await supersedeVersion(rec, ver, reason));
    }
    await failVersion(rec.id, ver.version_no, txHash, reason);
    return { result: "failed", reason };
  };
  const txHash = ver.tx_hash ?? await findDraftTx(rec, ver);
  if (!txHash) {
    return expired ? failed(null, "Kedaluwarsa, tidak ditandatangani.") : { result: "pending", reason: "Menunggu tanda tangan di MetaMask." };
  }
  const receipt = await txReceipt(txHash);
  if (!receipt) {
    if (!expired || await txKnown(txHash)) return { result: "pending", reason: "Transaksi belum masuk block." };
    return failed(ver.tx_hash, "Transaksi tidak ditemukan di blockchain (kedaluwarsa).");
  }
  if (receipt.status !== 1) return failed(txHash, "Transaksi gagal (revert) di blockchain.");
  return confirm(txHash);
}

/**
 * kedaluwarsakan draft TANPA txHash yang lebih tua dari DRAFT_EXPIRY_MINUTES milik record yang cocok
 * dengan `where` (konstanta dari kode, nilai lewat `params`). Dipanggil saat data DIBACA siapa pun (pasien,
 * dokter lain, dokter pembuat), jadi draft basi tidak bergantung pada /reconcile pembuatnya. Event on-chain
 * diperiksa dulu (reconcileVersion = logika rekonsiliasi): tx draft yang ternyata sudah masuk blok -> confirmed.
 * Dua pembaca bersamaan: yang kalah mendapat 409 dari failVersion/confirmVersion -> diabaikan.
 */
async function expireStaleDrafts(where, params) {
  const [drafts] = await pool.execute(
    `SELECT v.record_id, v.version_no, v.tx_hash, v.action, v.data_hash, v.created_by, TIMESTAMPDIFF(MINUTE, v.created_at, NOW()) AS age
     FROM medical_record_versions v JOIN medical_records r ON r.id = v.record_id
     WHERE ${where} AND v.status = 'pending' AND v.tx_hash IS NULL AND TIMESTAMPDIFF(MINUTE, v.created_at, NOW()) >= ?`,
    [...params, DRAFT_EXPIRY_MINUTES],
  );
  for (const d of drafts) {
    await reconcileVersion(d.created_by, d, Number(d.age)).catch((err) => { if (err.status !== 409) throw err; });
  }
}

// POST /api/records/reconcile — Doctor: periksa ulang SEMUA draft pending miliknya ke blockchain.
// Punya txHash -> receipt -> verifikasi yang sama dengan confirm -> confirmed, atau failed jika revert.
// Tanpa txHash -> cari event yang cocok; tidak ada & lebih tua dari DRAFT_EXPIRY_MINUTES -> failed.
router.post("/reconcile", requireRole("doctor"), async (req, res) => {
  const [drafts] = await pool.execute(
    `SELECT record_id, version_no, tx_hash, action, data_hash, TIMESTAMPDIFF(MINUTE, created_at, NOW()) AS age
     FROM medical_record_versions WHERE created_by = ? AND status = 'pending' ORDER BY record_id, version_no`,
    [req.wallet],
  );
  const items = [];
  for (const d of drafts) {
    const r = await reconcileVersion(req.wallet, d, Number(d.age));
    items.push({ recordId: Number(d.record_id), versionNo: Number(d.version_no), action: d.action, ...r });
  }
  const count = (s) => items.filter((i) => i.result === s).length;
  res.json({ items, confirmed: count("confirmed"), failed: count("failed"), pending: count("pending") });
});

export default router;

// /api/prescriptions — resep digital (bagian dari rekam medis CONFIRMED).
export const prescriptionsRouter = Router();

// GET /api/prescriptions/me — Patient: semua resep miliknya + status verifikasi on-chain.
prescriptionsRouter.get("/me", requireRole("patient"), async (req, res) => {
  const [recs] = await pool.execute(
    `SELECT ${REC_COLS} FROM ${REC_FROM} WHERE r.patient_wallet = ? AND r.status = 'confirmed' ORDER BY r.updated_at DESC, r.id DESC`,
    [req.wallet],
  );
  // shortcut: verifikasi on-chain per resep (N eth_call); untuk banyak resep, verifikasi per halaman/detail saja.
  const out = [];
  for (const rec of recs) {
    const items = await currentItems(rec);
    if (!items.length) continue;
    out.push(prescriptionView(rec, items, await verifyRecordRow(rec, items, req.wallet)));
  }
  res.json({ items: out });
});

// GET /api/prescriptions/:recordId — Patient pemilik, Doctor ber-akses aktif. Admin ditolak.
prescriptionsRouter.get("/:recordId", requireRole(...READERS), async (req, res) => {
  const rec = await loadRecord(idParam(req.params.recordId, "recordId"));
  await assertPatientAccess(req, rec.patient_wallet);
  if (rec.status !== "confirmed") throw notFound("Resep belum tercatat di blockchain.");
  const items = await currentItems(rec);
  res.json(prescriptionView(rec, items, await verifyRecordRow(rec, items, req.wallet)));
});

function prescriptionView(rec, items, verify) {
  return {
    recordId: Number(rec.id), onchainId: Number(rec.onchain_id),
    patient_wallet: rec.patient_wallet, patient_name: rec.patient_name,
    doctor_wallet: rec.doctor_wallet, doctor_name: rec.doctor_name,
    diagnosis: rec.diagnosis, created_at: rec.created_at, updated_at: rec.updated_at,
    prescriptions: items, verified: verify.match, localHash: verify.localHash, chainHash: verify.chainHash,
  };
}
