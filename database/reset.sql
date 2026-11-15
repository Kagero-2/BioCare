-- reset.sql — KHUSUS DEVELOPMENT (BioCare). Jalankan sebagai hospital_reset (BUKAN root), lalu seed.sql:
--   mysql -u hospital_reset -p < database\reset.sql
--   mysql -u hospital_reset -p < database\seed.sql
-- Mengosongkan SEMUA tabel (struktur & trigger tetap; id kembali ke 1), termasuk profil
-- users dan jejak audit access_log. Data dev selalu dibangun ulang dari seed.sql karena:
--   - setelah node Hardhat di-restart, seluruh data on-chain (role, akses, rekam medis,
--     event) hilang, sehingga data MySQL tidak lagi punya pasangan di kontrak;
--   - rumus hash rekam medis bisa berubah antar-versi, sehingga data lama tidak bisa diverifikasi lagi.
-- Hasilnya sama dengan schema.sql + seed.sql, tanpa DROP DATABASE.
-- Dipakai juga oleh scripts/dev-db.js (uji, sebagai DB_RESET_USER = hospital_reset) agar uji bisa diulang.
-- TRUNCATE dipakai (bukan DELETE) karena trigger append-only memblokir DELETE.
-- TRUNCATE butuh hak DROP -> tidak bisa dijalankan hospital_app (disengaja); hospital_reset punya DROP + INSERT
-- saja di hospital_dapp (database/users.sql). SET FOREIGN_KEY_CHECKS = variabel sesi, tanpa hak tambahan.
-- File ini SENGAJA tanpa DELIMITER/trigger agar bisa dieksekusi apa adanya oleh skrip.
USE hospital_dapp;

SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE tx_log;
TRUNCATE TABLE prescription_ingredients;
TRUNCATE TABLE prescription_items;
TRUNCATE TABLE medical_record_versions;
TRUNCATE TABLE medical_records;
TRUNCATE TABLE appointment_changes;
TRUNCATE TABLE appointments;
TRUNCATE TABLE access_log;
TRUNCATE TABLE auth_nonces;
TRUNCATE TABLE auth_sessions;
TRUNCATE TABLE users;
SET FOREIGN_KEY_CHECKS = 1;
