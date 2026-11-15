// CADANGAN untuk development: deploy HospitalRecords ke node lokal + data role awal.
// Deploy utama tetap lewat Remix. Jalankan: npm run chain (terminal lain), lalu npm run deploy:local.
//   #0 Admin (deployer, transaksi PERTAMA) · #1, #2, #5 Doctor · #3, #6–#8 Patient · #4 tanpa role
//   (spesialisasi dokter ada di database/seed.sql: #1 Umum, #2 Anak, #5 Penyakit Dalam)
//   Akses awal: pasien #3 -> Doctor #1, berlaku 3 hari (pasangannya: appointment #1 ACCEPTED di database/seed.sql,
//   karena dokter baru boleh membaca data pasien jika akses on-chain aktif DAN ada appointment yang ia terima).
// Setelah kontrak diubah (mis. mengubah akses/role): npm run compile, restart node (npm run chain), lalu jalankan
// skrip ini lagi di chain bersih.
import { network } from "hardhat";

const { ethers } = await network.create({ network: "localhost" });
const signers = await ethers.getSigners();
const [admin] = signers;
const doctors = [1, 2, 5].map((i) => signers[i]);
const patients = [3, 6, 7, 8].map((i) => signers[i]);

// Alamat kontrak ditentukan oleh (deployer, nonce). Nonce harus 0 agar alamatnya sama
// dengan CONTRACT_ADDRESS default di frontend/js/config.js.
const nonce = await ethers.provider.getTransactionCount(admin.address);
if (nonce !== 0) {
  console.error(`Akun #0 sudah punya ${nonce} transaksi. Restart node (npm run chain) lalu jalankan lagi.`);
  process.exit(1);
}

const contract = await ethers.deployContract("HospitalRecords", [], admin);
await contract.waitForDeployment();
const address = await contract.getAddress();

const ROLE_DOCTOR = 2; // enum Role { None, Admin, Doctor, Patient }
for (const d of doctors) {
  await (await contract.connect(admin).grantRole(d.address, ROLE_DOCTOR)).wait();
}
for (const p of patients) {
  await (await contract.connect(p).registerAsPatient()).wait();
}
// Akses perawatan awal: pasien #3 -> Doctor #1, kedaluwarsa 3 hari dari block terakhir.
const { timestamp } = await ethers.provider.getBlock("latest");
const expiresAt = timestamp + 3 * 24 * 60 * 60;
await (await contract.connect(signers[3]).grantDoctorAccess(signers[1].address, expiresAt)).wait();

const names = ["None", "Admin", "Doctor", "Patient"];
console.log(`HospitalRecords: ${address}`);
for (const [i, s] of signers.slice(0, 9).entries()) {
  console.log(`  #${i} ${s.address} -> ${names[Number(await contract.getRole(s.address))]}`);
}
const exp = await contract.getAccessExpiry(signers[3].address, signers[1].address);
console.log(`  akses #3 -> #1: ${await contract.hasAccess(signers[3].address, signers[1].address)} (s.d. ${new Date(Number(exp) * 1000).toISOString()})`);
