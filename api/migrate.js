// Migrasi HR 3.0 (mandiri — tak bergantung folder HR 2.0).
//   node migrate.js            → baseline (bila DB kosong) + 001 + 002
//   node migrate.js --seed     → + seeds/aw3_pilot.sql (data uji, JANGAN di produksi)
// Lokasi SQL: ../db (dev) atau $DB_DIR (Docker: /app/db).
import pg from "pg";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL belum diset. Lihat .env.example.");
  process.exit(1);
}
const withSeed = process.argv.includes("--seed");
const DIR = process.env.DB_DIR || "../db";
const pool = new pg.Pool({ connectionString: url });

try {
  const cek = await pool.query("SELECT to_regclass('public.users') AS t");
  const files = [];
  if (!cek.rows[0].t) files.push(`${DIR}/base/00_schema_dasar.sql`, `${DIR}/base/01_seed_dasar.sql`);
  else console.log("Skema dasar sudah ada — lewati baseline.");
  files.push(`${DIR}/migrations/001_hr30_pilot_aw3.sql`, `${DIR}/migrations/002_nip_sequence.sql`, `${DIR}/migrations/003_user_permissions.sql`, `${DIR}/migrations/004_modul_lanjutan.sql`, `${DIR}/migrations/005_koreksi_presensi.sql`, `${DIR}/migrations/006_gateway_undangan.sql`, `${DIR}/migrations/007_password_reset.sql`);
  if (withSeed) files.push(`${DIR}/seeds/aw3_pilot.sql`);
  for (const f of files) {
    console.log("Terapkan", f);
    await pool.query(readFileSync(new URL(f, import.meta.url), "utf8"));
  }
  console.log("Migrasi HR 3.0 selesai.");
} catch (e) {
  console.error("GAGAL:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
