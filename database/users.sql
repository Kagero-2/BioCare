-- users.sql — user MySQL khusus aplikasi (jalankan sebagai root, setelah schema.sql).
-- Least privilege: backend TIDAK memakai root. Jika backend berhasil disusupi
-- (mis. lewat celah SQL injection), penyerang hanya bisa membaca/mengubah baris
-- di database hospital_dapp — tidak bisa DROP tabel, mengubah skema, membuat user,
-- membaca database lain, atau membaca file server (FILE).
-- WAJIB: ganti kedua placeholder password di bawah sebelum dijalankan, lalu tulis password
-- yang sama ke .env (DB_PASSWORD dan DB_RESET_PASSWORD), bukan di file ini / repo.
--
-- Host: setiap user dibuat untuk DUA host dengan password & grant yang SAMA.
--   'localhost' : MariaDB/XAMPP (tanpa skip-name-resolve) mencocokkan koneksi TCP dari 127.0.0.1 ke akun
--                 @localhost bila akun itu ada; juga dipakai perintah manual tanpa -h.
--   '127.0.0.1' : koneksi TCP bila nama host tidak di-resolve (skip-name-resolve).
-- Akun yang dibuat tanpa grant = login berhasil tetapi semua query ditolak (error 1044/1142), jadi
-- CREATE dan GRANT selalu berpasangan, dan diakhiri SHOW GRANTS agar kegagalan langsung terlihat.
-- Akun ini tidak bisa dipakai dari komputer lain (keduanya host lokal).

-- hospital_app — backend. Hanya DML pada hospital_dapp. Tanpa CREATE, ALTER, DROP, INDEX, TRIGGER,
-- GRANT OPTION, FILE. Isi medical_record_versions tetap tidak bisa diubah/dihapus karena dijaga trigger.
CREATE USER IF NOT EXISTS 'hospital_app'@'localhost' IDENTIFIED BY 'GANTI_DENGAN_PASSWORD_KUAT';
CREATE USER IF NOT EXISTS 'hospital_app'@'127.0.0.1' IDENTIFIED BY 'GANTI_DENGAN_PASSWORD_KUAT';
GRANT SELECT, INSERT, UPDATE, DELETE ON hospital_dapp.* TO 'hospital_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON hospital_dapp.* TO 'hospital_app'@'127.0.0.1';

-- hospital_reset — KHUSUS DEVELOPMENT: reset DB dev oleh skrip uji (scripts/dev-db.js:
-- reset.sql + seed.sql) dan perintah manual `mysql -u hospital_reset -p < database\reset.sql`.
-- JANGAN dibuat di server production. Menggantikan root untuk reset.
--   DROP   : TRUNCATE TABLE di reset.sql butuh hak DROP (TRUNCATE tidak memicu trigger append-only).
--            Efek samping yang diterima: akun ini juga bisa DROP TABLE di hospital_dapp (DB dev).
--   INSERT : seed.sql mengisi users, appointments, appointment_changes.
-- Tanpa SELECT/UPDATE/DELETE (tidak dibutuhkan reset/seed), tanpa hak global apa pun:
-- tanpa FILE (LOAD_FILE/INTO OUTFILE), SUPER, CREATE USER, GRANT OPTION; tidak bisa membaca mysql.* / DB lain.
CREATE USER IF NOT EXISTS 'hospital_reset'@'localhost' IDENTIFIED BY 'GANTI_DENGAN_PASSWORD_RESET_KUAT';
CREATE USER IF NOT EXISTS 'hospital_reset'@'127.0.0.1' IDENTIFIED BY 'GANTI_DENGAN_PASSWORD_RESET_KUAT';
GRANT INSERT, DROP ON hospital_dapp.* TO 'hospital_reset'@'localhost';
GRANT INSERT, DROP ON hospital_dapp.* TO 'hospital_reset'@'127.0.0.1';

FLUSH PRIVILEGES;

-- Verifikasi: setiap akun wajib menampilkan baris GRANT ... ON `hospital_dapp`.* selain USAGE.
-- Hanya "GRANT USAGE" = grant tidak tersimpan (lihat README bagian Troubleshooting).
-- Akun yang belum ada -> error 1141 dan skrip berhenti di sini.
SHOW GRANTS FOR 'hospital_app'@'localhost';
SHOW GRANTS FOR 'hospital_app'@'127.0.0.1';
SHOW GRANTS FOR 'hospital_reset'@'localhost';
SHOW GRANTS FOR 'hospital_reset'@'127.0.0.1';

-- Mengganti password di kemudian hari: tulis ALTER USER ke file .sql sementara (jangan sebagai argumen
-- command line: masuk riwayat shell & daftar proses), jalankan sebagai root, lalu hapus filenya.
-- Ganti SEMUA host user itu sekaligus, dengan nilai yang sama persis dengan .env.
--   ALTER USER 'hospital_app'@'localhost' IDENTIFIED BY 'password_baru';
--   ALTER USER 'hospital_app'@'127.0.0.1' IDENTIFIED BY 'password_baru';
--   ALTER USER 'hospital_reset'@'localhost' IDENTIFIED BY 'password_baru';
--   ALTER USER 'hospital_reset'@'127.0.0.1' IDENTIFIED BY 'password_baru';
