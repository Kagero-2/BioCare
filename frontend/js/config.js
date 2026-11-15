// config.js — konfigurasi blockchain lokal (Hardhat Network).
// Bukan secret: alamat kontrak & RPC lokal boleh terlihat publik.
import { JsonRpcProvider } from "../vendor/ethers.min.js";
import abi from "./abi/HospitalRecords.js"; // hasil `npm run compile`

export const CHAIN_ID = 31337;
export const CHAIN_NAME = "Hardhat Local";
export const RPC_URL = "http://127.0.0.1:8545";
// Alamat deterministik: deploy PERTAMA (nonce 0) dari akun #0 Hardhat.
// Jika berbeda (ada transaksi lain sebelum deploy), ganti di sini & di .env backend.
export const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const CONTRACT_ABI = abi;

/**
 * Cek di awal aplikasi: node lokal hidup, chainId benar, dan kontrak ada di CONTRACT_ADDRESS.
 * Mengembalikan { ok: true } atau { ok: false, message } berisi pesan yang jelas untuk pengguna
 * (bukan error mentah ethers).
 */
export async function checkContractDeployed(provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true })) {
  try {
    const chainId = Number(await provider.send("eth_chainId", []));
    if (chainId !== CHAIN_ID) {
      return { ok: false, message: `Network salah (chainId ${chainId}). Pilih network ${CHAIN_NAME} (chainId ${CHAIN_ID}).` };
    }
    const code = await provider.getCode(CONTRACT_ADDRESS);
    if (code === "0x") {
      return { ok: false, message: `Kontrak belum di-deploy di node lokal (alamat ${CONTRACT_ADDRESS}). Deploy lewat Remix sebagai transaksi pertama akun #0, atau jalankan npm run deploy:local.` };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: `Node lokal tidak terjangkau di ${RPC_URL}. Jalankan npm run chain lalu muat ulang halaman.` };
  } finally {
    if (provider instanceof JsonRpcProvider) provider.destroy();
  }
}
