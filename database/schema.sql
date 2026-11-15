-- schema.sql — skema database off-chain BioCare.
-- Jalankan sebagai root/admin MySQL. Urutan import: schema.sql -> users.sql -> seed.sql
-- Teruji di MariaDB 10.4 (XAMPP); sintaks juga untuk MySQL 8.0.16+ (CHECK ditegakkan).
-- Prinsip:
--  - ROLE & AKSES PERAWATAN TIDAK disimpan di sini. Keduanya hanya ada di kontrak
--    HospitalRecords; status Active/Pending dihitung backend dari role on-chain.
--    (users.staff_type hanya INFORMATIF, bukan dasar otorisasi.)
--  - Kolom wallet & hash memakai ascii_bin (case-sensitive) agar aturan
--    "lowercase" benar-benar ditegakkan oleh CHECK.
--  - Wallet TIDAK diberi foreign key ke users: identitas wallet ada di blockchain,
--    sedangkan profil boleh dihapus tanpa menghapus rekam medis/riwayat transaksi.
--  - Waktu: semua DATETIME disimpan dalam WIB (Asia/Jakarta, +07:00). Backend memasang
--    time_zone '+07:00' & strict mode di setiap koneksi (backend/db.js).
-- !!! PERINGATAN: file ini MENGHAPUS database hospital_dapp (DROP DATABASE) lalu
-- !!! membuatnya ulang KOSONG. Khusus development: data dev selalu dibangun ulang
-- !!! (schema -> users -> seed) karena rumus hash rekam medis bisa berubah.
-- !!! Hak user hospital_app (users.sql) tetap ada karena GRANT disimpan per nama database.

-- Strict mode untuk sesi import ini: nilai ENUM tidak valid / teks terlalu panjang = ERROR.
SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
SET time_zone = '+07:00';

DROP DATABASE IF EXISTS hospital_dapp;
CREATE DATABASE hospital_dapp
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE hospital_dapp;

-- users: profil off-chain. Satu baris per wallet.
CREATE TABLE users (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  wallet_address  CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  full_name       VARCHAR(100) NOT NULL,
  phone           VARCHAR(16)  NOT NULL,
  birth_date      DATE         NOT NULL,
  gender          ENUM('L','P') NOT NULL,          -- L = Laki-laki, P = Perempuan
  address         VARCHAR(255) NOT NULL,
  specialization  VARCHAR(100) NULL,               -- hanya Doctor (mis. Umum, Anak, Penyakit Dalam); NULL untuk Patient/Admin
  -- INFORMATIF: jenis staf yang dimaksud Admin saat membuat profil sebelum grantRole.
  -- BUKAN dasar otorisasi — role yang berlaku selalu dibaca dari kontrak.
  staff_type      ENUM('doctor') NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_wallet (wallet_address),
  CONSTRAINT chk_users_wallet  CHECK (wallet_address REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_users_name    CHECK (CHAR_LENGTH(full_name) BETWEEN 3 AND 100),
  CONSTRAINT chk_users_phone   CHECK (phone REGEXP '^(\\+62|0)8[0-9]{7,12}$'),
  CONSTRAINT chk_users_birth   CHECK (birth_date >= '1900-01-01'),
  CONSTRAINT chk_users_address CHECK (CHAR_LENGTH(address) BETWEEN 5 AND 255),
  CONSTRAINT chk_users_spec    CHECK (specialization IS NULL OR CHAR_LENGTH(specialization) BETWEEN 3 AND 100),
  -- profil yang dibuat Admin sebagai dokter wajib punya spesialisasi
  CONSTRAINT chk_users_staff_spec CHECK (staff_type IS NULL OR specialization IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- auth_nonces: nonce login sekali pakai (Sign-In dengan tanda tangan wallet).
CREATE TABLE auth_nonces (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  wallet_address  CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nonce           CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,  -- 32 byte acak, hex
  -- keccak256 pesan SIWE (EIP-4361) lengkap yang disusun SERVER. Saat verify, pesan dari client
  -- harus identik byte-per-byte (hash sama), jadi server tidak perlu mem-parsing pesan.
  message_hash    CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at      DATETIME NOT NULL,
  used_at         DATETIME NULL,                   -- terisi saat dipakai (berhasil ATAU gagal) -> tidak bisa dipakai ulang
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_nonce (nonce),
  KEY idx_nonce_wallet (wallet_address, nonce),    -- cari nonce milik wallet tertentu
  KEY idx_nonce_expires (expires_at),              -- bersihkan nonce kedaluwarsa
  CONSTRAINT chk_nonce_wallet CHECK (wallet_address REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_nonce_value  CHECK (nonce REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT chk_nonce_hash   CHECK (message_hash REGEXP '^0x[0-9a-f]{64}$'),
  CONSTRAINT chk_nonce_expiry CHECK (expires_at > created_at),
  CONSTRAINT chk_nonce_used   CHECK (used_at IS NULL OR used_at >= created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- auth_sessions: sesi login (satu baris per JWT, kunci = jti).
-- Setiap request wajib: JWT valid DAN jti ada di sini, belum dicabut, belum kedaluwarsa.
-- Logout = isi revoked_at, jadi token lama langsung tidak berlaku walau exp JWT belum lewat.
-- Role TIDAK disimpan (selalu dibaca dari kontrak).
CREATE TABLE auth_sessions (
  jti             CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,  -- 16 byte acak, hex
  wallet_address  CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at      DATETIME NOT NULL,
  revoked_at      DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (jti),
  KEY idx_sessions_wallet (wallet_address),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT chk_sessions_jti     CHECK (jti REGEXP '^[0-9a-f]{32}$'),
  CONSTRAINT chk_sessions_wallet  CHECK (wallet_address REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_sessions_expiry  CHECK (expires_at > created_at),
  CONSTRAINT chk_sessions_revoked CHECK (revoked_at IS NULL OR revoked_at >= created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- medical_records: isi rekam medis versi TERAKHIR yang terkonfirmasi on-chain
-- (atau draft pertama selama transaksi addRecord masih pending).
-- data_hash = keccak256(salt + JSON kanonik) -> harus sama dengan dataHash di kontrak.
-- Tidak pernah dihapus fisik: hapus = status 'deleted' (soft delete, sama seperti kontrak).
CREATE TABLE medical_records (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  onchain_id      BIGINT UNSIGNED NULL,            -- id di kontrak; NULL selama addRecord belum terkonfirmasi
  patient_wallet  CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  doctor_wallet   CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  diagnosis       VARCHAR(200)  NOT NULL,
  treatment       VARCHAR(500)  NOT NULL,
  notes           VARCHAR(1000) NOT NULL DEFAULT '',
  salt            CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  data_hash       CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status          ENUM('pending','confirmed','failed','deleted') NOT NULL DEFAULT 'pending',
  -- 1 selama draft (pending), NULL sesudahnya -> UNIQUE di bawah = maks 1 draft per dokter–pasien
  pending_draft   TINYINT UNSIGNED AS (IF(status = 'pending', 1, NULL)) STORED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_records_onchain (onchain_id),      -- banyak NULL diperbolehkan
  UNIQUE KEY uq_records_pending_draft (patient_wallet, doctor_wallet, pending_draft),  -- aman dari request paralel
  KEY idx_records_patient (patient_wallet, status, created_at),  -- "rekam medis pasien X"
  KEY idx_records_doctor  (doctor_wallet, status, created_at),   -- "rekam medis buatan dokter Y"
  CONSTRAINT chk_records_patient   CHECK (patient_wallet REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_records_doctor    CHECK (doctor_wallet  REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_records_diff      CHECK (patient_wallet <> doctor_wallet),
  CONSTRAINT chk_records_salt      CHECK (salt      REGEXP '^0x[0-9a-f]{64}$'),
  CONSTRAINT chk_records_hash      CHECK (data_hash REGEXP '^0x[0-9a-f]{64}$'),
  CONSTRAINT chk_records_diagnosis CHECK (CHAR_LENGTH(diagnosis) BETWEEN 3 AND 200),
  CONSTRAINT chk_records_treatment CHECK (CHAR_LENGTH(treatment) BETWEEN 3 AND 500),
  CONSTRAINT chk_records_onchain   CHECK (onchain_id IS NULL OR onchain_id >= 1),
  -- confirmed/deleted berarti sudah ada di kontrak -> wajib punya onchain_id
  CONSTRAINT chk_records_confirmed CHECK (status IN ('pending','failed') OR onchain_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- medical_record_versions: riwayat APPEND-ONLY setiap create/update/delete.
-- Alur update: tulis versi baru (pending) -> kirim updateRecord -> jika confirmed,
-- salin isinya ke medical_records. Transaksi gagal tidak menyentuh medical_records,
-- sehingga verifikasi integritas tetap cocok dengan hash di kontrak.
CREATE TABLE medical_record_versions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  record_id       BIGINT UNSIGNED NOT NULL,
  version_no      INT UNSIGNED NOT NULL,           -- 1, 2, 3, ... per record
  diagnosis       VARCHAR(200)  NOT NULL,
  treatment       VARCHAR(500)  NOT NULL,
  notes           VARCHAR(1000) NOT NULL DEFAULT '',
  salt            CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  data_hash       CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action          ENUM('create','update','delete') NOT NULL,
  tx_hash         CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NULL,  -- NULL jika tx belum/tidak terkirim
  status          ENUM('pending','confirmed','failed') NOT NULL DEFAULT 'pending',
  created_by      CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,  -- wallet dokter
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_versions_no (record_id, version_no),
  UNIQUE KEY uq_versions_tx (tx_hash),
  KEY idx_versions_status (status, created_at),    -- cari versi pending untuk dicek ulang
  -- RESTRICT: rekam medis tidak pernah dihapus fisik selama punya riwayat
  CONSTRAINT fk_versions_record FOREIGN KEY (record_id) REFERENCES medical_records (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_versions_no      CHECK (version_no >= 1),
  CONSTRAINT chk_versions_salt    CHECK (salt      REGEXP '^0x[0-9a-f]{64}$'),
  CONSTRAINT chk_versions_hash    CHECK (data_hash REGEXP '^0x[0-9a-f]{64}$'),
  CONSTRAINT chk_versions_tx      CHECK (tx_hash IS NULL OR tx_hash REGEXP '^0x[0-9a-f]{64}$'),
  CONSTRAINT chk_versions_by      CHECK (created_by REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_versions_confirm CHECK (status <> 'confirmed' OR tx_hash IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- tx_log: catatan setiap transaksi yang dikirim aplikasi.
-- Sumber status pending/failed di Riwayat Aktivitas (event kontrak hanya berisi tx sukses).
-- Tidak bisa dihapus; UPDATE hanya pending -> confirmed/failed (trigger trg_tx_log_*).
CREATE TABLE tx_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tx_hash         CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NULL,  -- NULL jika gagal sebelum terkirim
  actor_wallet    CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action          ENUM('grant_role','revoke_role','register_patient','add_record','update_record','delete_record',
                       'grant_access','extend_access','revoke_access','renounce_access') NOT NULL,
  -- role: wallet yang diberi/dicabut; akses: wallet dokter (renounce_access: wallet pasien); record: pasien
  target_wallet   CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NULL,
  record_id       BIGINT UNSIGNED NULL,            -- medical_records.id (bukan onchain_id)
  status          ENUM('pending','confirmed','failed') NOT NULL DEFAULT 'pending',
  error_message   VARCHAR(255) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tx_hash (tx_hash),
  KEY idx_tx_actor  (actor_wallet, created_at),    -- aktivitas milik seseorang
  KEY idx_tx_target (target_wallet, created_at),
  KEY idx_tx_status (status, created_at),          -- daftar transaksi pending
  CONSTRAINT fk_tx_record FOREIGN KEY (record_id) REFERENCES medical_records (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_tx_hash    CHECK (tx_hash IS NULL OR tx_hash REGEXP '^0x[0-9a-f]{64}$'),
  CONSTRAINT chk_tx_actor   CHECK (actor_wallet REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_tx_target  CHECK (target_wallet IS NULL OR target_wallet REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_tx_confirm CHECK (status <> 'confirmed' OR tx_hash IS NOT NULL),
  -- aksi rekam medis wajib menunjuk record; aksi role & akses wajib punya wallet target
  CONSTRAINT chk_tx_record  CHECK (action NOT IN ('add_record','update_record','delete_record') OR record_id IS NOT NULL),
  CONSTRAINT chk_tx_role    CHECK (action NOT IN ('grant_role','revoke_role','grant_access','extend_access','revoke_access','renounce_access') OR target_wallet IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- prescription_items: item resep digital, MILIK SATU VERSI rekam medis
-- (FK ke medical_record_versions, BUKAN medical_records -> resep versi lama tetap utuh
-- dan tetap bisa diverifikasi terhadap hash versi itu di event kontrak).
-- Item ikut JSON kanonik -> ikut di-hash (data_hash versi) -> terverifikasi on-chain.
--   type 'single'   = obat satuan, TIDAK boleh punya bahan (trigger).
--   type 'compound' = racikan, wajib 2–10 bahan di prescription_ingredients
--                     (maks 10: CHECK ingredient_no; min 2: dicek trigger saat versi di-confirm).
-- Maks 20 item per versi (CHECK item_no 1..20 + UNIQUE per versi).
-- Append-only (trigger di bawah): tidak bisa diubah/dihapus, dan hanya bisa ditambah
-- selama versinya masih 'pending' (sebelum hash-nya dikirim ke kontrak).
-- Batas panjang SAMA dengan validatePrescriptions di backend/lib/validate.js.
CREATE TABLE prescription_items (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  record_version_id  BIGINT UNSIGNED NOT NULL,
  item_no            TINYINT UNSIGNED NOT NULL,       -- 1..20, urutan di JSON kanonik
  type               ENUM('single','compound') NOT NULL,
  name               VARCHAR(100) NOT NULL,           -- mis. "Parasetamol" / "Puyer batuk anak"
  strength           VARCHAR(50)  NULL,               -- mis. "500 mg"; opsional
  form               VARCHAR(50)  NOT NULL,           -- mis. "tablet", "sirup", "puyer"
  quantity           INT UNSIGNED NOT NULL,           -- jumlah yang diserahkan, mis. 10
  unit               VARCHAR(20)  NOT NULL,           -- mis. "tablet", "bungkus", "botol"
  signa              VARCHAR(100) NOT NULL,           -- aturan minum, mis. "3 dd 1 tab"
  duration           VARCHAR(50)  NOT NULL,           -- mis. "5 hari"
  instructions       VARCHAR(255) NULL,               -- mis. "Sesudah makan"; opsional
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_items_no (record_version_id, item_no),
  CONSTRAINT fk_items_version FOREIGN KEY (record_version_id) REFERENCES medical_record_versions (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_items_no       CHECK (item_no BETWEEN 1 AND 20),
  CONSTRAINT chk_items_name     CHECK (CHAR_LENGTH(name) BETWEEN 2 AND 100),
  CONSTRAINT chk_items_strength CHECK (strength IS NULL OR CHAR_LENGTH(strength) BETWEEN 1 AND 50),
  CONSTRAINT chk_items_form     CHECK (CHAR_LENGTH(form) BETWEEN 1 AND 50),
  CONSTRAINT chk_items_quantity CHECK (quantity BETWEEN 1 AND 9999),
  CONSTRAINT chk_items_unit     CHECK (CHAR_LENGTH(unit) BETWEEN 1 AND 20),
  CONSTRAINT chk_items_signa    CHECK (CHAR_LENGTH(signa) BETWEEN 1 AND 100),
  CONSTRAINT chk_items_duration CHECK (CHAR_LENGTH(duration) BETWEEN 1 AND 50),
  CONSTRAINT chk_items_instr    CHECK (instructions IS NULL OR CHAR_LENGTH(instructions) BETWEEN 1 AND 255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- prescription_ingredients: bahan racikan (hanya untuk item 'compound'). Append-only.
CREATE TABLE prescription_ingredients (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id         BIGINT UNSIGNED NOT NULL,
  ingredient_no   TINYINT UNSIGNED NOT NULL,          -- 1..10, urutan di JSON kanonik
  name            VARCHAR(100) NOT NULL,              -- mis. "Ambroksol"
  strength        VARCHAR(50)  NOT NULL,              -- mis. "30 mg"
  amount          VARCHAR(50)  NOT NULL,              -- jumlah per racikan, mis. "1/2 tablet"
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ingredients_no (item_id, ingredient_no),
  CONSTRAINT fk_ingredients_item FOREIGN KEY (item_id) REFERENCES prescription_items (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_ingr_no       CHECK (ingredient_no BETWEEN 1 AND 10),
  CONSTRAINT chk_ingr_name     CHECK (CHAR_LENGTH(name) BETWEEN 2 AND 100),
  CONSTRAINT chk_ingr_strength CHECK (CHAR_LENGTH(strength) BETWEEN 1 AND 50),
  CONSTRAINT chk_ingr_amount   CHECK (CHAR_LENGTH(amount) BETWEEN 1 AND 50)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- appointments: janji temu pasien–dokter. OFF-CHAIN saja (tidak ada di kontrak).
-- scheduled_at dalam WIB (Asia/Jakarta). Slot 30 menit, mulai 08:00 s.d. 15:30 (selesai 16:00).
-- Anti-bentrok: active_slot = scheduled_at hanya untuk status yang MENGUNCI slot
-- (requested, accepted, rescheduled_by_doctor), selain itu NULL; lalu UNIQUE (doctor_wallet,
-- active_slot). NULL boleh berulang, jadi appointment yang ditolak/dibatalkan/selesai tidak
-- memblokir slot. Ditegakkan database -> aman dari race condition (dua booking paralel).
-- "Masa depan" & aturan H-1 dicek backend dengan jam server WIB (CHECK tidak boleh memakai NOW()).
-- access_expires_at = jadwal + 24 jam (detik Unix) = expiresAt akses dokter di kontrak yang
-- sudah dipastikan cukup saat appointment disimpan/dikonfirmasi.
-- expired: appointment aktif yang lewat waktu, diubah backend saat dibaca (lazy, tanpa cron):
-- requested/rescheduled_by_doctor setelah jadwal lewat; accepted setelah jadwal + 24 jam tanpa complete.
-- expired TIDAK mengunci slot & jatah (bukan status aktif), sama seperti cancelled.
-- Batas appointment AKTIF per pasien = 3 (anti-penimbunan slot dokter, OWASP WSTG-BUSL-05):
-- setiap appointment memakai satu nomor jatah quota_no 1..3; active_quota_no = quota_no hanya selama
-- status mengunci (sama seperti active_slot), lalu UNIQUE (patient_wallet, active_quota_no).
-- Jatah ke-4 tidak ada (CHECK) dan dua booking paralel tidak bisa memakai jatah yang sama (UNIQUE).
CREATE TABLE appointments (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  patient_wallet     CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  doctor_wallet      CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scheduled_at       DATETIME NOT NULL,               -- WIB
  reason             VARCHAR(500) NOT NULL,           -- keluhan: data sensitif, tidak ditampilkan ke Admin
  status             ENUM('requested','accepted','rejected','cancelled','rescheduled_by_doctor','completed','expired') NOT NULL DEFAULT 'requested',
  doctor_note        VARCHAR(500) NULL,
  access_expires_at  BIGINT UNSIGNED NOT NULL,        -- detik Unix (waktu blok kontrak)
  active_slot        DATETIME AS (IF(status IN ('requested','accepted','rescheduled_by_doctor'), scheduled_at, NULL)) STORED,
  quota_no           TINYINT UNSIGNED NOT NULL,        -- nomor jatah appointment aktif pasien (1..3)
  active_quota_no    TINYINT UNSIGNED AS (IF(status IN ('requested','accepted','rescheduled_by_doctor'), quota_no, NULL)) STORED,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_appt_doctor_slot (doctor_wallet, active_slot),
  UNIQUE KEY uq_appt_patient_quota (patient_wallet, active_quota_no),
  KEY idx_appt_patient (patient_wallet, scheduled_at),
  KEY idx_appt_doctor  (doctor_wallet, scheduled_at),
  KEY idx_appt_pair    (doctor_wallet, patient_wallet, status),  -- "appointment aktif lain" (shouldRenounce)
  CONSTRAINT chk_appt_patient CHECK (patient_wallet REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_appt_doctor  CHECK (doctor_wallet  REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_appt_diff    CHECK (patient_wallet <> doctor_wallet),
  CONSTRAINT chk_appt_reason  CHECK (CHAR_LENGTH(reason) BETWEEN 3 AND 500),
  CONSTRAINT chk_appt_note    CHECK (doctor_note IS NULL OR CHAR_LENGTH(doctor_note) BETWEEN 1 AND 500),
  CONSTRAINT chk_appt_access  CHECK (access_expires_at > 0),
  CONSTRAINT chk_appt_quota   CHECK (quota_no BETWEEN 1 AND 3),   -- = MAX_ACTIVE_PER_PATIENT (routes/appointments.js)
  CONSTRAINT chk_appt_slot    CHECK (TIME(scheduled_at) BETWEEN '08:00:00' AND '15:30:00'
                                     AND MINUTE(scheduled_at) IN (0, 30) AND SECOND(scheduled_at) = 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- appointment_changes: riwayat APPEND-ONLY setiap perubahan status/jadwal appointment
-- (ditulis dalam transaksi DB yang sama dengan perubahannya). Dijaga trigger: UPDATE/DELETE ditolak.
-- reason = alasan reschedule dokter (wajib >= 10 karakter); data sensitif, tidak untuk Admin.
-- Pelaku SISTEM: change_type 'expire' ditulis backend dengan changed_by = alamat nol
-- 0x000…000 (tidak ada yang memegang kuncinya, jadi tidak bisa tertukar dengan pengguna).
-- cancel oleh Admin (dokter dicabut role-nya) = 'cancel' + changed_by Admin + reason kode tetap
-- 'DOCTOR_ROLE_REVOKED'; cancel oleh pasien tanpa reason.
CREATE TABLE appointment_changes (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  appointment_id    BIGINT UNSIGNED NOT NULL,
  changed_by        CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,   -- wallet pelaku
  change_type       ENUM('patient_reschedule','doctor_reschedule','cancel','accept','reject','confirm','complete','expire') NOT NULL,
  old_scheduled_at  DATETIME NOT NULL,               -- jadwal sebelum perubahan (WIB)
  new_scheduled_at  DATETIME NULL,                   -- hanya untuk reschedule (WIB)
  reason            VARCHAR(500) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_changes_appt (appointment_id, id),
  CONSTRAINT fk_changes_appt FOREIGN KEY (appointment_id) REFERENCES appointments (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_changes_by     CHECK (changed_by REGEXP '^0x[0-9a-f]{40}$'),
  -- jadwal baru ada <=> jenisnya reschedule
  CONSTRAINT chk_changes_new    CHECK ((change_type IN ('patient_reschedule','doctor_reschedule')) = (new_scheduled_at IS NOT NULL)),
  CONSTRAINT chk_changes_reason CHECK (reason IS NULL OR CHAR_LENGTH(reason) BETWEEN 1 AND 500),
  CONSTRAINT chk_changes_doc    CHECK (change_type <> 'doctor_reschedule' OR CHAR_LENGTH(TRIM(reason)) >= 10),
  -- expire <=> pelaku sistem (alamat nol); alasan cancel hanya kode tetap
  CONSTRAINT chk_changes_system CHECK ((change_type = 'expire') = (changed_by = '0x0000000000000000000000000000000000000000')),
  CONSTRAINT chk_changes_cancel CHECK (change_type <> 'cancel' OR reason IS NULL OR reason = 'DOCTOR_ROLE_REVOKED')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- access_log: jejak audit setiap kali Admin membuka data kontak LENGKAP seseorang
-- (GET /api/users/:ref/contact, field_group 'contact'), membuka NAMA pasien di balik pseudonim
-- (POST /api/admin/patients/identity, field_group 'identity'), atau membuka WALLET pasien untuk transaksi
-- Admin (POST /api/admin/patients/resolve-wallet, field_group 'wallet'); identity & wallet: alasan wajib 10–200.
-- Tampilan Admin biasa hanya berisi data tersamar/pseudonim/ref, tanpa wallet pasien.
-- Append-only (trigger di bawah): tidak bisa diubah/dihapus, termasuk oleh hospital_app.
CREATE TABLE access_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_wallet    CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,  -- Admin yang membuka
  target_wallet   CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,  -- pemilik data
  field_group     ENUM('contact','identity','wallet') NOT NULL,  -- contact = telepon, alamat, tgl lahir · identity = nama · wallet = alamat wallet
  reason          VARCHAR(200) NULL,               -- alasan Admin (wajib untuk identity & wallet)
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_access_target (target_wallet, created_at),  -- "siapa yang membuka data saya"
  KEY idx_access_actor  (actor_wallet, created_at),
  CONSTRAINT chk_access_actor  CHECK (actor_wallet  REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_access_target CHECK (target_wallet REGEXP '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_access_reason CHECK ((field_group IN ('identity', 'wallet')) = (reason IS NOT NULL)
                                      AND (reason IS NULL OR CHAR_LENGTH(reason) BETWEEN 10 AND 200))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TRIGGER penegak append-only & aturan resep.
-- Berlaku juga untuk user aplikasi (hospital_app) yang punya hak UPDATE/DELETE.
-- (Database baru dibuat ulang di atas, jadi tidak perlu DROP TRIGGER.)
DELIMITER //

-- medical_record_versions: isi versi tidak boleh diubah/dihapus; yang boleh berubah hanya
-- status (dari 'pending') dan tx_hash (diisi sekali; yang sudah terisi tidak bisa diganti).
CREATE TRIGGER trg_versions_no_update BEFORE UPDATE ON medical_record_versions
FOR EACH ROW
BEGIN
  IF NOT (NEW.record_id <=> OLD.record_id AND NEW.version_no <=> OLD.version_no
          AND NEW.diagnosis <=> OLD.diagnosis AND NEW.treatment <=> OLD.treatment
          AND NEW.notes <=> OLD.notes AND NEW.salt <=> OLD.salt
          AND NEW.data_hash <=> OLD.data_hash AND NEW.action <=> OLD.action
          AND NEW.created_by <=> OLD.created_by AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'medical_record_versions append-only: isi versi tidak boleh diubah';
  END IF;
  IF OLD.status <> 'pending' AND NOT (NEW.status <=> OLD.status) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'medical_record_versions: status final tidak boleh diubah';
  END IF;
  IF OLD.tx_hash IS NOT NULL AND NOT (NEW.tx_hash <=> OLD.tx_hash) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'medical_record_versions: tx_hash tidak boleh diganti';
  END IF;
  -- Racikan wajib minimal 2 bahan. Baru bisa dicek saat versi final, karena bahan
  -- di-INSERT setelah itemnya (maksimal 10 sudah dijaga CHECK ingredient_no).
  IF OLD.status = 'pending' AND NEW.status = 'confirmed' AND EXISTS (
       SELECT 1 FROM prescription_items i
       WHERE i.record_version_id = OLD.id AND i.type = 'compound'
         AND (SELECT COUNT(*) FROM prescription_ingredients g WHERE g.item_id = i.id) < 2) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'prescription_items: racikan wajib 2-10 bahan';
  END IF;
END//

CREATE TRIGGER trg_versions_no_delete BEFORE DELETE ON medical_record_versions
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'medical_record_versions append-only: baris tidak boleh dihapus';
END//

-- prescription_items: hanya INSERT, dan hanya ke versi yang masih pending.
CREATE TRIGGER trg_items_insert_pending BEFORE INSERT ON prescription_items
FOR EACH ROW
BEGIN
  IF NOT ((SELECT status FROM medical_record_versions WHERE id = NEW.record_version_id) <=> 'pending') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'prescription_items: versi sudah final, item resep tidak bisa ditambah';
  END IF;
END//

CREATE TRIGGER trg_items_no_update BEFORE UPDATE ON prescription_items
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'prescription_items append-only: item resep tidak boleh diubah';
END//

CREATE TRIGGER trg_items_no_delete BEFORE DELETE ON prescription_items
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'prescription_items append-only: item resep tidak boleh dihapus';
END//

-- prescription_ingredients: hanya INSERT, hanya untuk item 'compound' (single TIDAK boleh
-- punya bahan), dan hanya selama versinya masih pending.
CREATE TRIGGER trg_ingredients_insert BEFORE INSERT ON prescription_ingredients
FOR EACH ROW
BEGIN
  IF NOT ((SELECT type FROM prescription_items WHERE id = NEW.item_id) <=> 'compound') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'prescription_ingredients: hanya racikan (compound) yang boleh punya bahan';
  END IF;
  IF NOT ((SELECT v.status FROM prescription_items i JOIN medical_record_versions v ON v.id = i.record_version_id
           WHERE i.id = NEW.item_id) <=> 'pending') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'prescription_ingredients: versi sudah final, bahan tidak bisa ditambah';
  END IF;
END//

CREATE TRIGGER trg_ingredients_no_update BEFORE UPDATE ON prescription_ingredients
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'prescription_ingredients append-only: bahan tidak boleh diubah';
END//

CREATE TRIGGER trg_ingredients_no_delete BEFORE DELETE ON prescription_ingredients
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'prescription_ingredients append-only: bahan tidak boleh dihapus';
END//

-- appointment_changes: hanya INSERT.
CREATE TRIGGER trg_appt_changes_no_update BEFORE UPDATE ON appointment_changes
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointment_changes append-only: baris tidak boleh diubah';
END//

CREATE TRIGGER trg_appt_changes_no_delete BEFORE DELETE ON appointment_changes
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointment_changes append-only: baris tidak boleh dihapus';
END//

-- access_log: hanya INSERT.
CREATE TRIGGER trg_access_log_no_update BEFORE UPDATE ON access_log
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'access_log append-only: baris tidak boleh diubah';
END//

CREATE TRIGGER trg_access_log_no_delete BEFORE DELETE ON access_log
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'access_log append-only: baris tidak boleh dihapus';
END//

-- tx_log: sumber status pending/failed DAN penjaga anti-replay txHash (uq_tx_hash).
-- UPDATE hanya untuk transisi yang dipakai aplikasi (backend/routes/records.js confirmVersion/failVersion):
--   status pending -> confirmed | failed (sekali; baris final tidak bisa diubah lagi);
--   tx_hash NULL -> nilai (sekali; yang sudah terisi tidak bisa diganti);
--   error_message diisi/dikosongkan saat transisi itu; updated_at ikut berubah (ON UPDATE).
-- id, actor_wallet, action, target_wallet, record_id, created_at tidak boleh berubah. DELETE ditolak.
-- reset.sql memakai TRUNCATE (tidak memicu trigger).
CREATE TRIGGER trg_tx_log_update BEFORE UPDATE ON tx_log
FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id AND NEW.actor_wallet <=> OLD.actor_wallet AND NEW.action <=> OLD.action
          AND NEW.target_wallet <=> OLD.target_wallet AND NEW.record_id <=> OLD.record_id
          AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tx_log: hanya status, tx_hash, error_message yang boleh berubah';
  END IF;
  IF NOT (OLD.status = 'pending' AND NEW.status IN ('confirmed', 'failed')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tx_log: hanya transisi pending -> confirmed/failed';
  END IF;
  IF OLD.tx_hash IS NOT NULL AND NOT (NEW.tx_hash <=> OLD.tx_hash) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tx_log: tx_hash tidak boleh diganti';
  END IF;
END//

CREATE TRIGGER trg_tx_log_no_delete BEFORE DELETE ON tx_log
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tx_log append-only: baris tidak boleh dihapus';
END//
DELIMITER ;
