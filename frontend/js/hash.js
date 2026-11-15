// hash.js — hash kanonik rekam medis (FRONTEND).
// HARUS identik dengan backend/lib/hash.js (diuji dengan test vector tetap di scripts/test-hash.js).
//   data_hash = keccak256( salt || utf8(JSON kanonik) )
//   JSON kanonik (urutan key TETAP, wallet lowercase):
//     {"patient","doctor","diagnosis","treatment","notes",
//      "prescriptions":[{"type","name","strength","form","quantity","unit","signa","duration",
//                        "instructions","ingredients":[{"name","strength","amount"}]}]}
//   Field opsional kosong = null; quantity bilangan bulat; tipe lain ditolak (TypeError).
//   Hitung dari data API apa adanya (= nilai tersimpan); salt dibuat backend (32 byte acak).
import { keccak256, concat, getBytes, toUtf8Bytes } from "../vendor/ethers.min.js";

const text = (v, k) => {
  if (typeof v !== "string") throw new TypeError(`hash: ${k} harus string`);
  // Lone surrogate tidak punya bentuk UTF-8 yang sah (MySQL menyimpannya sebagai U+FFFD) -> tolak, jangan di-hash.
  if (!v.isWellFormed()) throw new TypeError(`hash: ${k} bukan teks Unicode yang valid (lone surrogate)`);
  return v;
};
const optText = (v, k) => (v === null || v === undefined ? null : text(v, k));
const int = (v, k) => {
  if (!Number.isSafeInteger(v)) throw new TypeError(`hash: ${k} harus bilangan bulat`);
  return v;
};

export function canonicalJson(r) {
  return JSON.stringify({
    patient: text(r.patient, "patient").toLowerCase(),
    doctor: text(r.doctor, "doctor").toLowerCase(),
    diagnosis: text(r.diagnosis, "diagnosis"),
    treatment: text(r.treatment, "treatment"),
    notes: text(r.notes ?? "", "notes"),
    prescriptions: (r.prescriptions ?? []).map((p) => ({
      type: text(p.type, "type"),
      name: text(p.name, "name"),
      strength: optText(p.strength, "strength"),
      form: text(p.form, "form"),
      quantity: int(p.quantity, "quantity"),
      unit: text(p.unit, "unit"),
      signa: text(p.signa, "signa"),
      duration: text(p.duration, "duration"),
      instructions: optText(p.instructions, "instructions"),
      ingredients: (p.ingredients ?? []).map((g) => ({
        name: text(g.name, "ingredients.name"),
        strength: text(g.strength, "ingredients.strength"),
        amount: text(g.amount, "ingredients.amount"),
      })),
    })),
  });
}

export function computeDataHash(salt, record) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("salt harus 32 byte (0x + 64 hex)");
  return keccak256(concat([getBytes(salt), toUtf8Bytes(canonicalJson(record))]));
}
