-- seed.sql — profil & appointment awal untuk akun default Hardhat (`npm run chain`).
-- Jalankan pada database KOSONG: setelah schema.sql (+ users.sql), atau setelah reset.sql.
-- Profil di sini HANYA data diri. Role & akses dokter tetap harus diberikan di kontrak
-- (Remix atau `npm run deploy:local`):
--   #0 Admin (deployer) · #1, #2, #5 Doctor · #3, #6–#8 Patient
--   #4 sengaja TANPA profil & tanpa role (uji wallet Unregistered / registrasi pasien).
--   Akses: #3 -> Doctor #1 (berlaku 3 hari sejak deploy) + appointment #1 berstatus ACCEPTED di bawah:
--   dokter hanya membaca data pasien yang sedang ia rawat (akses on-chain + appointment disepakati).
-- staff_type hanya INFORMATIF (bukan dasar otorisasi).
-- medical_records & resep TIDAK di-seed: harus dibuat lewat aplikasi agar hash-nya
-- tercatat di kontrak dan verifikasi integritas cocok.
SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
SET time_zone = '+07:00';  -- semua DATETIME appointment dalam WIB
USE hospital_dapp;

INSERT INTO users (wallet_address, full_name, phone, birth_date, gender, address, specialization, staff_type) VALUES
  -- #0 Admin
  ('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'Rina Kartika',     '081234500001', '1985-03-12', 'P', 'Jl. Mawar No. 1, Bandung',     NULL,             NULL),
  -- #1 Doctor
  ('0x70997970c51812dc3a010c7d01b50e0d17dc79c8', 'dr. Budi Santoso', '081234500002', '1980-07-21', 'L', 'Jl. Melati No. 2, Bandung',    'Umum',           'doctor'),
  -- #2 Doctor
  ('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', 'dr. Dewi Anggraini','081234500004', '1993-09-05', 'P', 'Jl. Cempaka No. 4, Bandung',   'Anak',           'doctor'),
  -- #3 Patient
  ('0x90f79bf6eb2c4f870365e785982e1f101e93b906', 'Sari Wulandari',   '081234500005', '1995-11-02', 'P', 'Jl. Kenanga No. 3, Bandung',   NULL,             NULL),
  -- #5 Doctor
  ('0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc', 'dr. Maya Lestari', '081234500003', '1988-02-14', 'P', 'Jl. Dahlia No. 7, Cimahi',     'Penyakit Dalam', 'doctor'),
  -- #6–#8 Patient tambahan
  ('0x976ea74026e726554db657fa54763abd0c3a0aa9', 'Andi Pratama',     '081234500006', '1990-01-30', 'L', 'Jl. Anggrek No. 4, Sumedang',  NULL,             NULL),
  ('0x14dc79964da2c08b23698b3d3cc7ca32193d9955', 'Rudi Hartono',     '081234500007', '1972-06-18', 'L', 'Jl. Flamboyan No. 9, Garut',   NULL,             NULL),
  ('0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f', 'Lina Marlina',     '081234500008', '2001-12-25', 'P', 'Jl. Teratai No. 5, Bandung',   NULL,             NULL);

-- Appointment contoh untuk BESOK (WIB). access_expires_at = jadwal + 24 jam (detik Unix).
--   #3 -> Doctor #1 jam 09:00 (accepted, pasangan akses awal deploy-local) · #6 -> Doctor #5 jam 10:00 (accepted)
-- Catatan: data contoh ini tidak lewat transaksi akses on-chain; akses #6 -> #5 belum ada di kontrak.
-- quota_no = nomor jatah appointment aktif pasien (maks 3 aktif per pasien, lihat schema.sql).
INSERT INTO appointments (patient_wallet, doctor_wallet, scheduled_at, reason, status, doctor_note, access_expires_at, quota_no) VALUES
  ('0x90f79bf6eb2c4f870365e785982e1f101e93b906', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
   TIMESTAMP(CURDATE() + INTERVAL 1 DAY, '09:00:00'), 'Demam dan batuk sejak 3 hari', 'accepted', NULL,
   UNIX_TIMESTAMP(TIMESTAMP(CURDATE() + INTERVAL 2 DAY, '09:00:00')), 1),
  ('0x976ea74026e726554db657fa54763abd0c3a0aa9', '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
   TIMESTAMP(CURDATE() + INTERVAL 1 DAY, '10:00:00'), 'Kontrol rutin', 'accepted', 'Bawa hasil lab terakhir',
   UNIX_TIMESTAMP(TIMESTAMP(CURDATE() + INTERVAL 2 DAY, '10:00:00')), 1);

-- Riwayat perubahan status appointment contoh (append-only).
INSERT INTO appointment_changes (appointment_id, changed_by, change_type, old_scheduled_at) VALUES
  (1, '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', 'accept', TIMESTAMP(CURDATE() + INTERVAL 1 DAY, '09:00:00')),
  (2, '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc', 'accept', TIMESTAMP(CURDATE() + INTERVAL 1 DAY, '10:00:00'));
