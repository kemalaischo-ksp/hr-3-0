// Entrypoint Node (PostgreSQL) HR 3.0 — serve API + web/dist.
import { serve } from "@hono/node-server";
import pg from "pg";
import app from "./src/index.js";
import { createPg } from "./adapter/pg.js";
import { createAssets } from "./adapter/assets.js";
import { createNextcloud } from "./lib/nextcloud.js";

// NUMERIC (oid 1700) sebagai angka, bukan string.
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
// DATE (oid 1082) sebagai string YYYY-MM-DD (bukan Date UTC yang geser hari di WIB).
pg.types.setTypeParser(1082, (v) => v);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// Fail-fast di produksi: jangan pernah jalan dengan rahasia default/kosong.
// Proxy produksi ditandai oleh COOKIE_SECURE=1 (lihat docker-compose.yml).
const isProd = process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "1";
if (isProd) {
  const s = process.env.AUTH_SECRET || "";
  if (s.length < 32 || s.includes("dev-insecure") || s.includes("ubah-saya") || s.includes("ganti-dengan")) {
    console.error("FATAL: AUTH_SECRET wajib ≥32 karakter acak di produksi (openssl rand -base64 32).");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("FATAL: DATABASE_URL wajib di produksi.");
    process.exit(1);
  }
}

const NC = process.env.NEXTCLOUD_URL
  ? createNextcloud({
      baseUrl: process.env.NEXTCLOUD_URL,
      user: process.env.NEXTCLOUD_USER,
      password: process.env.NEXTCLOUD_PASS,
      groupFolder: process.env.NEXTCLOUD_GROUPFOLDER || "Arsip SDM",
    })
  : null;

const env = {
  DB: createPg(pool),
  ASSETS: createAssets(process.env.PUBLIC_DIR || "../web/dist"),
  AUTH_SECRET: process.env.AUTH_SECRET || "dev-insecure-secret-change-me",
  NC,
};

const port = Number(process.env.PORT || 3000);
serve({ fetch: (req) => app.fetch(req, env), port }, (info) => {
  console.log(`HRIS AL-WILDAN 3.0 (pilot AW3) di http://localhost:${info.port}`);
});
