// hash.js — hash kanonik rekam medis (BACKEND).
// HARUS identik dengan frontend/js/hash.js (diuji dengan test vector tetap di scripts/test-hash.js).
//   data_hash = keccak256( salt || utf8(JSON kanonik) )
//   JSON kanonik (urutan key TETAP, JSON.stringify standar tanpa spasi, wallet lowercase):
//     {"patient","doctor","diagnosis","treatment","notes",
//      "prescriptions":[{"type","name","strength","form","quantity","unit","signa","duration",
//                        "instructions","ingredients":[{"name","strength","amount"}]}]}
//   - urutan item = item_no, urutan bahan = ingredient_no; ingredients = [] untuk single;
//   - field opsional kosong (strength & instructions item) = null, key TIDAK dihilangkan;
//   - tipe: semua string (atau null untuk field opsional), kecuali quantity = bilangan bulat.
//     Tipe lain DITOLAK (TypeError), bukan dikonversi, agar backend & frontend tidak pernah beda.
//   - Normalisasi teks (trim + NFC) TIDAK dilakukan di sini, tetapi SEKALI di validator
//     (backend/lib/validate.js) sebelum disimpan; hash selalu dihitung dari nilai tersimpan.
//   salt = 32 byte acak (0x + 64 hex), unik per versi: hash tidak bisa ditebak dari isi
//          yang umum (mis. "Demam") walau hash-nya publik di blockchain.
import { randomBytes } from "node:crypto";
import { keccak256, concat, getBytes, toUtf8Bytes } from "ethers";

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

export const newSalt = () => "0x" + randomBytes(32).toString("hex");
