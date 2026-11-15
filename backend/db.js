// db.js — pool koneksi MySQL/MariaDB (mysql2/promise).
// SEMUA query wajib parameterized: pool.execute(sql, [nilai, ...]) — jangan pernah
// menyambung input pengguna ke string SQL.
import mysql from "mysql2/promise";
import config from "./config.js";

export const pool = mysql.createPool({
  ...config.DB,
  connectionLimit: 10,
  dateStrings: true,        // DATE/DATETIME sebagai string -> tanggal lahir tidak bergeser zona waktu
  supportBigNumbers: true,  // BIGINT aman
  charset: "utf8mb4",
});

// Setiap koneksi baru di pool:
//  - strict mode: nilai ENUM tidak valid / teks terlalu panjang / tanggal nol DITOLAK (error),
//    bukan dipotong diam-diam lalu disimpan;
//  - time_zone WIB: NOW()/CURDATE()/CURRENT_TIMESTAMP & DATETIME appointment dalam Asia/Jakarta
//    (Indonesia tanpa DST, jadi offset tetap +07:00).
// Query ini masuk antrean koneksi SEBELUM query aplikasi mana pun.
export const SQL_MODE = "STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";
pool.pool.on("connection", (conn) => {
  conn.query(`SET SESSION sql_mode = '${SQL_MODE}', time_zone = '+07:00'`, (err) => {
    if (err) {
      console.error("[db] gagal memasang sql_mode/time_zone; koneksi dibuang:", err.code);
      conn.destroy(); // fail closed: jangan pakai koneksi tanpa strict mode
    }
  });
});

/**
 * Jalankan beberapa query dalam satu transaksi DB. fn(conn) memakai conn.execute(...).
 * Commit jika fn selesai, rollback jika fn melempar error (lalu error diteruskan).
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}
