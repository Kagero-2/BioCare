# BioCare

Aplikasi manajemen rumah sakit sederhana berbasis blockchain. Login memakai wallet MetaMask, role dan izin akses dokter dicatat di smart contract, dan setiap rekam medis bisa diverifikasi keasliannya.

## Fitur

- **Login dengan wallet** (Sign-In with Ethereum), tanpa password.
- **Tiga role:** Admin, Dokter, Pasien.
- **Appointment:** booking, jadwal ulang, pembatalan, terima/tolak oleh dokter.
- **Izin akses dokter:** pasien memberi akses ke dokter dengan masa berlaku, dan bisa mencabutnya kapan saja.
- **Rekam medis & resep digital:** resep satuan atau racikan, bisa dicetak (A4).
- **Verifikasi rekam medis:** isi rekam medis dicocokkan dengan hash di blockchain ("Terverifikasi" / "Data tidak cocok").
- **Riwayat aktivitas** dari event blockchain, difilter sesuai role.

## Prasyarat

| Kebutuhan | Keterangan | Unduh |
|---|---|---|
| Windows | Runner `.bat` hanya untuk Windows | - |
| XAMPP (MariaDB) | MySQL sudah di-Start di XAMPP Control Panel (port 3306) | https://www.apachefriends.org/download.html |
| Node.js >= 22.10 | Syarat Hardhat 3 | https://nodejs.org/en/download |
| Google Chrome | Browser untuk aplikasi | https://www.google.com/chrome/ |
| MetaMask | Ekstensi Chrome | https://metamask.io/download/ |

## Mulai cepat (Windows)

0. Start MySQL di XAMPP Control Panel.
1. `setup.bat` (sekali saja).
2. `start.bat` (setiap kali menjalankan aplikasi).

Cara utama: double-click file `.bat` di Explorer. Dari `cmd` di folder proyek, awali dengan `.\`:

```bat
.\setup.bat
.\start.bat
.\stop.bat
```

| Runner | Fungsi |
|---|---|
| `setup.bat` | Sekali saja. Cek prasyarat, `npm ci`, `npm run vendor`, `npm run compile`, buat `.env` dengan secret acak, lalu bangun database sebagai root MySQL (menanyakan password root bila ada). Opsi `--dry-run` hanya mencetak langkah. |
| `start.bat` | Menutup node lama, membuka jendela **BioCare Chain** (log: `scripts\run\logs\chain.log`), deploy kontrak + role awal, reset + seed database, membuka jendela **BioCare Backend**. |
| `stop.bat` | Menghentikan node.exe di port 8545 dan 3000. MySQL tidak disentuh. |

Buka **http://127.0.0.1:3000**, bukan `localhost` (ditolak: `BAD_ORIGIN`).

## Database

| File di `database/` | Isi |
|---|---|
| `schema.sql` | Database `hospital_dapp`, tabel, trigger (menghapus database lama) |
| `users.sql` | User aplikasi `hospital_app` dan `hospital_reset`; password masih placeholder |
| `seed.sql` | Data contoh: 8 profil + 2 appointment |
| `reset.sql` | Mengosongkan semua data (struktur tetap) |

- `setup.bat` menjalankan `schema.sql`, `users.sql`, lalu `seed.sql` sebagai root. Password user diambil otomatis dari `.env` yang dibuatnya.
- `start.bat` mengembalikan data ke data contoh setiap kali dijalankan, karena kontrak ikut di-deploy ulang ke node baru.
- Data yang dibuat saat pemakaian hilang setelah `start.bat` dijalankan lagi.

## MetaMask

| Pengaturan | Nilai |
|---|---|
| Nama network | Hardhat Local |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Simbol | `ETH` |

1. Tambahkan network di atas.
2. Import private key akun uji (tabel di bawah).
3. Setiap kali node di-restart (`start.bat`): Settings, Advanced, **Clear activity tab data** untuk tiap akun yang dipakai.

## Akun uji

| # | Akun | Role | Private key |
|---|---|---|---|
| 0 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | Admin (deployer) | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| 1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | Doctor (Umum) | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| 2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | Doctor (Anak) | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |
| 3 | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | Patient (akses awal ke #1) | `0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6` |
| 4 | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` | Tanpa role (uji registrasi pasien) | `0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a` |
| 5 | `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` | Doctor (Penyakit Dalam) | `0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba` |
| 6 | `0x976EA74026E726554dB657fA54763abd0C3a0aa9` | Patient | `0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e` |
| 7 | `0x14dC79964da2C08b23698B3D3cc7Ca32193d9955` | Patient | `0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356` |
| 8 | `0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f` | Patient | `0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97` |
| 9 | `0xa0Ee7A142d267C1f36714E4a8F75612F20a79720` | Tanpa role | `0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6` |

Kunci ini publik (bawaan Hardhat), hanya untuk jaringan lokal. Jangan pernah dipakai di jaringan sungguhan.

## Struktur

```
contracts/     Smart contract (Solidity 0.8.24)
backend/       Server API (Node.js + Express 5)
frontend/      Tampilan web (HTML, CSS, JavaScript + ethers v6)
database/      Skema, user, dan data contoh MySQL
scripts/       Deploy kontrak, reset database, dan logika runner
setup.bat      Instalasi pertama
start.bat      Menjalankan aplikasi
stop.bat       Menghentikan aplikasi
.env.example   Template konfigurasi
```

## Role

| Role | Bisa melakukan |
|---|---|
| Admin | Beri/cabut role Dokter, kelola profil, lihat statistik dan riwayat aktivitas, cabut akses dokter ke pasien. Tidak melihat isi rekam medis maupun resep; data pasien tersamar. |
| Dokter | Terima/tolak/jadwal ulang appointment (alasan wajib), tambah/ubah/hapus rekam medis dan resep miliknya, baca data pasien yang aksesnya aktif dan appointment-nya sudah ia terima, lepas akses. |
| Pasien | Daftar sendiri, booking/reschedule/cancel appointment, beri/perpanjang/cabut akses dokter, baca rekam medis dan resep miliknya, verifikasi rekam medis, kelola profil sendiri. |

Admin = akun yang men-deploy kontrak. Kontrak dan backend menegakkan setiap aturan; UI hanya menyembunyikan tombol.

## Cara kerja login

1. Pengguna menghubungkan wallet (langkah Connect); MetaMask memberi alamat.
2. Browser meminta nonce: `POST /api/auth/nonce`. Server menyusun pesan SIWE (nonce acak, berlaku 5 menit).
3. MetaMask menandatangani pesan: gratis, tanpa gas, tanpa transaksi.
4. `POST /api/auth/verify`: server memeriksa pesan, signature, dan nonce (sekali pakai), lalu membaca role dari kontrak. Wallet tanpa role diarahkan ke registrasi pasien.
5. Server mengirim cookie sesi HttpOnly, SameSite=Strict, berlaku 8 jam. Logout langsung mencabut sesi.
6. Role dibaca langsung dari kontrak di setiap request.

## Aturan penting

- **H-1:** kurang dari 24 jam sebelum jadwal, pasien tidak bisa cancel atau reschedule. Jadwal paling jauh 57 hari ke depan.
- **Slot:** 08:00-16:00 WIB, tiap 30 menit (slot terakhir mulai 15:30). Slot yang sudah terisi tidak bisa dipilih.
- **Kuota:** maks 3 appointment aktif per pasien.
- **Masa akses dokter:** sampai 00:00 WIB pertama setelah jadwal + 24 jam; maks 60 hari. Akses aktif hanya boleh diperpanjang.
- **Kedaluwarsa:** appointment `requested` atau `rescheduled_by_doctor` yang jadwalnya lewat, dan `accepted` yang belum selesai 24 jam setelah jadwal, berstatus `expired`.
- **Akses data pasien (dokter):** akses harus aktif dan dokter sudah menerima appointment pasien itu. Dokter yang me-reschedule memberi alasan; pasien lalu konfirmasi atau membatalkan.
- **Resep:** satuan (satu obat) atau racikan (2-10 bahan); maks 20 item per resep.
- Mencabut role Dokter membuat semua akses lamanya mati; jika diberi role lagi, pasien harus memberi akses baru.

## API

Respons sukses berupa JSON langsung (atau `204`); error berbentuk `{ "error": { "code", "message", "fields"? } }`. Semua `POST`/`PUT`/`PATCH`/`DELETE` wajib header `Origin` = `APP_ORIGIN`.

| Method | Route | Siapa |
|---|---|---|
| POST | `/api/auth/nonce`, `/api/auth/verify` | Publik (10 per menit per IP) |
| POST | `/api/auth/logout` | Siapa saja (selalu `204`) |
| GET | `/api/auth/me` | Sesi login |
| GET / PUT | `/api/users/me` | Semua role |
| POST | `/api/users/register` | Patient (profil sendiri) |
| GET | `/api/users`, `/api/users/:wallet` | Admin; Doctor (pasien yang dirawat); pemilik |
| POST / PUT | `/api/users`, `/api/users/:wallet` | Admin |
| GET | `/api/users/:wallet/contact` | Admin (dicatat di `access_log`) |
| DELETE | `/api/users/:wallet` | Admin (role sudah dicabut); Patient (milik sendiri) |
| GET | `/api/appointments/doctors` | Patient |
| GET | `/api/appointments` | Patient, Doctor |
| POST | `/api/appointments` | Patient |
| PATCH | `/api/appointments/:id/reschedule`, `/cancel`, `/confirm` | Patient |
| PATCH | `/api/appointments/:id/accept`, `/reject`, `/doctor-reschedule`, `/complete` | Doctor |
| GET | `/api/appointments/summary` | Admin (agregat saja) |
| GET | `/api/records/patient/:wallet`, `/api/records/:id` | Doctor (pasien yang dirawat), Patient (milik sendiri) |
| GET | `/api/records/:id/verify`, `/:id/versions/:v/verify` | Doctor, Patient |
| POST / PUT / DELETE | `/api/records`, `/api/records/:id` | Doctor |
| POST | `/api/records/:id/confirm`, `/versions/:v/confirm`, `/versions/:v/tx`, `/:id/fail`, `/api/records/reconcile` | Doctor |
| GET | `/api/prescriptions/me` | Patient |
| GET | `/api/prescriptions/:recordId` | Doctor, Patient |
| GET | `/api/access/me`, `/api/access/doctor`, `/api/access` | Patient, Doctor, Admin |
| POST | `/api/access/log` | Semua role (mencatat transaksi akses) |
| GET | `/api/activity`, `/api/tx-log` | Semua role (difilter per role di server) |
| GET | `/api/stats` | Admin |
| POST | `/api/admin/patients/identity`, `/resolve-wallet`, `/api/admin/doctors/:wallet/cancel-appointments` | Admin |

## Konfigurasi (.env)

`setup.bat` membuat `.env` otomatis. Ubah hanya bila perlu, lalu jalankan ulang `start.bat`.

| Kunci `.env` | Fungsi |
|---|---|
| `NODE_ENV` | `development`: cookie tanpa flag Secure (http lokal); selain itu cookie Secure |
| `PORT` | Port backend (3000) |
| `APP_ORIGIN` | Alamat tempat aplikasi dibuka, persis; dipakai cek Origin dan login |
| `JWT_SECRET` | Kunci sesi; server menolak start bila kosong, < 32 byte, atau masih placeholder |
| `RPC_URL` | RPC node Hardhat (`http://127.0.0.1:8545`) |
| `CONTRACT_ADDRESS` | Alamat kontrak; harus sama dengan `frontend/js/config.js` |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | Lokasi database (`127.0.0.1`, 3306, `hospital_dapp`) |
| `DB_USER`, `DB_PASSWORD` | User aplikasi `hospital_app`, bukan root |
| `DB_RESET_USER`, `DB_RESET_PASSWORD` | User `hospital_reset` untuk reset + seed data |

## Troubleshooting

| Masalah | Solusi |
|---|---|
| Port 8545 atau 3000 sudah dipakai | Jalankan `stop.bat` (hanya mematikan node.exe), lalu `start.bat` lagi. |
| MetaMask: `nonce too high` atau transaksi tertahan | Settings, Advanced, **Clear activity tab data** untuk akun yang dipakai. Wajib setelah node di-restart. |
| `403 BAD_ORIGIN` (semua tombol simpan gagal) | Buka lewat `http://127.0.0.1:3000`, bukan `localhost`, atau samakan `APP_ORIGIN` di `.env` lalu restart backend. |
| Saldo 0 di MetaMask | Network salah atau node baru: pilih Hardhat Local (chain ID 31337) dan import ulang akun uji. Saldo awal sekitar 10000 ETH. |
| Aplikasi menampilkan "Kontrak belum di-deploy" | Node di-restart sehingga state hilang. Jalankan `start.bat` lagi. |
| Backend: `Kontrak tidak siap` | Node mati, kontrak belum di-deploy, atau alamat berbeda dengan `CONTRACT_ADDRESS`. |
| Login: `429` | Lebih dari 10 percobaan per menit dari satu IP. Tunggu 1 menit. |
| MySQL gagal start di XAMPP | Sisa proses `mysqld.exe`: akhiri lewat Task Manager atau `taskkill /F /IM mysqld.exe`, lalu Start lagi. Baca `C:\xampp\mysql\data\mysql_error.log`. |
| Error 1045 (Access denied, password) | Password di MySQL beda dengan `.env`. Jalankan ulang `setup.bat` (menyetel ulang password dari `.env`, tetapi juga membangun ulang database). Jika yang salah password root, `setup.bat` menanyakannya. |
| Error 1044 (login berhasil, query ditolak) | Grant tidak tersimpan (`SHOW GRANTS` hanya `USAGE`). Perbaiki tabel sistem (baris 1030), jalankan ulang `users.sql`. |
| Error 1030 / 1034 / 176 (Aria) saat `users.sql` | Tabel sistem MySQL rusak. Sebagai root: `CHECK TABLE mysql.global_priv, mysql.db;` lalu `REPAIR TABLE mysql.global_priv;` atau `REPAIR TABLE mysql.db;`, lalu jalankan ulang `users.sql`. |

## Batasan yang diketahui

- Data di blockchain (hash, alamat, waktu) bersifat publik; isi rekam medis tidak disimpan di sana.
- Node Hardhat lokal punya RPC terbuka dan akun ter-unlock; hanya untuk pengembangan.
- Identitas pasien disamarkan untuk Admin, tetapi event blockchain tetap publik.
- Rate limit tersimpan di memori satu proses (hilang saat restart, tidak dibagi antar-instance).
- Disarankan mengamankan MySQL lokal: password root, `secure_file_priv` ke folder khusus, `bind-address = 127.0.0.1`.
- `npm audit` melaporkan kerentanan pada dependensi pengembangan (toolchain Hardhat); dependensi runtime: 0 (`npm audit --omit=dev`).
- Uji otomatis tidak disertakan dalam paket ini; perintah `npm run test:*` di `package.json` hanya untuk pengembangan.