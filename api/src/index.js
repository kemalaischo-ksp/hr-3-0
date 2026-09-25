// ============================================================
// HRIS AL-WILDAN 3.0 — API pilot AW3 (Hono + PostgreSQL)
// Basis teruji dari HR 2.0 sim-hr-postgres, ditambah:
//  - mesin status aktivasi 3-tahap (finance → Doni → Kemal)
//  - validasi balance THP di server (422 bila tak balance)
//  - scope cabang (hr_cabang hanya cabangnya) + privasi NIK/norek
//  - rate-limit login + header keamanan dasar
// Peran: master_admin (semua) · hr_cabang (cabangnya) · pegawai (miliknya).
// Doni & Kemal masing-masing memakai akun master_admin sendiri sehingga
// jejak di aktivasi_logs/audit_logs tetap membedakan orangnya.
// ============================================================
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { PDFParse } from "pdf-parse";
import { aiLengkapi, parseSDM } from "../lib/sdmParse.js";

const app = new Hono();
const COOKIE = "hr30_session";
const SESSION_HOURS = 8;

// ---------- util encoding ----------
const enc = (s) => new TextEncoder().encode(s);
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const bytesToB64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBytes = (s) =>
  b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "="));

// ---------- password (PBKDF2, cocok dgn seed 2.0) ----------
async function verifyPassword(password, stored) {
  try {
    const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
    if (scheme !== "pbkdf2") return false;
    const iterations = parseInt(iterStr, 10);
    const salt = b64ToBytes(saltB64);
    const expected = b64ToBytes(hashB64);
    const km = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, km, 256);
    const actual = new Uint8Array(bits);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// ---------- katalog izin fitur (sumber tunggal; dipakai checklist admin) ----------
// Bawaan peran dikunci (tak bisa dicabut); kolom users.permissions = TAMBAHAN.
const PERM_CATALOG = [
  { key: "karyawan.lihat", label: "Melihat daftar & biodata karyawan" },
  { key: "karyawan.tambah", label: "Menambah data karyawan baru (Admin pusat)" },
  { key: "aktivasi.ajukan", label: "Mengajukan aktivasi THP (Finance)" },
  { key: "aktivasi.verifikasi", label: "Verifikasi aktivasi (Doni)" },
  { key: "aktivasi.setujui", label: "Menyetujui & mengaktifkan (Kemal)" },
  { key: "payroll.lihat", label: "Melihat rekap payroll" },
  { key: "payroll.kunci", label: "Mengunci periode payroll" },
  { key: "slip.lihat", label: "Melihat & mencetak slip gaji" },
  { key: "users.kelola", label: "Mengelola pengguna & hak akses" },
  { key: "audit.lihat", label: "Melihat log audit" },
  { key: "absensi.kelola", label: "Mencatat & melihat absensi cabang" },
  { key: "presensi.mandiri", label: "Mencatat presensi mandiri (check-in/out milik sendiri)" },
  { key: "karyawan.kelola", label: "Mengelola data kerja karyawan (atasan, status, foto)" },
  { key: "laporan.lihat", label: "Melihat laporan & rekap" },
  { key: "pengaturan.kelola", label: "Mengubah pengaturan aplikasi" },
  { key: "lembur.ajukan", label: "Mengajukan lembur" },
  { key: "lembur.setujui", label: "Menyetujui/menolak lembur" },
  { key: "reimburse.ajukan", label: "Mengajukan reimbursement" },
  { key: "reimburse.setujui", label: "Menyetujui/menolak reimbursement" },
  { key: "surat.ajukan", label: "Mengajukan surat kerja" },
  { key: "surat.setujui", label: "Menyetujui/menolak surat kerja" },
  { key: "ubahdata.ajukan", label: "Mengajukan perubahan data pribadi" },
  { key: "ubahdata.setujui", label: "Menyetujui/menolak perubahan data" },
  { key: "koreksi.ajukan", label: "Mengajukan koreksi presensi" },
  { key: "koreksi.setujui", label: "Menyetujui/menolak koreksi presensi" },
  { key: "kpi.kelola", label: "Mengelola penilaian kinerja" },
  { key: "cuti.ajukan", label: "Mengajukan cuti/izin" },
  { key: "cuti.setujui", label: "Menyetujui/menolak cuti" },
];
const PERM_KEYS = PERM_CATALOG.map((p) => p.key);
const DEFAULT_PERMS = {
  master_admin: [...PERM_KEYS], // termasuk karyawan.tambah (Admin pusat saja)
  hr_cabang: ["karyawan.lihat", "aktivasi.ajukan", "payroll.lihat", "slip.lihat", "absensi.kelola", "cuti.ajukan", "cuti.setujui", "presensi.mandiri",
    "karyawan.kelola", "laporan.lihat", "lembur.setujui", "reimburse.setujui", "surat.setujui", "ubahdata.setujui", "kpi.kelola",
    "lembur.ajukan", "reimburse.ajukan", "surat.ajukan", "ubahdata.ajukan", "koreksi.ajukan", "koreksi.setujui"],
  pegawai: ["slip.lihat", "cuti.ajukan", "presensi.mandiri", "lembur.ajukan", "reimburse.ajukan", "surat.ajukan", "ubahdata.ajukan", "koreksi.ajukan"],
};
const asArray = (v) => (Array.isArray(v) ? v : typeof v === "string" ? JSON.parse(v) : []);
function effPerms(user) {
  if (user.role === "master_admin") return [...PERM_KEYS];
  const extra = asArray(user.permissions).filter((k) => PERM_KEYS.includes(k));
  return [...new Set([...(DEFAULT_PERMS[user.role] || []), ...extra])];
}
const punya = (user, key) => effPerms(user).includes(key);
const requirePerm = (...keys) => async (c, next) => {
  const u = c.get("user");
  if (!keys.some((k) => punya(u, k))) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
  await next();
};

// ---------- hash kata sandi baru (format sama dgn seed) ----------
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 50000, hash: "SHA-256" }, km, 256);
  return `pbkdf2$50000$${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}

// ---------- session token (HMAC-SHA256) ----------
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signToken(payload, secret) {
  const body = bytesToB64url(enc(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc(body));
  return body + "." + bytesToB64url(new Uint8Array(sig));
}
async function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig), enc(body));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
const secretOf = (env) => env.AUTH_SECRET || "dev-insecure-secret-change-me";

function getCookie(req, name) {
  const h = req.header("Cookie") || "";
  const m = h.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

// ---------- CORS API (dev frontend & subdomain produksi) ----------
// Produksi: CORS_ORIGIN=https://hr.office-alwildan.id (tanpa itu, browser tolak).
const CORS_LIST = (process.env.CORS_ORIGIN || "http://127.0.0.1:5173").split(",").map((s) => s.trim()).filter(Boolean);
app.use("/api/*", cors({ origin: CORS_LIST, allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], credentials: true }));

// ---------- identitas klien untuk rate-limit ----------
// JANGAN pakai X-Forwarded-For mentah (bisa dipalsukan). Di belakang
// Cloudflare + Caddy, IP asli ada di CF-Connecting-IP / X-Real-IP.
// Origin juga hanya bisa menjangkau 127.0.0.1 (Caddy), jadi header ini tepercaya.
function clientIp(c) {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Real-IP") ||
    (c.req.header("X-Forwarded-For") || "").split(",")[0].trim() ||
    "local"
  );
}

// ---------- header keamanan ----------
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header("Permissions-Policy", "geolocation=(self), camera=(self), microphone=()");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; ")
  );
});

// ---------- rate-limit (memori proses; cukup untuk pilot) ----------
const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const loginHits = new Map(); // key -> [timestamps]
function loginAllowed(key) {
  return rateOk(key, LOGIN_MAX, LOGIN_WINDOW_MS);
}
// Limiter serbaguna: key -> [timestamps]; true bila masih di bawah batas.
const rateHits = new Map();
function rateOk(key, max, windowMs) {
  const now = Date.now();
  const arr = (rateHits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  rateHits.set(key, arr);
  return true;
}

// ---------- middleware: wajib login ----------
async function auth(c, next) {
  const token = getCookie(c.req, COOKIE);
  const payload = await verifyToken(token, secretOf(c.env));
  if (!payload) return c.json({ error: "Belum login" }, 401);
  const user = await c.env.DB.prepare(
    "SELECT id, email, name, role, unit_id, permissions, aktif FROM users WHERE id = ?"
  ).bind(payload.sub).first();
  if (!user) return c.json({ error: "Akun tidak ditemukan" }, 401);
  if (user.aktif === 0) return c.json({ error: "Akun dinonaktifkan" }, 403);
  c.set("user", user);
  await next();
}
const requireRole = (...roles) => async (c, next) => {
  const u = c.get("user");
  if (!roles.includes(u.role)) return c.json({ error: "Akses ditolak" }, 403);
  await next();
};

// ---------- scope cabang untuk hr_cabang ----------
// Cabang user = cabang dari unitnya. NULL (unit lama) → fallback ke unit_id.
async function userCabangId(DB, user) {
  if (!user.unit_id) return null;
  const r = await DB.prepare("SELECT cabang_id FROM units WHERE id = ?").bind(user.unit_id).first();
  return r ? r.cabang_id : null;
}
async function employeeInScope(DB, user, empId) {
  const e = await DB.prepare(
    "SELECT e.id, e.unit_id, e.cabang_id, un.cabang_id AS unit_cabang FROM employees e LEFT JOIN units un ON un.id = e.unit_id WHERE e.id = ?"
  ).bind(empId).first();
  if (!e) return { ok: false, code: 404, error: "Tidak ditemukan" };
  if (user.role === "master_admin") return { ok: true, emp: e };
  if (user.role === "hr_cabang") {
    const cab = await userCabangId(DB, user);
    const empCab = e.cabang_id ?? e.unit_cabang;
    if (cab && empCab === cab) return { ok: true, emp: e };
    // fallback unit lama tanpa cabang
    if (!cab && e.unit_id === user.unit_id) return { ok: true, emp: e };
    return { ok: false, code: 403, error: "Bukan cabang Anda" };
  }
  return { ok: false, code: 403, error: "Akses ditolak" };
}

// ---------- mesin status aktivasi (izin per tahap, bukan peran keras) ----------
// finance: draft|ditolak → diajukan_finance (izin aktivasi.ajukan)
// Doni:    diajukan_finance → diverifikasi_doni (izin aktivasi.verifikasi)
// Kemal:   diverifikasi_doni → aktif (izin aktivasi.setujui)
const TRANSISI = {
  diajukan_finance: { dari: ["draft", "ditolak"], izin: "aktivasi.ajukan" },
  diverifikasi_doni: { dari: ["diajukan_finance"], izin: "aktivasi.verifikasi" },
  aktif: { dari: ["diverifikasi_doni"], izin: "aktivasi.setujui" },
  ditolak: { dari: ["draft", "diajukan_finance", "diverifikasi_doni"], izin: "aktivasi.setujui" },
};

function cekBalance(b) {
  const n = (x) => Number(x) || 0;
  if (n(b.thp_bersih) !== n(b.thp_kotor) - n(b.total_tk_thr))
    return `THP bersih (${n(b.thp_bersih)}) harus = kotor (${n(b.thp_kotor)}) − total (${n(b.total_tk_thr)})`;
  if (n(b.total_tk_thr) !== n(b.tk) + n(b.thr_bulan))
    return `Total TK-THR (${n(b.total_tk_thr)}) harus = TK (${n(b.tk)}) + THR/bulan (${n(b.thr_bulan)})`;
  return null;
}

// ============================================================
//  API
// ============================================================

app.get("/api/health", (c) => c.json({ ok: true, service: "hr30-aw3", time: new Date().toISOString() }));

// LOGIN — terima {email,password} (frontend) atau {identifier,password} (lama).
// Peran dibaca dari akun, BUKAN dipilih user.
app.post("/api/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const identifier = body.identifier || body.email;
  const password = body.password;
  if (!identifier || !password) return c.json({ error: "Lengkapi email dan kata sandi" }, 400);
  const ip = clientIp(c);
  const key = `${ip}:${String(identifier).toLowerCase()}`;
  if (!loginAllowed(key)) return c.json({ error: "Terlalu banyak percobaan. Coba lagi 10 menit." }, 429);

  const id = String(identifier).trim().toLowerCase();
  let user = await c.env.DB.prepare(
    "SELECT id, email, name, role, unit_id, password_hash, aktif FROM users WHERE lower(email) = ?"
  ).bind(id).first();
  if (!user) {
    user = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.role, u.unit_id, u.password_hash, u.aktif
       FROM employees e JOIN users u ON u.id = e.user_id WHERE e.nip = ?`
    ).bind(id).first();
  }
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: "Email atau kata sandi salah" }, 401);
  }
  if (user.aktif === 0) return c.json({ error: "Akun dinonaktifkan" }, 403);
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const token = await signToken({ sub: user.id, role: user.role, exp }, secretOf(c.env));
  const secure = (process.env.COOKIE_SECURE || "") === "1" ? "; Secure" : "";
  c.header("Set-Cookie", `${COOKIE}=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
  return c.json({ id: user.id, name: user.name, email: user.email, role: user.role, unit_id: user.unit_id });
});

app.post("/api/logout", (c) => {
  c.header("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  return c.json({ ok: true });
});

// ---------- Lupa / reset kata sandi via Resend ----------
// POST /api/forgot-password {email} — publik, SELALU respons generik (anti-enumerasi akun).
// Bila RESEND_API_KEY diset: kirim tautan 1x pakai (kedaluwarsa 1 jam) via Resend.
// Bila tidak: tautan hanya dicatat di log server (mode dev).
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function tokenAcak(n = 32) {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(n)));
}
function baseUrlPublik() {
  return (
    (process.env.APP_URL || "").trim() ||
    (process.env.CORS_ORIGIN || "").split(",")[0].trim() ||
"https://hr.office-alwildan.id"
  );
}
async function kirimEmailResend({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY || "";
  if (!key) throw new Error("RESEND_API_KEY belum dikonfigurasi");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || "HRIS AL-WILDAN <hr@alwildan.sch.id>",
      to, subject, html, text,
    }),
  });
  if (!r.ok) throw new Error(`Resend menolak (${r.status}): ${(await r.text()).slice(0, 200)}`);
}

const PESAN_LUPA = "Jika email terdaftar, tautan reset sudah dikirim. Cek inbox/spam dalam 10 menit.";
app.post("/api/forgot-password", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const email = String(b.email || "").trim().toLowerCase();
  const ip = clientIp(c);
  if (!loginAllowed(`fp:${ip}:${email}`)) return c.json({ error: "Terlalu banyak permintaan. Coba lagi 10 menit." }, 429);
  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    const user = await c.env.DB.prepare(
      "SELECT id, email, name, aktif FROM users WHERE lower(email) = ?"
    ).bind(email).first();
    if (user && user.aktif !== 0) {
      const token = tokenAcak();
      await c.env.DB.prepare(
        "DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL"
      ).bind(user.id).run();
      await c.env.DB.prepare(
        "INSERT INTO password_reset_tokens (token_hash, user_id) VALUES (?,?)"
      ).bind(await sha256hex(token), user.id).run();
      const tautan = `${baseUrlPublik()}/reset-password?token=${token}`;
      const subject = "Tautan reset kata sandi HRIS AL-WILDAN";
      const text =
        `Assalamu'alaikum ${user.name || user.email},\n\n` +
        `Kami menerima permintaan reset kata sandi akun HRIS AL-WILDAN Anda.\n` +
        `Klik tautan berikut (berlaku 1 jam, satu kali pakai):\n${tautan}\n\n` +
        `Abaikan email ini bila Anda tidak memintanya.`;
      const html =
        `<p>Assalamu'alaikum ${user.name || user.email},</p>` +
        `<p>Kami menerima permintaan reset kata sandi akun HRIS AL-WILDAN Anda. ` +
        `Klik tombol berikut (berlaku <b>1 jam</b>, satu kali pakai):</p>` +
        `<p><a href="${tautan}" style="display:inline-block;padding:10px 20px;background:#0f766e;color:#fff;text-decoration:none;border-radius:8px">Reset kata sandi</a></p>` +
        `<p>Bila tombol tidak berfungsi, salin tautan ini:<br><code>${tautan}</code></p>` +
        `<p>Abaikan email ini bila Anda tidak memintanya.</p>`;
      try {
        await kirimEmailResend({ to: user.email, subject, html, text });
      } catch (e) {
        // Jangan bocorkan ke user; admin cek log server.
        console.error("GAGAL kirim reset via Resend:", e.message);
      }
      if (!process.env.RESEND_API_KEY) console.log(`[dev] tautan reset ${user.email}: ${tautan}`);
    }
  }
  return c.json({ ok: true, message: PESAN_LUPA });
});

// POST /api/reset-password {token, password} — publik (rate-limit), token 1x pakai.
app.post("/api/reset-password", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const token = String(b.token || "");
  const password = String(b.password || "");
  const ip = clientIp(c);
  if (!loginAllowed(`rs:${ip}`)) return c.json({ error: "Terlalu banyak percobaan. Coba lagi 10 menit." }, 429);
  if (!token) return c.json({ error: "Token reset wajib" }, 400);
  if (password.length < 8) return c.json({ error: "Kata sandi minimal 8 karakter" }, 400);
  const row = await c.env.DB.prepare(
    "SELECT token_hash, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?"
  ).bind(await sha256hex(token)).first();
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
    return c.json({ error: "Tautan tidak valid atau kedaluwarsa. Minta tautan baru di halaman Lupa Kata Sandi." }, 400);
  }
  await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(password), row.user_id).run();
  await c.env.DB.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").bind(row.user_id).run();
  return c.json({ ok: true });
});

app.get("/api/me", auth, (c) => {
  const u = c.get("user");
  return c.json({ id: u.id, email: u.email, name: u.name, role: u.role, unit_id: u.unit_id, permissions: effPerms(u) });
});

// KATALOG IZIN — untuk checklist halaman admin
app.get("/api/permission-catalog", auth, requirePerm("users.kelola"), (c) =>
  c.json(PERM_CATALOG.map((p) => ({ ...p, bawaan: DEFAULT_PERMS }))
  ));

// UNIT + CABANG — untuk form penempatan pengguna (hanya users.kelola)
app.get("/api/units", auth, requirePerm("users.kelola"), async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT un.id, un.nama, un.kode, cb.kode AS cabang, cb.nama AS cabang_nama FROM units un LEFT JOIN cabangs cb ON cb.id = un.cabang_id ORDER BY un.nama"
  ).all();
  return c.json(results);
});

// PENGGUNA — kelola akun + izin tambahan (hanya users.kelola)
app.get("/api/users", auth, requirePerm("users.kelola"), async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, email, name, role, unit_id, permissions, aktif FROM users ORDER BY name"
  ).all();
  return c.json(results.map((r) => ({ ...r, permissions: asArray(r.permissions) })));
});

app.post("/api/users", auth, requirePerm("users.kelola"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const email = String(b.email || "").trim().toLowerCase();
  const name = String(b.name || "").trim();
  const role = b.role || "pegawai";
  const password = String(b.password || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "Email tidak valid" }, 400);
  if (!name) return c.json({ error: "Nama wajib" }, 400);
  if (!["master_admin", "hr_cabang", "pegawai"].includes(role)) return c.json({ error: "Peran tidak dikenal" }, 400);
  if (password.length < 8) return c.json({ error: "Kata sandi minimal 8 karakter" }, 400);
  const perms = asArray(b.permissions).filter((k) => PERM_KEYS.includes(k));
  const id = "u-" + Date.now().toString(36);
  try {
    await c.env.DB.prepare(
      "INSERT INTO users (id, email, name, role, unit_id, password_hash, permissions) VALUES (?,?,?,?,?,?,?)"
    ).bind(id, email, name, role, b.unit_id || null, await hashPassword(password), JSON.stringify(perms)).run();
  } catch {
    return c.json({ error: "Email sudah dipakai" }, 409);
  }
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (user_id, aksi, tabel, record_id, nilai_baru, ip) VALUES (?,?,?,?,?,?)"
  ).bind(u.id, "user_create", "users", 0, JSON.stringify({ email, role }), clientIp(c)).run();
  return c.json({ ok: true, id });
});

app.patch("/api/users/:id", auth, requirePerm("users.kelola"), async (c) => {
  const u = c.get("user");
  const id = c.req.param("id");
  const b = await c.req.json().catch(() => ({}));
  if (id === u.id && (b.aktif === 0 || (b.role && b.role !== u.role)))
    return c.json({ error: "Tidak bisa menonaktifkan/menurunkan akun sendiri" }, 400);
  const sets = [];
  const args = [];
  if (b.name !== undefined) { sets.push("name=?"); args.push(String(b.name).trim()); }
  if (b.role !== undefined) {
    if (!["master_admin", "hr_cabang", "pegawai"].includes(b.role)) return c.json({ error: "Peran tidak dikenal" }, 400);
    sets.push("role=?"); args.push(b.role);
  }
  if (b.unit_id !== undefined) { sets.push("unit_id=?"); args.push(b.unit_id || null); }
  if (b.permissions !== undefined) {
    sets.push("permissions=?");
    args.push(JSON.stringify(asArray(b.permissions).filter((k) => PERM_KEYS.includes(k))));
  }
  if (b.aktif !== undefined) { sets.push("aktif=?"); args.push(b.aktif ? 1 : 0); }
  if (b.password !== undefined) {
    if (String(b.password).length < 8) return c.json({ error: "Kata sandi minimal 8 karakter" }, 400);
    sets.push("password_hash=?"); args.push(await hashPassword(String(b.password)));
  }
  if (!sets.length) return c.json({ error: "Tidak ada perubahan" }, 400);
  args.push(id);
  const r = await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id=?`).bind(...args).run();
  if ((r.meta?.changes ?? 0) === 0) return c.json({ error: "Pengguna tidak ditemukan" }, 404);
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (user_id, aksi, tabel, record_id, nilai_baru, ip) VALUES (?,?,?,?,?,?)"
  ).bind(u.id, "user_update", "users", 0, JSON.stringify({ id, ubah: sets }), clientIp(c)).run();
  return c.json({ ok: true });
});

// DAFTAR PEGAWAI — butuh karyawan.lihat; tanpa NIK/norek (sensitif tak pernah ke klien).
app.get("/api/employees", auth, requirePerm("karyawan.lihat", "slip.lihat"), async (c) => {
  const u = c.get("user");
  let q = `SELECT e.id, e.nip, e.nama_gelar AS nama, e.nama_gelar, e.email, e.no_hp,
             e.jabatan, e.gender, e.posisi_diajukan, e.mapel, un.nama AS unit, e.gaji_diajukan,
             e.alamat, e.tempat_lahir, e.tgl_lahir, e.status_kawin, e.transport,
             e.tinggi_cm, e.berat_kg,
             e.bank_utama, e.norek_utama, e.bank_lain, e.norek_lain, e.kesehatan_url,
             e.thp_kotor, e.konfirmasi, e.thp_bersih, e.total_tk_thr, e.tk, e.thr_bulan,
             e.tmt_aktif, e.mode_thp, e.status_aktivasi, e.cv_url,
             e.status_kerja, e.tgl_masuk, e.atasan_id, e.foto_url, e.kontak_darurat,
             cb.kode AS cabang, (e.user_id IS NOT NULL) AS punya_akun,
             atasan.nama_gelar AS atasan_nama
           FROM employees e JOIN units un ON un.id = e.unit_id LEFT JOIN employees atasan ON atasan.id = e.atasan_id LEFT JOIN cabangs cb ON cb.id = COALESCE(e.cabang_id, un.cabang_id)`;
  const args = [];
  if (u.role === "hr_cabang") {
    const cab = await userCabangId(c.env.DB, u);
    if (cab) { q += " WHERE COALESCE(e.cabang_id, un.cabang_id) = ?"; args.push(cab); }
    else { q += " WHERE e.unit_id = ?"; args.push(u.unit_id); }
  } else if (u.role === "pegawai") {
    q += " WHERE e.user_id = ?";
    args.push(u.id);
  }
  q += " ORDER BY e.nama_gelar";
  const { results } = await c.env.DB.prepare(q).bind(...args).all();
  if (u.role === "pegawai") {
    // pegawai: hanya THP bersih miliknya
    return c.json(results.map((r) => ({ id: r.id, nip: r.nip, nama_gelar: r.nama_gelar, thp_bersih: r.thp_bersih, status_aktivasi: r.status_aktivasi })));
  }
  return c.json(results);
});

// DETAIL PEGAWAI — scope sama; pegawai hanya miliknya (tanpa NIK/norek).
app.get("/api/employees/:id", auth, async (c) => {
  const u = c.get("user");
  const id = c.req.param("id");
  if (u.role === "pegawai") {
    const e = await c.env.DB.prepare(
      "SELECT id, nip, nama_gelar, thp_bersih, status_aktivasi FROM employees WHERE id = ? AND user_id = ?"
    ).bind(id, u.id).first();
    if (!e) return c.json({ error: "Akses ditolak" }, 403);
    return c.json(e);
  }
  const chk = await employeeInScope(c.env.DB, u, id);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  const e = await c.env.DB.prepare(
    `SELECT e.id, e.nip, e.nama_gelar, e.email, e.no_hp, e.jabatan, e.gender, e.alamat, e.tempat_lahir, e.tgl_lahir,
       e.status_kawin, e.transport, e.tinggi_cm, e.berat_kg, e.posisi_diajukan, e.mapel, un.nama AS unit, e.gaji_diajukan,
       e.bank_utama, e.norek_utama, e.bank_lain, e.norek_lain,
       e.thp_kotor, e.konfirmasi, e.thp_bersih, e.total_tk_thr, e.tk, e.thr_bulan,
       e.tmt_aktif, e.mode_thp, e.status_aktivasi, e.cv_url, e.kesehatan_url,
       e.status_kerja, e.tgl_masuk, e.atasan_id, e.foto_url, e.kontak_darurat,
       atasan.nama_gelar AS atasan_nama
      FROM employees e JOIN units un ON un.id = e.unit_id LEFT JOIN employees atasan ON atasan.id = e.atasan_id WHERE e.id = ?`
  ).bind(id).first();
  if (!e) return c.json({ error: "Tidak ditemukan" }, 404);
  return c.json(e);
});

// STATISTIK HOLDING — master_admin (semua) / hr_cabang (cabangnya).
// Agregat: per cabang (total, aktif, pending, gender), per divisi (unit),
// per pendidikan (jenjang tertinggi), total gender & akun.
app.get("/api/statistik", auth, requirePerm("laporan.lihat", "karyawan.lihat"), async (c) => {
  const u = c.get("user");
  let cabFilter = null;
  if (u.role === "hr_cabang") {
    cabFilter = await userCabangId(c.env.DB, u);
    if (!cabFilter && u.unit_id) {
      // fallback unit lama: batasi ke unitnya saja
      const { results } = await c.env.DB.prepare(
        `SELECT e.id, e.status_aktivasi, e.status_kerja, e.gender, e.unit_id, un.nama AS unit,
                NULL AS cabang_kode, NULL AS cabang_nama
         FROM employees e JOIN units un ON un.id = e.unit_id WHERE e.unit_id = ?`
      ).bind(u.unit_id).all();
      return c.json(ringkasStatistik(results, [], true));
    }
  }
  const args = [];
  let where = "";
  if (cabFilter) { where = "WHERE COALESCE(e.cabang_id, un.cabang_id) = ?"; args.push(cabFilter); }
  const { results: rows } = await c.env.DB.prepare(
    `SELECT e.id, e.status_aktivasi, e.status_kerja, e.gender, e.unit_id, un.nama AS unit,
            cb.kode AS cabang_kode, cb.nama AS cabang_nama
     FROM employees e JOIN units un ON un.id = e.unit_id
     LEFT JOIN cabangs cb ON cb.id = COALESCE(e.cabang_id, un.cabang_id)
     ${where} ORDER BY e.id`
  ).bind(...args).all();
  const ids = rows.map((r) => r.id);
  let pend = [];
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const r = await c.env.DB.prepare(
      `SELECT employee_id, jenjang FROM pendidikan WHERE employee_id IN (${ph})`
    ).bind(...ids).all();
    pend = r.results;
  }
  return c.json(ringkasStatistik(rows, pend, false));
});

function ringkasStatistik(rows, pendRows, unitSaja) {
  const bobot = { S3: 3, S2: 2, S1: 1 };
  const tertinggi = new Map();
  for (const p of pendRows) {
    const cur = tertinggi.get(p.employee_id);
    if (!cur || (bobot[p.jenjang] || 0) > (bobot[cur] || 0)) tertinggi.set(p.employee_id, p.jenjang);
  }
  const kosong = () => ({ total: 0, aktif: 0, pending: 0, pria: 0, perempuan: 0, tanpa_gender: 0 });
  const isi = (ag, r) => {
    ag.total += 1;
    if (r.status_aktivasi === "aktif") ag.aktif += 1; else ag.pending += 1;
    if (r.gender === "Pria") ag.pria += 1;
    else if (r.gender === "Perempuan") ag.perempuan += 1;
    else ag.tanpa_gender += 1;
  };
  const total = { ...kosong(), cabang: 0 };
  const perCabang = new Map();
  const perDivisi = new Map();
  const perPendidikan = { S3: 0, S2: 0, S1: 0, belum: 0 };
  for (const r of rows) {
    isi(total, r);
    const ck = r.cabang_kode || (unitSaja ? "UNIT" : "TANPA_CABANG");
    if (!perCabang.has(ck)) perCabang.set(ck, { kode: r.cabang_kode, nama: r.cabang_nama || r.unit || ck, ...kosong() });
    isi(perCabang.get(ck), r);
    const dk = r.unit || "Tanpa unit";
    if (!perDivisi.has(dk)) perDivisi.set(dk, { unit: dk, ...kosong() });
    isi(perDivisi.get(dk), r);
    const j = tertinggi.get(r.id);
    if (j && perPendidikan[j] !== undefined) perPendidikan[j] += 1;
    else perPendidikan.belum += 1;
  }
  total.cabang = perCabang.size;
  const srt = (m) => [...m.values()].sort((a, b) => b.total - a.total);
  return {
    total, per_cabang: srt(perCabang), per_divisi: srt(perDivisi), per_pendidikan: perPendidikan,
    gender: { pria: total.pria, perempuan: total.perempuan, tanpa: total.tanpa_gender },
  };
}

// BUATKAN AKUN dari karyawan — users.kelola (scope cabang).
// Body {email?, password?, role?}: email default email karyawan (wajib bila kosong),
// password kosong = acak 12 char (dikembalikan sekali), role default pegawai.
app.post("/api/employees/:id/buatkan-akun", auth, requirePerm("users.kelola"), async (c) => {
  const u = c.get("user");
  const empId = Number(c.req.param("id"));
  const b = await c.req.json().catch(() => ({}));
  const chk = await employeeInScope(c.env.DB, u, empId);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  const e = await c.env.DB.prepare(
    "SELECT id, nip, nama_gelar, email, unit_id, user_id FROM employees WHERE id = ?"
  ).bind(empId).first();
  if (!e) return c.json({ error: "Tidak ditemukan" }, 404);
  if (e.user_id) {
    const ada = await c.env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(e.user_id).first();
    if (ada) return c.json({ error: `Sudah punya akun (${ada.email})` }, 409);
  }
  const email = String(b.email || e.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "Email wajib (karyawan belum punya email — isi di dialog)" }, 400);
  const role = b.role || "pegawai";
  if (!["master_admin", "hr_cabang", "pegawai"].includes(role)) return c.json({ error: "Peran tidak dikenal" }, 400);
  let password = String(b.password || "");
  let acak = false;
  if (!password) { password = sandiAcak(12); acak = true; }
  if (password.length < 8) return c.json({ error: "Kata sandi minimal 8 karakter" }, 400);
  const id = "u-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    await c.env.DB.prepare(
      "INSERT INTO users (id, email, name, role, unit_id, password_hash, permissions) VALUES (?,?,?,?,?,?,?)"
    ).bind(id, email, e.nama_gelar, role, e.unit_id, await hashPassword(password), "[]").run();
  } catch {
    return c.json({ error: "Email sudah dipakai akun lain" }, 409);
  }
  await c.env.DB.prepare("UPDATE employees SET user_id = ? WHERE id = ?").bind(id, empId).run();
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (user_id, aksi, tabel, record_id, nilai_baru, ip) VALUES (?,?,?,?,?,?)"
  ).bind(u.id, "user_create_dari_karyawan", "users", 0, JSON.stringify({ email, role, employee_id: empId }), clientIp(c)).run();
  const hasil = { ok: true, id, email, role };
  if (acak) hasil.sandi_sementara = password;
  return c.json(hasil, 201);
});

// HAPUS KARYAWAN — Admin pusat (karyawan.tambah). Pengaman: tolak bila punya
// riwayat payroll atau masih menjadi atasan bawahan. Dokumen metadata ikut
// dihapus; akun login tertaut ikut dihapus; sisanya CASCADE oleh FK.
app.delete("/api/employees/:id", auth, requirePerm("karyawan.tambah"), async (c) => {
  const u = c.get("user");
  const empId = Number(c.req.param("id"));
  const chk = await employeeInScope(c.env.DB, u, empId);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  const e = await c.env.DB.prepare(
    "SELECT id, nip, nama_gelar, user_id FROM employees WHERE id = ?"
  ).bind(empId).first();
  if (!e) return c.json({ error: "Tidak ditemukan" }, 404);
  const pay = await c.env.DB.prepare("SELECT count(*) AS n FROM payrolls WHERE employee_id = ?").bind(empId).first();
  if (pay && Number(pay.n) > 0)
    return c.json({ error: `Tidak bisa dihapus: punya ${pay.n} riwayat payroll` }, 422);
  const baw = await c.env.DB.prepare("SELECT count(*) AS n FROM employees WHERE atasan_id = ?").bind(empId).first();
  if (baw && Number(baw.n) > 0)
    return c.json({ error: `Tidak bisa dihapus: masih atasan dari ${baw.n} karyawan (pindahkan dulu)` }, 422);
  await c.env.DB.prepare("DELETE FROM documents WHERE employee_id = ?").bind(empId).run();
  if (e.user_id) await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(e.user_id).run();
  await c.env.DB.prepare("DELETE FROM employees WHERE id = ?").bind(empId).run();
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (user_id, aksi, tabel, record_id, nilai_lama, ip) VALUES (?,?,?,?,?,?)"
  ).bind(u.id, "karyawan.hapus", "employees", empId, JSON.stringify({ nip: e.nip, nama: e.nama_gelar }), clientIp(c)).run();
  return c.json({ ok: true, nip: e.nip });
});

// BULK AKUN — buatkan akun untuk SEMUA karyawan dalam scope yang belum punya
// akun dan punya email valid. Body {role?, cabang?, password?} — password kosong
// = acak per akun. Kembalikan kredensial SEKALI (jangan disimpan di server).
app.post("/api/employees/bulk-akun", auth, requirePerm("users.kelola"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const role = b.role || "pegawai";
  if (!["master_admin", "hr_cabang", "pegawai"].includes(role)) return c.json({ error: "Peran tidak dikenal" }, 400);
  let passwordSama = String(b.password || "");
  if (passwordSama && passwordSama.length < 8) return c.json({ error: "Kata sandi minimal 8 karakter" }, 400);
  let cabFilter = typeof b.cabang === "string" && b.cabang ? b.cabang : null;
  if (u.role === "hr_cabang") {
    const milikId = await userCabangId(c.env.DB, u);
    const milikKode = milikId
      ? (await c.env.DB.prepare("SELECT kode FROM cabangs WHERE id = ?").bind(milikId).first())?.kode || null
      : null;
    if (cabFilter && milikKode && cabFilter !== milikKode) return c.json({ error: "Bukan cabang Anda" }, 403);
    if (!milikKode && u.unit_id) {
      const { results } = await c.env.DB.prepare(
        "SELECT e.id, e.nip, e.nama_gelar, e.email, e.unit_id FROM employees e WHERE e.unit_id = ? AND e.user_id IS NULL"
      ).bind(u.unit_id).all();
      return bulkBuatAkun(c, u, results, role, passwordSama);
    }
    if (!milikKode) return c.json({ ok: true, dibuat: [], dilewati: [] });
    cabFilter = milikKode;
  }
  const args = [];
  let where = "e.user_id IS NULL";
  if (cabFilter) { where += " AND COALESCE(e.cabang_id, un.cabang_id) = (SELECT id FROM cabangs WHERE kode = ?)"; args.push(cabFilter); }
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.nip, e.nama_gelar, e.email, e.unit_id FROM employees e
     JOIN units un ON un.id = e.unit_id WHERE ${where} ORDER BY e.id`
  ).bind(...args).all();
  return bulkBuatAkun(c, u, results, role, passwordSama);
});

async function bulkBuatAkun(c, u, rows, role, passwordSama) {
  const { results: ada } = await c.env.DB.prepare("SELECT lower(email) AS email FROM users").all();
  const terpakai = new Set(ada.map((r) => r.email));
  const dibuat = [];
  const dilewati = [];
  for (const e of rows) {
    const email = String(e.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { dilewati.push({ nip: e.nip, nama: e.nama_gelar, alasan: "tanpa email valid" }); continue; }
    if (terpakai.has(email)) { dilewati.push({ nip: e.nip, nama: e.nama_gelar, alasan: "email sudah dipakai" }); continue; }
    const sandi = passwordSama || sandiAcak(12);
    const id = "u-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try {
      await c.env.DB.prepare(
        "INSERT INTO users (id, email, name, role, unit_id, password_hash, permissions) VALUES (?,?,?,?,?,?,?)"
      ).bind(id, email, e.nama_gelar, role, e.unit_id, await hashPassword(sandi), "[]").run();
    } catch {
      dilewati.push({ nip: e.nip, nama: e.nama_gelar, alasan: "email sudah dipakai" }); continue;
    }
    terpakai.add(email);
    await c.env.DB.prepare("UPDATE employees SET user_id = ? WHERE id = ?").bind(id, e.id).run();
    dibuat.push({ nip: e.nip, nama: e.nama_gelar, email, sandi });
  }
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (user_id, aksi, tabel, record_id, nilai_baru, ip) VALUES (?,?,?,?,?,?)"
  ).bind(u.id, "user_bulk_akun", "users", 0, JSON.stringify({ dibuat: dibuat.length, dilewati: dilewati.length, role }), clientIp(c)).run();
  return c.json({ ok: true, dibuat, dilewati });
}

// BULK RESET — acak ulang sandi SEMUA akun tertaut karyawan dalam scope.
// Body {cabang?}. Master_admin & diri sendiri dikecualikan. Kembalikan sekali.
app.post("/api/employees/bulk-reset", auth, requirePerm("users.kelola"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  let cabFilter = typeof b.cabang === "string" && b.cabang ? b.cabang : null;
  if (u.role === "hr_cabang") {
    const milikId = await userCabangId(c.env.DB, u);
    const milikKode = milikId
      ? (await c.env.DB.prepare("SELECT kode FROM cabangs WHERE id = ?").bind(milikId).first())?.kode || null
      : null;
    if (cabFilter && milikKode && cabFilter !== milikKode) return c.json({ error: "Bukan cabang Anda" }, 403);
    if (!milikKode && u.unit_id) {
      const { results } = await c.env.DB.prepare(
        `SELECT us.id, us.email, e.nip, e.nama_gelar FROM employees e JOIN users us ON us.id = e.user_id
         WHERE e.unit_id = ? AND us.role != 'master_admin' AND us.id != ?`
      ).bind(u.unit_id, u.id).all();
      return bulkResetSandi(c, u, results);
    }
    if (!milikKode) return c.json({ ok: true, direset: [] });
    cabFilter = milikKode;
  }
  const args = [];
  let where = "us.role != 'master_admin' AND us.id != ?";
  args.push(u.id);
  if (cabFilter) { where += " AND COALESCE(e.cabang_id, un.cabang_id) = (SELECT id FROM cabangs WHERE kode = ?)"; args.push(cabFilter); }
  const { results } = await c.env.DB.prepare(
    `SELECT us.id, us.email, e.nip, e.nama_gelar FROM employees e
     JOIN units un ON un.id = e.unit_id JOIN users us ON us.id = e.user_id
     WHERE ${where} ORDER BY e.id`
  ).bind(...args).all();
  return bulkResetSandi(c, u, results);
});

async function bulkResetSandi(c, u, rows) {
  const direset = [];
  for (const r of rows) {
    const sandi = sandiAcak(12);
    await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(sandi), r.id).run();
    direset.push({ nip: r.nip, nama: r.nama_gelar, email: r.email, sandi });
  }
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (user_id, aksi, tabel, record_id, nilai_baru, ip) VALUES (?,?,?,?,?,?)"
  ).bind(u.id, "user_bulk_reset", "users", 0, JSON.stringify({ direset: direset.length }), clientIp(c)).run();
  return c.json({ ok: true, direset });
}

// TAMBAH KARYAWAN — hanya Admin pusat (izin karyawan.tambah; HR cabang tidak punya).
// NIP otomatis via next_nip(tahun berjalan); status awal draft.
app.post("/api/employees", auth, requirePerm("karyawan.tambah"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const nama = String(b.nama_gelar || b.nama || "").trim();
  const unit_id = Number(b.unit_id) || 0;
  if (!nama) return c.json({ error: "Nama karyawan wajib diisi" }, 400);
  if (!unit_id) return c.json({ error: "Unit wajib dipilih" }, 400);
  const unit = await c.env.DB.prepare("SELECT id, cabang_id FROM units WHERE id = ?").bind(unit_id).first();
  if (!unit) return c.json({ error: "Unit tidak dikenal" }, 400);
  const email = b.email ? String(b.email).trim().toLowerCase() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "Format email tidak valid" }, 400);
  const no_hp = b.no_hp ? String(b.no_hp).trim() : null;
  if (no_hp && !/^628[0-9]{8,14}$/.test(no_hp)) return c.json({ error: "No HP harus format 628… (tanpa +/spasi)" }, 400);
  let nip = b.nip ? String(b.nip).trim() : null;
  if (nip && !/^[0-9]{6,18}$/.test(nip)) return c.json({ error: "NIP harus 6–18 digit angka" }, 400);
  // Kolom biodata tambahan (dari template SDM; NIK/norek tersimpan tapi tak pernah dikirim ke klien)
  const nik = b.nik_ktp ? String(b.nik_ktp).trim() : null;
  if (nik && !/^[0-9]{16}$/.test(nik)) return c.json({ error: "NIK harus 16 digit" }, 400);
  const tgl_lahir = b.tgl_lahir ? String(b.tgl_lahir).trim() : null;
  if (tgl_lahir && !/^\d{4}-\d{2}-\d{2}$/.test(tgl_lahir)) return c.json({ error: "Tanggal lahir harus YYYY-MM-DD" }, 400);
  const kawin = b.status_kawin ? String(b.status_kawin).trim() : null;
  if (kawin && !["Lajang", "Menikah", "Janda", "Duda"].includes(kawin)) return c.json({ error: "Status kawin tidak dikenal" }, 400);
  const gender = b.gender ? String(b.gender).trim() : null;
  if (gender && !["Pria", "Perempuan"].includes(gender)) return c.json({ error: "Gender harus Pria/Perempuan" }, 400);
  const num = (v) => (v == null || v === "" ? null : Number(v));
  const tinggi = num(b.tinggi_cm), berat = num(b.berat_kg), gaji = num(b.gaji_diajukan);
  if ((tinggi != null && !(tinggi > 0 && tinggi < 300)) || (berat != null && !(berat > 0 && berat < 500)))
    return c.json({ error: "Tinggi/berat tidak wajar" }, 400);
  if (gaji != null && !(gaji >= 0)) return c.json({ error: "Gaji diajukan tidak valid" }, 400);
  const norek = (v) => {
    const s = v ? String(v).trim() : null;
    if (s && !/^[0-9]{9,20}$/.test(s)) throw new Error("No rekening harus 9–20 digit");
    return s;
  };
  let norek_utama, norek_lain;
  try {
    norek_utama = norek(b.norek_utama);
    norek_lain = norek(b.norek_lain);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
  const bank = (v) => (v ? String(v).trim().slice(0, 30) : null);
  // Pendidikan/pengalaman opsional — VALIDASI DI SINI (sebelum INSERT employees),
  // supaya gagal validasi tak pernah menyisakan baris employees tanpa pendidikan/pengalaman
  // (tak ada transaksi lintas tabel di adapter D1-compatible ini; lihat adapter/pg.js).
  let ipk = null;
  if (b.pendidikan && (b.pendidikan.perguruan_tinggi || b.pendidikan.prodi)) {
    ipk = b.pendidikan.ipk == null || b.pendidikan.ipk === "" ? null : Number(b.pendidikan.ipk);
    if (ipk != null && !(ipk >= 0 && ipk <= 4)) return c.json({ error: "IPK harus 0–4" }, 400);
  }
  const pengalamanRows = Array.isArray(b.pengalaman)
    ? b.pengalaman.filter((p) => p && (p.deskripsi || p.salary != null)).slice(0, 3)
    : [];
  for (const p of pengalamanRows) {
    const sal = p.salary == null || p.salary === "" ? null : Number(p.salary);
    if (sal != null && !(sal >= 0)) return c.json({ error: `Nominal pengalaman tidak valid: "${p.deskripsi ?? ""}"` }, 400);
    p._salaryValidated = sal;
  }
  // Atasan langsung opsional (dipilih dari dropdown per cabang di form).
  const atasan_id = b.atasan_id == null || b.atasan_id === "" ? null : Number(b.atasan_id);
  if (atasan_id != null && !(atasan_id > 0))
    return c.json({ error: "Atasan tidak dikenal" }, 400);
  if (atasan_id != null) {
    const at = await c.env.DB.prepare("SELECT id FROM employees WHERE id = ?").bind(atasan_id).first();
    if (!at) return c.json({ error: "Atasan tidak ditemukan" }, 400);
  }
  // Keterangan cabang bebas — hanya disimpan bila unit dari cabang LAINNYA.
  let cabang_lainnya = null;
  if (unit.cabang_id != null) {
    const cb = await c.env.DB.prepare("SELECT kode FROM cabangs WHERE id = ?").bind(unit.cabang_id).first();
    if (cb?.kode === "LAIN" && typeof b.cabang_lainnya === "string" && b.cabang_lainnya.trim())
      cabang_lainnya = b.cabang_lainnya.trim().slice(0, 120);
  }
  try {
    if (!nip) {
      const tahun = String(new Date().getFullYear()).slice(2);
      const r = await c.env.DB.prepare("SELECT next_nip(?) AS nip").bind(tahun).first();
      nip = r.nip;
    }
    const ins = await c.env.DB.prepare(
      `INSERT INTO employees (unit_id, cabang_id, nip, nama, nama_gelar, email, no_hp, posisi_diajukan, mapel,
        nik_ktp, alamat, tempat_lahir, tgl_lahir, status_kawin, tinggi_cm, berat_kg, transport,
        gaji_diajukan, bank_utama, norek_utama, bank_lain, norek_lain, status_aktivasi,
        atasan_id, cabang_lainnya, gender)
       VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?, 'draft',
        ?, ?, ?) RETURNING id, nip`
    ).bind(unit_id, unit.cabang_id ?? null, nip, nama, nama,
      email || null, no_hp || null, b.posisi_diajukan || null, b.mapel || null,
      nik || null, b.alamat || null, b.tempat_lahir || null, tgl_lahir || null, kawin || null,
      tinggi, berat, b.transport || null,
      gaji, bank(b.bank_utama), norek_utama || null, bank(b.bank_lain), norek_lain || null,
      atasan_id, cabang_lainnya, gender).first();
    // CV: link eksplisit diutamakan; arsip upload (0-*.pdf) di-rename ke ID baru.
    let cv_url = null;
    if (typeof b.cv_url === "string" && /^https?:\/\/.{5,500}$/.test(b.cv_url.trim())) cv_url = b.cv_url.trim();
    if (typeof b.arsip_nama === "string" && /^0-\d+-[a-z0-9]+\.pdf$/.test(b.arsip_nama)) {
      try {
        const baru = `${ins.id}-${b.arsip_nama.slice(2)}`;
        await rename(join(ARSIP_DIR, b.arsip_nama), join(ARSIP_DIR, baru));
        if (!cv_url) cv_url = `/api/arsip/${baru}`;
      } catch { /* arsip hilang — lanjut tanpa CV */ }
    }
    if (cv_url) {
      await c.env.DB.prepare("UPDATE employees SET cv_url=? WHERE id=?").bind(cv_url, ins.id).run();
    }
    // Pendidikan S1 (opsional, satu baris; sudah divalidasi di atas)
    if (b.pendidikan && (b.pendidikan.perguruan_tinggi || b.pendidikan.prodi)) {
      await c.env.DB.prepare(
        "INSERT INTO pendidikan (employee_id, jenjang, perguruan_tinggi, prodi, ipk) VALUES (?,?,?,?,?)"
      ).bind(ins.id, "S1", b.pendidikan.perguruan_tinggi || null, b.pendidikan.prodi || null, ipk).run();
    }
    // Pengalaman (opsional, maks 3 baris; sudah divalidasi di atas)
    let ur = 0;
    for (const p of pengalamanRows) {
      ur += 1;
      await c.env.DB.prepare(
        "INSERT INTO pengalaman (employee_id, urutan, deskripsi, salary) VALUES (?,?,?,?)"
      ).bind(ins.id, ur, p.deskripsi || null, p._salaryValidated).run();
    }
    await c.env.DB.prepare(
      "INSERT INTO audit_logs (user_id, aksi, tabel, record_id, nilai_lama, nilai_baru, ip) VALUES (?,?,?,?,?,?,?)"
    ).bind(u.id, "karyawan.tambah", "employees", ins.id, null,
      JSON.stringify({ nip, nama, unit_id }), clientIp(c)).run();
    return c.json({ ok: true, id: ins.id, nip }, 201);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/duplicate|unique|UNIQUE/i.test(msg)) return c.json({ error: "NIP/email sudah terdaftar" }, 409);
    return c.json({ error: "Gagal menambah karyawan" }, 500);
  }
});

// PARSE PDF SDM — upload template "Arsip SDM" → draft JSON siap verifikasi.
// Butuh karyawan.tambah (Admin pusat). AI opsional via AI_API_URL (OpenAI-compatible,
// cth. Ollama http://host:11434/v1); tanpa itu murni regex deterministik.
const PARSE_MAKS = Number(process.env.PARSE_MAKS_BYTE || 10 * 1024 * 1024);
app.post("/api/employees/parse", auth, requirePerm("karyawan.tambah"), async (c) => {
  if (!rateOk(`parse:${clientIp(c)}`, 20, 60 * 1000))
    return c.json({ error: "Terlalu banyak unggahan. Coba lagi 1 menit." }, 429);
  const fd = await c.req.formData().catch(() => null);
  if (!fd) return c.json({ error: "Form multipart wajib" }, 400);
  const file = fd.get("file");
  if (!(file instanceof Blob) || !file.size) return c.json({ error: "file PDF wajib" }, 400);
  if (file.size > PARSE_MAKS) return c.json({ error: `Ukuran maks ${Math.round(PARSE_MAKS / 1048576)} MB` }, 400);
  const buf = Buffer.from(await file.arrayBuffer());
  if (!buf.slice(0, 5).toString().startsWith("%PDF")) return c.json({ error: "File harus PDF valid" }, 400);
  let teks = "";
  try {
    const parser = new PDFParse({ data: buf });
    const r = await parser.getText();
    teks = r.text || "";
    await parser.destroy().catch(() => {});
  } catch {
    return c.json({ error: "Gagal membaca PDF (file rusak / hasil scan gambar?)" }, 422);
  }
  if (!teks.trim()) return c.json({ error: "PDF tidak mengandung teks (hasil scan tanpa OCR?)" }, 422);
  const hasil = parseSDM(teks.slice(0, 200000));
  let ai_dipakai = false;
  if (process.env.AI_API_URL) {
    const r = await aiLengkapi(teks, hasil.data, {
      url: process.env.AI_API_URL, key: process.env.AI_API_KEY, model: process.env.AI_MODEL,
    });
    hasil.data = r.data;
    ai_dipakai = r.ai_dipakai;
  }
  // Simpan sumber sebagai arsip 0-* ; di-rename ke ID karyawan saat Simpan.
  const rnd = Math.random().toString(36).slice(2, 8);
  const arsip_nama = `0-${Date.now()}-${rnd}.pdf`;
  await mkdir(ARSIP_DIR, { recursive: true });
  await writeFile(join(ARSIP_DIR, arsip_nama), buf);
  return c.json({
    ok: true, arsip_nama,
    data: hasil.data, confidence: hasil.confidence, warnings: hasil.warnings, ai_dipakai,
  });
});

// AKTIVASI 3-TAHAP — finance → Doni → Kemal. Tak balance = 422. Lompat tahap = 422.
app.post("/api/employees/:id/activate", auth, async (c) => {
  const u = c.get("user");
  const id = c.req.param("id");
  const b = await c.req.json().catch(() => ({}));
  const next = b.status_aktivasi || "diajukan_finance";

  const aturan = TRANSISI[next];
  if (!aturan) return c.json({ error: `Status tujuan tidak dikenal: ${next}` }, 400);
  if (!punya(u, aturan.izin))
    return c.json({ error: `Izin kurang: butuh "${aturan.izin}"` }, 403);

  const chk = await employeeInScope(c.env.DB, u, id);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);

  const cur = await c.env.DB.prepare("SELECT status_aktivasi FROM employees WHERE id = ?").bind(id).first();
  if (!cur) return c.json({ error: "Tidak ditemukan" }, 404);
  if (!aturan.dari.includes(cur.status_aktivasi))
    return c.json({ error: `Tidak bisa ${cur.status_aktivasi} → ${next}` }, 422);

  const salah = cekBalance(b);
  if (salah) return c.json({ error: `DITOLAK: ${salah}` }, 422);

  const n = (x) => Number(x) || 0;
  const jadiAktif = next === "aktif" ? 1 : 0;
  await c.env.DB.prepare(
    `UPDATE employees SET thp_kotor=?, thp_bersih=?, total_tk_thr=?, tk=?, thr_bulan=?,
       konfirmasi=?, cv_url=?, kesehatan_url=?,
       tmt_aktif=?, mode_thp=?, status_aktivasi=?, aktif=?,
       diaktifkan_oleh=CASE WHEN ?='aktif' THEN ? ELSE diaktifkan_oleh END,
       diaktifkan_at=CASE WHEN ?='aktif' THEN now() ELSE diaktifkan_at END
     WHERE id=?`
  ).bind(
    n(b.thp_kotor), n(b.thp_bersih), n(b.total_tk_thr), n(b.tk), n(b.thr_bulan),
    b.konfirmasi || null, b.cv_url || null, b.kesehatan_url || null,
    b.tmt_aktif || null, b.mode_thp || null, next, jadiAktif,
    next, u.id, next, id
  ).run();

  await c.env.DB.prepare(
    "INSERT INTO aktivasi_logs (employee_id, dari_status, ke_status, oleh_user_id, catatan) VALUES (?,?,?,?,?)"
  ).bind(id, cur.status_aktivasi, next, u.id, b.catatan || b.konfirmasi || null).run();
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (user_id, aksi, tabel, record_id, nilai_lama, nilai_baru, ip) VALUES (?,?,?,?,?,?,?)"
  ).bind(u.id, "activate:" + next, "employees", id,
    JSON.stringify({ status: cur.status_aktivasi }),
    JSON.stringify({ status: next, thp_bersih: n(b.thp_bersih) }),
    clientIp(c)).run();

  return c.json({ ok: true, dari: cur.status_aktivasi, ke: next });
});

// DAFTAR PAYROLL per periode — scope cabang; pegawai hanya miliknya (tanpa rincian potongan).
app.get("/api/payroll", auth, async (c) => {
  const u = c.get("user");
  const periode = c.req.query("periode") || "2026-08";
  let q = `SELECT p.*, e.nip, e.nama_gelar AS nama, e.unit_id, un.nama AS unit, pp.periode, pp.status
           FROM payrolls p
           JOIN payroll_periods pp ON pp.id = p.period_id
           JOIN employees e ON e.id = p.employee_id
           JOIN units un ON un.id = e.unit_id
           WHERE pp.periode = ?`;
  const args = [periode];
  if (u.role === "hr_cabang") {
    const cab = await userCabangId(c.env.DB, u);
    if (cab) { q += " AND COALESCE(e.cabang_id, un.cabang_id) = ?"; args.push(cab); }
    else { q += " AND e.unit_id = ?"; args.push(u.unit_id); }
  } else if (u.role === "pegawai") { q += " AND e.user_id = ?"; args.push(u.id); }
  const { results } = await c.env.DB.prepare(q).bind(...args).all();
  if (u.role === "pegawai") {
    const hidden = ["pot_thr", "pot_bpjs_tk", "deposit_itba", "punishment", "pinjaman", "total_potongan"];
    for (const r of results) for (const k of hidden) delete r[k];
  }
  return c.json(results);
});

// KUNCI PERIODE — butuh payroll.kunci
app.post("/api/payroll/lock", auth, requirePerm("payroll.kunci"), async (c) => {
  const { period_id } = await c.req.json().catch(() => ({}));
  const u = c.get("user");
  await c.env.DB.prepare(
    "UPDATE payroll_periods SET status='final', locked_by=?, locked_at=now() WHERE id=?"
  ).bind(u.id, period_id).run();
  const per = await c.env.DB.prepare("SELECT periode FROM payroll_periods WHERE id = ?").bind(period_id).first();
  const { results: pem } = await c.env.DB.prepare(
    "SELECT DISTINCT e.user_id FROM payrolls p JOIN employees e ON e.id = p.employee_id WHERE p.period_id = ? AND e.user_id IS NOT NULL"
  ).bind(period_id).all();
  for (const r of pem)
    await kirimNotif(c.env.DB, r.user_id, `Slip gaji ${per?.periode || ""} terbit`, "Periode payroll telah dikunci. Slip gaji Anda sudah dapat dilihat.");
  return c.json({ ok: true });
});

// AUDIT LOG — butuh audit.lihat
app.get("/api/audit", auth, requirePerm("audit.lihat"), async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM audit_logs ORDER BY waktu DESC LIMIT 100"
  ).all();
  return c.json(results);
});

// JEJAK AKTIVASI per pegawai — HR cabang (cabangnya) & Master Admin
app.get("/api/employees/:id/aktivasi-log", auth, async (c) => {
  const u = c.get("user");
  if (u.role === "pegawai") return c.json({ error: "Akses ditolak" }, 403);
  const chk = await employeeInScope(c.env.DB, u, c.req.param("id"));
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM aktivasi_logs WHERE employee_id = ? ORDER BY waktu"
  ).bind(c.req.param("id")).all();
  return c.json(results);
});

// ============================================================
//  ABSENSI & CUTI (Fase 2 pilot)
// ============================================================
async function empIdOfUser(DB, user) {
  const r = await DB.prepare("SELECT id FROM employees WHERE user_id = ?").bind(user.id).first();
  return r ? r.id : null;
}
async function userIdOfEmployee(DB, empId) {
  const r = await DB.prepare("SELECT user_id FROM employees WHERE id = ?").bind(empId).first();
  return r ? r.user_id : null;
}
async function kirimNotif(DB, userId, judul, isi) {
  if (!userId) return;
  await DB.prepare("INSERT INTO notifikasi (user_id, judul, isi) VALUES (?,?,?)").bind(userId, judul, isi || null).run();
}
async function getPengaturan(DB) {
  const { results } = await DB.prepare("SELECT kunci, nilai FROM pengaturan").all();
  return Object.fromEntries(results.map((r) => [r.kunci, r.nilai]));
}
const menitDariJam = (s) => {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
};
// Menit waktu WIB dari ISO instant (untuk cek terlambat/pulang cepat)
function menitWIB(iso) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const [h, m] = p.split(":").map(Number);
  return h * 60 + m;
}
// Jarak meter antar koordinat (haversine) — validasi radius presensi GPS
function jarakMeter(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1)) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1)) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// Atasan langsung (via employees.atasan_id → user tertaut) boleh menyetujui
// pengajuan bawahan langsung — tanpa harus memegang izin *.setujui.
async function isAtasan(DB, user, empId) {
  const r = await DB.prepare("SELECT atasan_id FROM employees WHERE id = ?").bind(empId).first();
  if (!r?.atasan_id) return false;
  const a = await DB.prepare("SELECT user_id FROM employees WHERE id = ?").bind(r.atasan_id).first();
  return !!a?.user_id && a.user_id === user.id;
}
async function bisaSetujui(DB, u, empId, permSetujui) {
  if (punya(u, permSetujui)) return true;
  return isAtasan(DB, u, empId);
}
// Filter scope cabang untuk query daftar karyawan (mirip pola cuti)
async function scopeKaryawan(DB, u, alias = "e") {
  if (u.role !== "hr_cabang") return { join: "", where: "", args: [] };
  const cab = await userCabangId(DB, u);
  if (cab) return { join: ` JOIN units un ON un.id = ${alias}.unit_id`, where: `COALESCE(${alias}.cabang_id, un.cabang_id) = ?`, args: [cab] };
  return { join: "", where: `${alias}.unit_id = ?`, args: [u.unit_id] };
}
const TGL_RE = /^\d{4}-\d{2}-\d{2}$/;
// Tanggal "hari ini" acuan WIB (sekolah di Indonesia) — bukan UTC,
// agar presensi lewat tengah malam tidak tercatat di tanggal kemarin.
const hariIniWIB = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ABSENSI_STATUS = ["hadir", "izin", "sakit", "cuti", "alpa", "dinas"];

// Daftar hadir tanggal tertentu (default hari ini) — scope cabang
app.get("/api/absensi", auth, requirePerm("absensi.kelola"), async (c) => {
  const u = c.get("user");
  const tanggal = c.req.query("tanggal") || new Date().toISOString().slice(0, 10);
  if (!TGL_RE.test(tanggal)) return c.json({ error: "Format tanggal YYYY-MM-DD" }, 400);
  let q = `SELECT e.id AS employee_id, e.nip, e.nama_gelar, a.status, a.keterangan
           FROM employees e LEFT JOIN absensi a ON a.employee_id = e.id AND a.tanggal = ?`;
  const args = [tanggal];
  if (u.role === "hr_cabang") {
    const cab = await userCabangId(c.env.DB, u);
    if (cab) { q += " WHERE COALESCE(e.cabang_id, un.cabang_id) = ?"; }
    else { q += " WHERE e.unit_id = ?"; }
    // butuh join units untuk scope
    q = q.replace("FROM employees e LEFT JOIN", "FROM employees e JOIN units un ON un.id = e.unit_id LEFT JOIN");
    args.push(cab ?? u.unit_id);
  }
  q += " ORDER BY e.nama_gelar";
  const { results } = await c.env.DB.prepare(q).bind(...args).all();
  return c.json({ tanggal, rows: results });
});

// Catat/ubah hadir satu karyawan
app.post("/api/absensi", auth, requirePerm("absensi.kelola"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const { employee_id, tanggal, status, keterangan } = b;
  if (!employee_id || !TGL_RE.test(String(tanggal || ""))) return c.json({ error: "employee_id + tanggal YYYY-MM-DD wajib" }, 400);
  if (!ABSENSI_STATUS.includes(status)) return c.json({ error: `Status harus: ${ABSENSI_STATUS.join(", ")}` }, 400);
  const chk = await employeeInScope(c.env.DB, u, employee_id);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  await c.env.DB.prepare(
    `INSERT INTO absensi (employee_id, tanggal, status, keterangan) VALUES (?,?,?,?)
     ON CONFLICT (employee_id, tanggal) DO UPDATE SET status=EXCLUDED.status, keterangan=EXCLUDED.keterangan`
  ).bind(employee_id, tanggal, status, keterangan || null).run();
  return c.json({ ok: true });
});

// Presensi mandiri — karyawan mencatat check-in/out miliknya sendiri (hari ini saja).
// Pegawai tanpa employee tertaut (mis. admin) mendapat 400 yang jelas.
app.get("/api/presensi-saya", auth, requirePerm("presensi.mandiri"), async (c) => {
  const u = c.get("user");
  const empId = await empIdOfUser(c.env.DB, u);
  if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
  const hariIni = hariIniWIB();
  const hari = await c.env.DB.prepare(
    "SELECT tanggal, status, check_in, check_out, keterangan, lat_masuk, lng_masuk, lat_pulang, lng_pulang, (foto_masuk IS NOT NULL) AS foto_masuk_ada, (foto_pulang IS NOT NULL) AS foto_pulang_ada FROM absensi WHERE employee_id = ? AND tanggal = ?"
  ).bind(empId, hariIni).first();
  const { results } = await c.env.DB.prepare(
    "SELECT tanggal, status, check_in, check_out, lat_masuk, lng_masuk, lat_pulang, lng_pulang FROM absensi WHERE employee_id = ? ORDER BY tanggal DESC LIMIT 30"
  ).bind(empId).all();
  return c.json({ tanggal: hariIni, hari_ini: hari, riwayat: results });
});

app.post("/api/presensi-saya", auth, requirePerm("presensi.mandiri"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  if (!["masuk", "pulang"].includes(b.aksi)) return c.json({ error: "aksi harus masuk/pulang" }, 400);
  const empId = await empIdOfUser(c.env.DB, u);
  if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
  // GPS + selfie wajib (sesuai kebijakan pilot AW3)
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return c.json({ error: "Lokasi GPS wajib — aktifkan izin lokasi di browser" }, 400);
  if (typeof b.foto !== "string" || !b.foto.startsWith("data:image/jpeg"))
    return c.json({ error: "Foto selfie wajib" }, 400);
  if (b.foto.length > 1000000) return c.json({ error: "Foto terlalu besar (maks ~700 KB)" }, 400);
  const set = await getPengaturan(c.env.DB);
  const klat = parseFloat(set.kantor_lat ?? ""), klng = parseFloat(set.kantor_lng ?? "");
  const rad = parseInt(set.radius_meter ?? "0", 10) || 0;
  let jarak = null;
  if (Number.isFinite(klat) && Number.isFinite(klng) && rad > 0) {
    jarak = Math.round(jarakMeter(klat, klng, lat, lng));
    if (jarak > rad) return c.json({ error: `Di luar radius kantor (${jarak} m dari titik absen, batas ${rad} m)` }, 422);
  }
  const hariIni = hariIniWIB();
  const row = await c.env.DB.prepare(
    "SELECT status, check_in, check_out FROM absensi WHERE employee_id = ? AND tanggal = ?"
  ).bind(empId, hariIni).first();
  if (b.aksi === "masuk") {
    if (row?.check_in) return c.json({ error: "Sudah check-in hari ini" }, 422);
    if (row) {
      // Baris sudah dibuat HR (mis. status izin/sakit) — pertahankan statusnya, catat jamnya saja.
      await c.env.DB.prepare("UPDATE absensi SET check_in = now(), lat_masuk = ?, lng_masuk = ?, foto_masuk = ? WHERE employee_id = ? AND tanggal = ?").bind(lat, lng, b.foto, empId, hariIni).run();
    } else {
      await c.env.DB.prepare(
        "INSERT INTO absensi (employee_id, tanggal, status, check_in, lat_masuk, lng_masuk, foto_masuk) VALUES (?,?, 'hadir', now(), ?, ?, ?)"
      ).bind(empId, hariIni, lat, lng, b.foto).run();
    }
    return c.json({ ok: true, aksi: "masuk", jarak_meter: jarak });
  }
  if (!row?.check_in) return c.json({ error: "Belum check-in hari ini" }, 422);
  if (row.check_out) return c.json({ error: "Sudah check-out hari ini" }, 422);
  await c.env.DB.prepare("UPDATE absensi SET check_out = now(), lat_pulang = ?, lng_pulang = ?, foto_pulang = ? WHERE employee_id = ? AND tanggal = ?").bind(lat, lng, b.foto, empId, hariIni).run();
  return c.json({ ok: true, aksi: "pulang", jarak_meter: jarak });
});

// ---------- Pengaturan (master_admin) ----------
const PENGATURAN_BOLEH = ["jam_masuk_normal", "jam_pulang_normal", "toleransi_telat_menit", "kantor_lat", "kantor_lng", "radius_meter", "jatah_cuti_tahunan",
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_SECURE", "WA_URL", "WA_TOKEN"];
const PENGATURAN_RAHASIA = ["SMTP_PASS", "WA_TOKEN"];
app.get("/api/pengaturan", auth, requirePerm("pengaturan.kelola"), async (c) => {
  const semua = await getPengaturan(c.env.DB);
  // Samarkan rahasia (*** bila terisi) agar tak tampil di UI
  for (const k of PENGATURAN_RAHASIA) if (semua[k]) semua[k] = "***";
  return c.json(semua);
});
app.put("/api/pengaturan", auth, requirePerm("pengaturan.kelola"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const nilai = b.nilai || {};
  for (const [k, v] of Object.entries(nilai)) {
    if (!PENGATURAN_BOLEH.includes(k)) return c.json({ error: `Kunci tak dikenal: ${k}` }, 400);
    if (PENGATURAN_RAHASIA.includes(k) && v === "***") continue; // pertahankan nilai lama
    if (["jam_masuk_normal", "jam_pulang_normal"].includes(k) && menitDariJam(v) === null)
      return c.json({ error: `${k} harus HH:MM` }, 400);
    if (["toleransi_telat_menit", "radius_meter", "jatah_cuti_tahunan", "SMTP_PORT"].includes(k) && !/^\d+$/.test(String(v)))
      return c.json({ error: `${k} harus angka` }, 400);
    if (k === "SMTP_SECURE" && !["0", "1"].includes(String(v))) return c.json({ error: "SMTP_SECURE harus 0/1" }, 400);
    if (["kantor_lat", "kantor_lng"].includes(k) && !/^-?\d+(\.\d+)?$/.test(String(v)))
      return c.json({ error: `${k} harus koordinat desimal` }, 400);
    await c.env.DB.prepare("UPDATE pengaturan SET nilai = ? WHERE kunci = ?").bind(String(v), k).run();
  }
  return c.json({ ok: true });
});

// ---------- Rekap presensi (HR, scope cabang): bulanan, mingguan, rentang ----------
// ?bulan=YYYY-MM (default bulan berjalan) atau ?dari=YYYY-MM-DD&sampai=YYYY-MM-DD.
app.get("/api/rekap-presensi", auth, requirePerm("laporan.lihat", "absensi.kelola"), async (c) => {
  const u = c.get("user");
  const dari = c.req.query("dari"), sampai = c.req.query("sampai");
  let awal, akhir, label;
  if (dari || sampai) {
    if (!TGL_RE.test(String(dari || "")) || !TGL_RE.test(String(sampai || "")))
      return c.json({ error: "dari + sampai (YYYY-MM-DD) wajib" }, 400);
    if (sampai < dari) return c.json({ error: "sampai sebelum dari" }, 400);
    awal = dari; akhir = sampai; label = `${dari} s.d. ${sampai}`;
  } else {
    const bulan = c.req.query("bulan") || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(bulan)) return c.json({ error: "Format bulan YYYY-MM" }, 400);
    const [Y, M] = bulan.split("-").map(Number);
    awal = `${bulan}-01`;
    akhir = new Date(Date.UTC(Y, M, 0)).toISOString().slice(0, 10);
    label = bulan;
  }
  const set = await getPengaturan(c.env.DB);
  const batasMasuk = (menitDariJam(set.jam_masuk_normal) ?? 7 * 60) + (parseInt(set.toleransi_telat_menit ?? "15", 10) || 0);
  const batasPulang = menitDariJam(set.jam_pulang_normal) ?? 16 * 60;
  const sc = await scopeKaryawan(c.env.DB, u);
  const { results: kary } = await c.env.DB.prepare(
    `SELECT e.id AS employee_id, e.nip, e.nama_gelar FROM employees e${sc.join}${sc.where ? " WHERE " + sc.where : ""} ORDER BY e.nama_gelar`
  ).bind(...sc.args).all();
  const ids = kary.map((k) => k.employee_id);
  let rows = [];
  const byLembur = {};
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const { results } = await c.env.DB.prepare(
      `SELECT employee_id, tanggal, status, check_in, check_out FROM absensi WHERE employee_id IN (${ph}) AND tanggal BETWEEN ? AND ?`
    ).bind(...ids, awal, akhir).all();
    rows = results;
    // Lembur disetujui pada rentang yang sama → hitung kali & total jam
    const { results: lem } = await c.env.DB.prepare(
      `SELECT employee_id, jam_mulai, jam_selesai FROM lembur WHERE employee_id IN (${ph}) AND status = 'disetujui' AND tanggal BETWEEN ? AND ?`
    ).bind(...ids, awal, akhir).all();
    for (const l of lem) {
      const b = (byLembur[l.employee_id] ??= { kali: 0, menit: 0 });
      b.kali++;
      const [m1, m2] = [l.jam_mulai, l.jam_selesai].map((t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; });
      if (m2 > m1) b.menit += m2 - m1;
    }
  }
  const byEmp = Object.fromEntries(ids.map((id) => [id, []]));
  for (const r of rows) (byEmp[r.employee_id] ??= []).push(r);
  // Hari kerja (Senin–Jumat) pada rentang, acuan WIB
  const hariKerja = [];
  for (let t = new Date(awal + "T00:00:00Z"); t.toISOString().slice(0, 10) <= akhir; t = new Date(t.getTime() + 86400000)) {
    const wib = new Date(t.getTime() + 7 * 3600 * 1000);
    if ([0, 6].includes(wib.getUTCDay())) continue;
    hariKerja.push(t.toISOString().slice(0, 10));
  }
  const ringkasan = kary.map((k) => {
    const r = { employee_id: k.employee_id, nip: k.nip, nama_gelar: k.nama_gelar, hadir: 0, terlambat: 0, pulang_cepat: 0, izin: 0, sakit: 0, cuti: 0, alpa: 0, dinas: 0, tanpa_keterangan: 0, tidak_hadir: 0, lembur_kali: 0, lembur_jam: 0 };
    const tglAda = new Set();
    for (const a of byEmp[k.employee_id] || []) {
      tglAda.add(a.tanggal);
      if (a.status && r[a.status] !== undefined) r[a.status]++;
      if (a.check_in && menitWIB(a.check_in) > batasMasuk) r.terlambat++;
      if (a.check_in && a.check_out && menitWIB(a.check_out) < batasPulang) r.pulang_cepat++;
    }
    for (const h of hariKerja) if (h <= hariIniWIB() && !tglAda.has(h)) r.tanpa_keterangan++;
    r.tidak_hadir = r.alpa + r.tanpa_keterangan;
    const lb = byLembur[k.employee_id];
    if (lb) { r.lembur_kali = lb.kali; r.lembur_jam = Math.round((lb.menit / 60) * 10) / 10; }
    return r;
  });
  return c.json({ bulan: label, dari: awal, sampai: akhir, batas: { masuk: set.jam_masuk_normal, toleransi: set.toleransi_telat_menit, pulang: set.jam_pulang_normal }, hari_kerja: hariKerja.length, ringkasan, detail: rows });
});

// ---------- Saldo cuti ----------
function hariCutiDiTahun(mulai, selesai, tahun) {
  const a = new Date(Math.max(new Date(mulai).getTime(), new Date(`${tahun}-01-01`).getTime()));
  const b = new Date(Math.min(new Date(selesai).getTime(), new Date(`${tahun}-12-31`).getTime()));
  if (b < a) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}
async function saldoSatu(DB, empId, tahun, jatahDefault) {
  const s = await DB.prepare("SELECT jatah FROM cuti_saldo WHERE employee_id = ? AND tahun = ?").bind(empId, tahun).first();
  const jatah = s ? s.jatah : jatahDefault;
  const { results } = await DB.prepare(
    "SELECT tgl_mulai, tgl_selesai FROM cuti WHERE employee_id = ? AND status = 'disetujui' AND jenis = 'tahunan'"
  ).bind(empId).all();
  const terpakai = results.reduce((n, r) => n + hariCutiDiTahun(r.tgl_mulai, r.tgl_selesai, tahun), 0);
  return { employee_id: empId, tahun, jatah, terpakai, sisa: jatah - terpakai };
}
app.get("/api/cuti-saldo", auth, async (c) => {
  const u = c.get("user");
  const tahun = parseInt(c.req.query("tahun") || String(new Date().getFullYear()), 10);
  const set = await getPengaturan(c.env.DB);
  const def = parseInt(set.jatah_cuti_tahunan ?? "12", 10) || 0;
  if (u.role === "pegawai") {
    if (!punya(u, "cuti.ajukan")) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
    const empId = await empIdOfUser(c.env.DB, u);
    if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
    return c.json(await saldoSatu(c.env.DB, empId, tahun, def));
  }
  if (!punya(u, "cuti.setujui")) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
  const sc = await scopeKaryawan(c.env.DB, u);
  const { results: kary } = await c.env.DB.prepare(
    `SELECT e.id FROM employees e${sc.join}${sc.where ? " WHERE " + sc.where : ""}`
  ).bind(...sc.args).all();
  const out = [];
  for (const k of kary) out.push(await saldoSatu(c.env.DB, k.id, tahun, def));
  return c.json(out);
});
app.put("/api/cuti-saldo/:employee_id", auth, requirePerm("cuti.setujui"), async (c) => {
  const u = c.get("user");
  const empId = Number(c.req.param("employee_id"));
  const b = await c.req.json().catch(() => ({}));
  const tahun = Number(b.tahun) || new Date().getFullYear();
  const jatah = Number(b.jatah);
  if (!Number.isInteger(jatah) || jatah < 0) return c.json({ error: "jatah harus angka ≥ 0" }, 400);
  const chk = await employeeInScope(c.env.DB, u, empId);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  await c.env.DB.prepare(
    `INSERT INTO cuti_saldo (employee_id, tahun, jatah) VALUES (?,?,?)
     ON CONFLICT (employee_id, tahun) DO UPDATE SET jatah = EXCLUDED.jatah`
  ).bind(empId, tahun, jatah).run();
  return c.json({ ok: true });
});

// ---------- Profil saya (pegawai: seluruh data miliknya, KECUALI NIK KTP) ----------
// NIK KTP tidak pernah dikirim ke klien (kebijakan sensitif); rekening milik
// sendiri ditampilkan karena dibutuhkan karyawan (cek gaji masuk).
app.get("/api/profil-saya", auth, async (c) => {
  const u = c.get("user");
  const empId = await empIdOfUser(c.env.DB, u);
  if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
  const e = await c.env.DB.prepare(
    `SELECT e.id, e.nip, e.nama_gelar, e.email, e.no_hp, e.alamat, e.tempat_lahir, e.tgl_lahir,
       e.status_kawin, e.posisi_diajukan, e.jabatan, e.mapel, un.nama AS unit,
       COALESCE(cb.nama, un2cab.nama) AS cabang,
       e.gaji_diajukan, e.bank_utama, e.norek_utama, e.bank_lain, e.norek_lain,
       e.thp_bersih, e.tmt_aktif, e.mode_thp, e.status_aktivasi, e.status_kerja,
       e.tgl_masuk, e.atasan_id, e.foto_url, e.kontak_darurat,
       atasan.nama_gelar AS atasan_nama
     FROM employees e JOIN units un ON un.id = e.unit_id
     LEFT JOIN cabangs cb ON cb.id = e.cabang_id
     LEFT JOIN cabangs un2cab ON un2cab.id = un.cabang_id
     LEFT JOIN employees atasan ON atasan.id = e.atasan_id
     WHERE e.id = ?`
  ).bind(empId).first();
  if (!e) return c.json({ error: "Tidak ditemukan" }, 404);
  return c.json(e);
});

// ---------- Pendidikan & pengalaman kerja (biodata lamaran) ----------
app.get("/api/pendidikan", auth, async (c) => {
  const u = c.get("user");
  let empId = Number(c.req.query("employee_id"));
  if (u.role === "pegawai") {
    empId = await empIdOfUser(c.env.DB, u);
    if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
  } else {
    if (!punya(u, "karyawan.lihat")) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
    if (!empId) return c.json({ error: "employee_id wajib" }, 400);
    const chk = await employeeInScope(c.env.DB, u, empId);
    if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  }
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM pendidikan WHERE employee_id = ? ORDER BY CASE jenjang WHEN 'SMA' THEN 0 WHEN 'D1' THEN 1 WHEN 'D2' THEN 2 WHEN 'D3' THEN 3 WHEN 'D4' THEN 4 WHEN 'S1' THEN 5 WHEN 'S2' THEN 6 WHEN 'S3' THEN 7 ELSE 8 END"
  ).bind(empId).all();
  return c.json(results);
});

app.get("/api/pengalaman", auth, async (c) => {
  const u = c.get("user");
  let empId = Number(c.req.query("employee_id"));
  if (u.role === "pegawai") {
    empId = await empIdOfUser(c.env.DB, u);
    if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
  } else {
    if (!punya(u, "karyawan.lihat")) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
    if (!empId) return c.json({ error: "employee_id wajib" }, 400);
    const chk = await employeeInScope(c.env.DB, u, empId);
    if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  }
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM pengalaman WHERE employee_id = ? ORDER BY urutan"
  ).bind(empId).all();
  return c.json(results);
});

// ---------- Riwayat jabatan & gaji ----------
app.get("/api/riwayat-jabatan", auth, async (c) => {
  const u = c.get("user");
  let empId = Number(c.req.query("employee_id"));
  if (u.role === "pegawai") {
    empId = await empIdOfUser(c.env.DB, u);
    if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
  } else {
    if (!punya(u, "karyawan.lihat")) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
    if (!empId) return c.json({ error: "employee_id wajib" }, 400);
    const chk = await employeeInScope(c.env.DB, u, empId);
    if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  }
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM riwayat_jabatan WHERE employee_id = ? ORDER BY tanggal DESC, id DESC"
  ).bind(empId).all();
  return c.json(results);
});
app.post("/api/riwayat-jabatan", auth, requirePerm("karyawan.kelola"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const empId = Number(b.employee_id);
  if (!empId) return c.json({ error: "employee_id wajib" }, 400);
  const chk = await employeeInScope(c.env.DB, u, empId);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  const emp = await c.env.DB.prepare(
    "SELECT COALESCE(posisi_diajukan, jabatan) AS jab, gaji_diajukan FROM employees WHERE id = ?"
  ).bind(empId).first();
  const tgl = TGL_RE.test(String(b.tanggal || "")) ? b.tanggal : hariIniWIB();
  await c.env.DB.prepare(
    "INSERT INTO riwayat_jabatan (employee_id, tanggal, jabatan_lama, jabatan_baru, gaji_lama, gaji_baru, keterangan, oleh_user_id) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(empId, tgl, emp?.jab || null, b.jabatan_baru || null, emp?.gaji_diajukan ?? null,
    b.gaji_baru === undefined ? null : b.gaji_baru, b.keterangan || null, u.id).run();
  if (b.terapkan) {
    if (b.jabatan_baru) await c.env.DB.prepare("UPDATE employees SET posisi_diajukan = ? WHERE id = ?").bind(b.jabatan_baru, empId).run();
    if (b.gaji_baru !== undefined) await c.env.DB.prepare("UPDATE employees SET gaji_diajukan = ? WHERE id = ?").bind(b.gaji_baru, empId).run();
  }
  return c.json({ ok: true });
});

// ---------- Data kerja karyawan (atasan, tgl masuk, status kerja, foto) ----------
app.patch("/api/employees/:id/data-kerja", auth, requirePerm("karyawan.kelola"), async (c) => {
  const u = c.get("user");
  const empId = Number(c.req.param("id"));
  const b = await c.req.json().catch(() => ({}));
  const chk = await employeeInScope(c.env.DB, u, empId);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  if (b.status_kerja !== undefined && !["aktif", "cuti", "resign", "nonaktif"].includes(b.status_kerja))
    return c.json({ error: "status_kerja harus aktif/cuti/resign/nonaktif" }, 400);
  if (b.gender !== undefined && b.gender !== null && b.gender !== "" && !["Pria", "Perempuan"].includes(b.gender))
    return c.json({ error: "gender harus Pria/Perempuan" }, 400);
  if (b.tgl_masuk !== undefined && b.tgl_masuk !== null && !TGL_RE.test(String(b.tgl_masuk)))
    return c.json({ error: "tgl_masuk harus YYYY-MM-DD" }, 400);
  if (b.atasan_id !== undefined && b.atasan_id !== null) {
    if (Number(b.atasan_id) === empId) return c.json({ error: "Atasan tidak boleh diri sendiri" }, 400);
    const a = await c.env.DB.prepare("SELECT id FROM employees WHERE id = ?").bind(Number(b.atasan_id)).first();
    if (!a) return c.json({ error: "atasan_id tidak ditemukan" }, 404);
  }
  const kolom = { atasan_id: "atasan_id", tgl_masuk: "tgl_masuk", status_kerja: "status_kerja", foto_url: "foto_url", kontak_darurat: "kontak_darurat", gender: "gender" };
  const sets = [], args = [];
  for (const [k, col] of Object.entries(kolom)) {
    if (b[k] !== undefined) { sets.push(`${col} = ?`); args.push(b[k] === "" ? null : b[k]); }
  }
  if (!sets.length) return c.json({ error: "Tidak ada field yang diubah" }, 400);
  await c.env.DB.prepare(`UPDATE employees SET ${sets.join(", ")} WHERE id = ?`).bind(...args, empId).run();
  return c.json({ ok: true });
});

// ---------- Pengajuan: lembur, reimbursement, surat, perubahan data ----------
// Pola seragam: pegawai mengajukan miliknya (perm *.ajukan), HR/menyetujui scope cabang (perm *.setujui).
const PENGAJUAN = {
  lembur: { tabel: "lembur", ajukan: "lembur.ajukan", setujui: "lembur.setujui", label: "lembur" },
  reimbursement: { tabel: "reimbursement", ajukan: "reimburse.ajukan", setujui: "reimburse.setujui", label: "reimbursement" },
  surat: { tabel: "surat", ajukan: "surat.ajukan", setujui: "surat.setujui", label: "surat kerja" },
  "perubahan-data": { tabel: "perubahan_data", ajukan: "ubahdata.ajukan", setujui: "ubahdata.setujui", label: "perubahan data" },
  "koreksi-presensi": { tabel: "koreksi_presensi", ajukan: "koreksi.ajukan", setujui: "koreksi.setujui", label: "koreksi presensi" },
};
const UBDATA_BOLEH = ["no_hp", "alamat", "kontak_darurat", "status_kawin", "bank_utama", "norek_utama", "bank_lain", "norek_lain"];
const JAM_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function pengajuanRoutes(jenis) {
  const cfg = PENGAJUAN[jenis];
  const base = `/api/${jenis}`;

  app.get(base, auth, async (c) => {
    const u = c.get("user");
    if (u.role === "pegawai") {
      if (!punya(u, cfg.ajukan)) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
      const empId = await empIdOfUser(c.env.DB, u);
      // Karyawan yang juga atasan: sertakan pengajuan bawahan langsungnya
      const { results: bawahan } = await c.env.DB.prepare(
        "SELECT id FROM employees WHERE atasan_id = ?"
      ).bind(empId ?? -1).all();
      const ids = [empId ?? -1, ...bawahan.map((r) => r.id)];
      const { results } = await c.env.DB.prepare(
        `SELECT t.*, e.nip, e.nama_gelar FROM ${cfg.tabel} t JOIN employees e ON e.id = t.employee_id WHERE t.employee_id IN (${ids.map(() => "?").join(",")}) ORDER BY tanggal DESC, id DESC`
      ).bind(...ids).all();
      return c.json(results);
    }
    if (!punya(u, cfg.setujui)) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
    let q = `SELECT t.*, e.nip, e.nama_gelar FROM ${cfg.tabel} t JOIN employees e ON e.id = t.employee_id`;
    const args = [], wh = [];
    if (u.role === "hr_cabang") {
      const cab = await userCabangId(c.env.DB, u);
      if (cab) { q += " JOIN units un ON un.id = e.unit_id"; wh.push("COALESCE(e.cabang_id, un.cabang_id) = ?"); args.push(cab); }
      else { wh.push("e.unit_id = ?"); args.push(u.unit_id); }
    }
    const st = c.req.query("status");
    if (st) { wh.push("t.status = ?"); args.push(st); }
    if (wh.length) q += " WHERE " + wh.join(" AND ");
    q += " ORDER BY t.tanggal DESC, t.id DESC";
    const { results } = await c.env.DB.prepare(q).bind(...args).all();
    return c.json(results);
  });

  app.post(base, auth, requirePerm(cfg.ajukan), async (c) => {
    const u = c.get("user");
    const b = await c.req.json().catch(() => ({}));
    let empId = b.employee_id || null;
    if (u.role === "pegawai" || !empId) empId = await empIdOfUser(c.env.DB, u);
    if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
    if (u.role !== "pegawai") {
      const chk = await employeeInScope(c.env.DB, u, empId);
      if (!chk.ok) return c.json({ error: chk.error }, chk.code);
    }
    if (!TGL_RE.test(String(b.tanggal || ""))) return c.json({ error: "tanggal YYYY-MM-DD wajib" }, 400);
    if (jenis === "lembur") {
      if (!JAM_RE.test(String(b.jam_mulai || "")) || !JAM_RE.test(String(b.jam_selesai || "")))
        return c.json({ error: "jam_mulai + jam_selesai (HH:MM) wajib" }, 400);
      if (b.jam_selesai <= b.jam_mulai) return c.json({ error: "jam_selesai harus setelah jam_mulai" }, 400);
      await c.env.DB.prepare(
        "INSERT INTO lembur (employee_id, tanggal, jam_mulai, jam_selesai, keterangan) VALUES (?,?,?,?,?)"
      ).bind(empId, b.tanggal, b.jam_mulai, b.jam_selesai, b.keterangan || null).run();
    } else if (jenis === "reimbursement") {
      const nom = Number(b.nominal);
      if (!Number.isFinite(nom) || nom <= 0) return c.json({ error: "nominal harus > 0" }, 400);
      await c.env.DB.prepare(
        "INSERT INTO reimbursement (employee_id, tanggal, kategori, nominal, deskripsi, bukti_url) VALUES (?,?,?,?,?,?)"
      ).bind(empId, b.tanggal, b.kategori || "lainnya", nom, b.deskripsi || null, b.bukti_url || null).run();
    } else if (jenis === "surat") {
      await c.env.DB.prepare(
        "INSERT INTO surat (employee_id, tanggal, jenis, keperluan) VALUES (?,?,?,?)"
      ).bind(empId, b.tanggal, b.jenis || "keterangan_kerja", b.keperluan || null).run();
    } else if (jenis === "koreksi-presensi") {
      if (!["check_in", "check_out"].includes(b.kolom)) return c.json({ error: "kolom harus check_in/check_out" }, 400);
      if (!JAM_RE.test(String(b.waktu_baru || ""))) return c.json({ error: "waktu_baru (HH:MM) wajib" }, 400);
      if (!b.alasan || !String(b.alasan).trim()) return c.json({ error: "alasan wajib diisi" }, 400);
      await c.env.DB.prepare(
        "INSERT INTO koreksi_presensi (employee_id, tanggal, kolom, waktu_baru, alasan) VALUES (?,?,?,?,?)"
      ).bind(empId, b.tanggal, b.kolom, String(b.waktu_baru).slice(0, 5), String(b.alasan).trim()).run();
    } else {
      if (!UBDATA_BOLEH.includes(b.kolom)) return c.json({ error: `kolom harus: ${UBDATA_BOLEH.join(", ")}` }, 400);
      if (b.nilai_baru === undefined || b.nilai_baru === null || String(b.nilai_baru) === "")
        return c.json({ error: "nilai_baru wajib" }, 400);
      const emp = await c.env.DB.prepare(`SELECT ${b.kolom} AS v FROM employees WHERE id = ?`).bind(empId).first();
      await c.env.DB.prepare(
        "INSERT INTO perubahan_data (employee_id, tanggal, kolom, nilai_lama, nilai_baru) VALUES (?,?,?,?,?)"
      ).bind(empId, b.tanggal, b.kolom, emp?.v ?? null, String(b.nilai_baru)).run();
    }
    return c.json({ ok: true });
  });

  app.patch(`${base}/:id`, auth, async (c) => {
    const u = c.get("user");
    const b = await c.req.json().catch(() => ({}));
    if (!["disetujui", "ditolak"].includes(b.status)) return c.json({ error: "status harus disetujui/ditolak" }, 400);
    const ekstra = jenis === "perubahan-data" ? ", kolom, nilai_baru" : jenis === "koreksi-presensi" ? ", tanggal, kolom, waktu_baru" : "";
    const row = await c.env.DB.prepare(`SELECT employee_id, status${ekstra} FROM ${cfg.tabel} WHERE id = ?`).bind(c.req.param("id")).first();
    if (!row) return c.json({ error: "Tidak ditemukan" }, 404);
    if (row.status !== "diajukan") return c.json({ error: `Sudah ${row.status}` }, 422);
    // HR berizin → cek scope cabang; atasan langsung → boleh untuk bawahannya.
    const atasan = await isAtasan(c.env.DB, u, row.employee_id);
    if (u.role !== "master_admin" && !atasan) {
    if (!punya(u, cfg.setujui)) {
      // Atasan tanpa izin HR: hanya pengajuan bawahan langsungnya
      const { results: bawahan } = await c.env.DB.prepare(
        "SELECT id FROM employees WHERE atasan_id = (SELECT id FROM employees WHERE user_id = ?)"
      ).bind(u.id).all();
      if (!bawahan.length) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
      const ids = bawahan.map((r) => r.id);
      const st = c.req.query("status");
      let q2 = `SELECT t.*, e.nip, e.nama_gelar FROM ${cfg.tabel} t JOIN employees e ON e.id = t.employee_id WHERE t.employee_id IN (${ids.map(() => "?").join(",")})`;
      const a2 = [...ids];
      if (st) { q2 += " AND t.status = ?"; a2.push(st); }
      q2 += " ORDER BY t.tanggal DESC, t.id DESC";
      const { results } = await c.env.DB.prepare(q2).bind(...a2).all();
      return c.json(results);
    }
      const chk = await employeeInScope(c.env.DB, u, row.employee_id);
      if (!chk.ok) return c.json({ error: chk.error }, chk.code);
    }
    if (jenis === "surat") {
      await c.env.DB.prepare("UPDATE surat SET status=?, disetujui_oleh=?, nomor=COALESCE(?, nomor) WHERE id=?")
        .bind(b.status, u.id, b.nomor || null, c.req.param("id")).run();
    } else {
      await c.env.DB.prepare(`UPDATE ${cfg.tabel} SET status=?, disetujui_oleh=? WHERE id=?`).bind(b.status, u.id, c.req.param("id")).run();
    }
    if (jenis === "perubahan-data" && b.status === "disetujui" && UBDATA_BOLEH.includes(row.kolom)) {
      await c.env.DB.prepare(`UPDATE employees SET ${row.kolom} = ? WHERE id = ?`).bind(row.nilai_baru, row.employee_id).run();
    }
    if (jenis === "koreksi-presensi" && b.status === "disetujui" && ["check_in", "check_out"].includes(row.kolom)) {
      // Terapkan jam baru (WIB) ke baris absensi; buat baris bila belum ada.
      const instant = new Date(`${row.tanggal}T${String(row.waktu_baru).slice(0, 5)}:00+07:00`).toISOString();
      const ada = await c.env.DB.prepare("SELECT id FROM absensi WHERE employee_id = ? AND tanggal = ?").bind(row.employee_id, row.tanggal).first();
      if (ada) {
        await c.env.DB.prepare(`UPDATE absensi SET ${row.kolom} = ? WHERE id = ?`).bind(instant, ada.id).run();
      } else {
        await c.env.DB.prepare(`INSERT INTO absensi (employee_id, tanggal, status, ${row.kolom}) VALUES (?,?,'hadir',?)`)
          .bind(row.employee_id, row.tanggal, instant).run();
      }
    }
    await kirimNotif(c.env.DB, await userIdOfEmployee(c.env.DB, row.employee_id),
      `Pengajuan ${cfg.label} ${b.status}`, `Pengajuan ${cfg.label} Anda telah ${b.status} oleh ${u.name || "HR"}.`);
    return c.json({ ok: true });
  });
}
for (const j of Object.keys(PENGAJUAN)) pengajuanRoutes(j);

// Daftar cuti — pegawai: miliknya; lainnya (izin cuti.setujui): scope cabang
app.get("/api/cuti", auth, async (c) => {
  const u = c.get("user");
  const status = c.req.query("status");
  if (u.role === "pegawai") {
    if (!punya(u, "cuti.ajukan")) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
    const empId = await empIdOfUser(c.env.DB, u);
    // Karyawan yang juga atasan: sertakan cuti bawahan langsungnya
    const { results: bawahan } = await c.env.DB.prepare(
      "SELECT id FROM employees WHERE atasan_id = ?"
    ).bind(empId ?? -1).all();
    const ids = [empId ?? -1, ...bawahan.map((r) => r.id)];
    const { results } = await c.env.DB.prepare(
      `SELECT ct.*, e.nip, e.nama_gelar FROM cuti ct JOIN employees e ON e.id = ct.employee_id WHERE ct.employee_id IN (${ids.map(() => "?").join(",")}) ORDER BY tgl_mulai DESC`
    ).bind(...ids).all();
    return c.json(results);
  }
  if (!punya(u, "cuti.setujui")) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
  let q = `SELECT ct.*, e.nip, e.nama_gelar FROM cuti ct JOIN employees e ON e.id = ct.employee_id`;
  const args = [];
  const wh = [];
  if (u.role === "hr_cabang") {
    const cab = await userCabangId(c.env.DB, u);
    if (cab) { q += " JOIN units un ON un.id = e.unit_id"; wh.push("COALESCE(e.cabang_id, un.cabang_id) = ?"); args.push(cab); }
    else { wh.push("e.unit_id = ?"); args.push(u.unit_id); }
  }
  if (status) { wh.push("ct.status = ?"); args.push(status); }
  if (wh.length) q += " WHERE " + wh.join(" AND ");
  q += " ORDER BY ct.tgl_mulai DESC";
  const { results } = await c.env.DB.prepare(q).bind(...args).all();
  return c.json(results);
});

// Ajukan cuti — butuh cuti.ajukan
app.post("/api/cuti", auth, requirePerm("cuti.ajukan"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const { tgl_mulai, tgl_selesai, jenis, keterangan } = b;
  if (!TGL_RE.test(String(tgl_mulai || "")) || !TGL_RE.test(String(tgl_selesai || "")))
    return c.json({ error: "tgl_mulai + tgl_selesai (YYYY-MM-DD) wajib" }, 400);
  if (tgl_selesai < tgl_mulai) return c.json({ error: "tgl_selesai sebelum tgl_mulai" }, 400);
  const JENIS_CUTI = ["tahunan", "sakit", "keluarga", "tugas_luar", "terlambat", "melahirkan", "lainnya"];
  if (jenis && !JENIS_CUTI.includes(jenis)) return c.json({ error: `jenis harus: ${JENIS_CUTI.join(", ")}` }, 400);
  let empId = b.employee_id || null;
  if (u.role === "pegawai" || !empId) empId = await empIdOfUser(c.env.DB, u);
  if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
  if (u.role !== "pegawai") {
    const chk = await employeeInScope(c.env.DB, u, empId);
    if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  }
  await c.env.DB.prepare(
    "INSERT INTO cuti (employee_id, jenis, tgl_mulai, tgl_selesai, keterangan) VALUES (?,?,?,?,?)"
  ).bind(empId, jenis || "tahunan", tgl_mulai, tgl_selesai, keterangan || null).run();
  return c.json({ ok: true });
});

// Setujui/tolak cuti — HR berizin (scope cabang) ATAU atasan langsung bawahan
app.patch("/api/cuti/:id", auth, async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  if (!["disetujui", "ditolak"].includes(b.status)) return c.json({ error: "status harus disetujui/ditolak" }, 400);
  const row = await c.env.DB.prepare("SELECT employee_id, status FROM cuti WHERE id = ?").bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "Tidak ditemukan" }, 404);
  if (row.status !== "diajukan") return c.json({ error: `Sudah ${row.status}` }, 422);
  const atasan = await isAtasan(c.env.DB, u, row.employee_id);
  if (u.role !== "master_admin" && !atasan) {
  if (!punya(u, "cuti.setujui")) {
    // Atasan tanpa izin HR: hanya melihat cuti bawahan langsungnya
    const { results: bawahan } = await c.env.DB.prepare(
      "SELECT id FROM employees WHERE atasan_id = (SELECT id FROM employees WHERE user_id = ?)"
    ).bind(u.id).all();
    if (!bawahan.length) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
    const ids = bawahan.map((r) => r.id);
    const st = c.req.query("status");
    let q2 = `SELECT ct.*, e.nip, e.nama_gelar FROM cuti ct JOIN employees e ON e.id = ct.employee_id WHERE ct.employee_id IN (${ids.map(() => "?").join(",")})`;
    const a2 = [...ids];
    if (st) { q2 += " AND ct.status = ?"; a2.push(st); }
    q2 += " ORDER BY ct.tgl_mulai DESC";
    const { results } = await c.env.DB.prepare(q2).bind(...a2).all();
    return c.json(results);
  }
    const chk = await employeeInScope(c.env.DB, u, row.employee_id);
    if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  }
  await c.env.DB.prepare("UPDATE cuti SET status=?, disetujui_oleh=? WHERE id=?").bind(b.status, u.id, c.req.param("id")).run();
  await kirimNotif(c.env.DB, await userIdOfEmployee(c.env.DB, row.employee_id),
    `Pengajuan cuti ${b.status}`, `Pengajuan cuti Anda telah ${b.status} oleh ${u.name || "HR"}.`);
  return c.json({ ok: true });
});

// ---------- Penilaian kinerja ----------
app.get("/api/penilaian", auth, async (c) => {
  const u = c.get("user");
  const empId = Number(c.req.query("employee_id"));
  if (u.role === "pegawai") {
    const milik = await empIdOfUser(c.env.DB, u);
    if (!milik) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
    const { results } = await c.env.DB.prepare("SELECT * FROM penilaian WHERE employee_id = ? ORDER BY periode DESC").bind(milik).all();
    return c.json(results);
  }
  if (!punya(u, "kpi.kelola")) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
  if (!empId) return c.json({ error: "employee_id wajib" }, 400);
  const chk = await employeeInScope(c.env.DB, u, empId);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  const { results } = await c.env.DB.prepare("SELECT * FROM penilaian WHERE employee_id = ? ORDER BY periode DESC").bind(empId).all();
  return c.json(results);
});
app.post("/api/penilaian", auth, requirePerm("kpi.kelola"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const empId = Number(b.employee_id);
  if (!empId) return c.json({ error: "employee_id wajib" }, 400);
  if (!/^\d{4}(-\d{2})?$/.test(String(b.periode || ""))) return c.json({ error: "periode harus YYYY atau YYYY-MM" }, 400);
  if (b.skor !== undefined && b.skor !== null && (!Number.isInteger(Number(b.skor)) || Number(b.skor) < 1 || Number(b.skor) > 5))
    return c.json({ error: "skor harus 1–5" }, 400);
  const chk = await employeeInScope(c.env.DB, u, empId);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  await c.env.DB.prepare(
    `INSERT INTO penilaian (employee_id, periode, target, skor, catatan, rencana_kembang, dinilai_oleh) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (employee_id, periode) DO UPDATE SET target=EXCLUDED.target, skor=EXCLUDED.skor, catatan=EXCLUDED.catatan, rencana_kembang=EXCLUDED.rencana_kembang, dinilai_oleh=EXCLUDED.dinilai_oleh, waktu=now()`
  ).bind(empId, b.periode, b.target || null, b.skor ?? null, b.catatan || null, b.rencana_kembang || null, u.id).run();
  return c.json({ ok: true });
});

// ---------- Notifikasi dalam aplikasi ----------
app.get("/api/notifikasi", auth, async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT id, judul, isi, dibaca, waktu FROM notifikasi WHERE user_id = ? ORDER BY waktu DESC LIMIT 20"
  ).bind(u.id).all();
  const r = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM notifikasi WHERE user_id = ? AND dibaca = 0").bind(u.id).first();
  return c.json({ belum_dibaca: Number(r?.n ?? 0), items: results });
});
app.post("/api/notifikasi/baca", auth, async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  if (b.semua) await c.env.DB.prepare("UPDATE notifikasi SET dibaca = 1 WHERE user_id = ?").bind(u.id).run();
  else if (b.id) await c.env.DB.prepare("UPDATE notifikasi SET dibaca = 1 WHERE id = ? AND user_id = ?").bind(Number(b.id), u.id).run();
  else return c.json({ error: "id atau semua:true wajib" }, 400);
  return c.json({ ok: true });
});

// ---------- Pengumuman ----------
app.get("/api/pengumuman", auth, async (c) => {
  const u = c.get("user");
  const semua = c.req.query("semua") === "1" && (u.role === "master_admin" || u.role === "hr_cabang");
  const { results } = await c.env.DB.prepare(
    semua ? "SELECT * FROM pengumuman ORDER BY waktu DESC LIMIT 50" : "SELECT id, judul, isi, waktu FROM pengumuman WHERE aktif = 1 ORDER BY waktu DESC LIMIT 20"
  ).all();
  return c.json(results);
});
app.post("/api/pengumuman", auth, async (c) => {
  const u = c.get("user");
  if (u.role !== "master_admin" && u.role !== "hr_cabang") return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
  const b = await c.req.json().catch(() => ({}));
  if (!b.judul || !b.isi) return c.json({ error: "judul + isi wajib" }, 400);
  await c.env.DB.prepare("INSERT INTO pengumuman (judul, isi, dibuat_oleh) VALUES (?,?,?)").bind(b.judul, b.isi, u.id).run();
  return c.json({ ok: true });
});
app.patch("/api/pengumuman/:id", auth, async (c) => {
  const u = c.get("user");
  if (u.role !== "master_admin" && u.role !== "hr_cabang") return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
  const b = await c.req.json().catch(() => ({}));
  if (b.aktif !== undefined)
    await c.env.DB.prepare("UPDATE pengumuman SET aktif = ? WHERE id = ?").bind(b.aktif ? 1 : 0, c.req.param("id")).run();
  else {
    if (!b.judul || !b.isi) return c.json({ error: "judul + isi wajib" }, 400);
    await c.env.DB.prepare("UPDATE pengumuman SET judul = ?, isi = ? WHERE id = ?").bind(b.judul, b.isi, c.req.param("id")).run();
  }
  return c.json({ ok: true });
});

// ---------- Onboarding checklist ----------
const ONBOARDING_DEFAULT = [
  "Kelengkapan dokumen (KTP, KK, ijazah)",
  "Tanda tangan kontrak kerja",
  "Serah terima akun & akses sistem",
  "Orientasi unit & perkenalan atasan",
  "Foto & data rekening gaji",
  "Penjelasan kebijakan perusahaan",
];
app.get("/api/onboarding", auth, async (c) => {
  const u = c.get("user");
  let empId = Number(c.req.query("employee_id"));
  if (u.role === "pegawai") {
    empId = await empIdOfUser(c.env.DB, u);
    if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
  } else {
    if (!punya(u, "karyawan.lihat")) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
    if (!empId) return c.json({ error: "employee_id wajib" }, 400);
    const chk = await employeeInScope(c.env.DB, u, empId);
    if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  }
  let { results } = await c.env.DB.prepare("SELECT * FROM onboarding WHERE employee_id = ? ORDER BY id").bind(empId).all();
  if (!results.length) {
    for (const item of ONBOARDING_DEFAULT)
      await c.env.DB.prepare("INSERT INTO onboarding (employee_id, item) VALUES (?,?) ON CONFLICT (employee_id, item) DO NOTHING").bind(empId, item).run();
    ({ results } = await c.env.DB.prepare("SELECT * FROM onboarding WHERE employee_id = ? ORDER BY id").bind(empId).all());
  }
  return c.json(results);
});
app.patch("/api/onboarding/:id", auth, requirePerm("karyawan.kelola"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const row = await c.env.DB.prepare("SELECT employee_id FROM onboarding WHERE id = ?").bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "Tidak ditemukan" }, 404);
  const chk = await employeeInScope(c.env.DB, u, row.employee_id);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  const s = b.selesai ? 1 : 0;
  await c.env.DB.prepare("UPDATE onboarding SET selesai = ?, selesai_at = CASE WHEN ? = 1 THEN now() ELSE NULL END WHERE id = ?").bind(s, s, c.req.param("id")).run();
  return c.json({ ok: true });
});

// ---------- Dokumen karyawan (metadata + kedaluwarsa; file fisik via URL/arsip) ----------
app.get("/api/documents/kedaluwarsa", auth, requirePerm("karyawan.kelola"), async (c) => {
  const u = c.get("user");
  const sc = await scopeKaryawan(c.env.DB, u, "e");
  const where = sc.where ? `${sc.where} AND ` : "";
  const { results } = await c.env.DB.prepare(
    `SELECT d.*, e.nip, e.nama_gelar FROM documents d JOIN employees e ON e.id = d.employee_id${sc.join} WHERE ${where}d.kedaluwarsa IS NOT NULL AND d.kedaluwarsa <= CURRENT_DATE + INTERVAL '60 days' ORDER BY d.kedaluwarsa`
  ).bind(...sc.args).all();
  return c.json(results);
});app.get("/api/documents", auth, async (c) => {
  const u = c.get("user");
  let empId = Number(c.req.query("employee_id"));
  if (u.role === "pegawai") {
    empId = await empIdOfUser(c.env.DB, u);
    if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
  } else {
    if (!punya(u, "karyawan.lihat")) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
    if (!empId) return c.json({ error: "employee_id wajib" }, 400);
    const chk = await employeeInScope(c.env.DB, u, empId);
    if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  }
  const { results } = await c.env.DB.prepare("SELECT * FROM documents WHERE employee_id = ? ORDER BY jenis, id").bind(empId).all();
  return c.json(results);
});
app.post("/api/documents", auth, requirePerm("karyawan.kelola"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const empId = Number(b.employee_id);
  if (!empId || !b.jenis || !b.judul) return c.json({ error: "employee_id + jenis + judul wajib" }, 400);
  if (b.kedaluwarsa && !TGL_RE.test(String(b.kedaluwarsa))) return c.json({ error: "kedaluwarsa harus YYYY-MM-DD" }, 400);
  const chk = await employeeInScope(c.env.DB, u, empId);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  await c.env.DB.prepare("INSERT INTO documents (employee_id, jenis, judul, file_key, kedaluwarsa) VALUES (?,?,?,?,?)")
    .bind(empId, b.jenis, b.judul, b.file_key || null, b.kedaluwarsa || null).run();
  return c.json({ ok: true });
});
app.patch("/api/documents/:id", auth, requirePerm("karyawan.kelola"), async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const row = await c.env.DB.prepare("SELECT employee_id FROM documents WHERE id = ?").bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "Tidak ditemukan" }, 404);
  const chk = await employeeInScope(c.env.DB, u, row.employee_id);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  if (b.kedaluwarsa !== undefined && b.kedaluwarsa !== null && !TGL_RE.test(String(b.kedaluwarsa)))
    return c.json({ error: "kedaluwarsa harus YYYY-MM-DD" }, 400);
  const sets = [], args = [];
  for (const k of ["jenis", "judul", "file_key", "kedaluwarsa"]) {
    if (b[k] !== undefined) { sets.push(`${k} = ?`); args.push(b[k] === "" ? null : b[k]); }
  }
  if (!sets.length) return c.json({ error: "Tidak ada field yang diubah" }, 400);
  await c.env.DB.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).bind(...args, c.req.param("id")).run();
  return c.json({ ok: true });
});
app.delete("/api/documents/:id", auth, requirePerm("karyawan.kelola"), async (c) => {
  const u = c.get("user");
  const row = await c.env.DB.prepare("SELECT employee_id FROM documents WHERE id = ?").bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "Tidak ditemukan" }, 404);
  const chk = await employeeInScope(c.env.DB, u, row.employee_id);
  if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  await c.env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ---------- Arsip file fisik (dokumen, foto) ----------
// Berkas tersimpan di ARSIP_DIR (lokal: api/data/arsip, produksi: volume ./data/arsip).
// Nama file tak bisa ditebak dari luar + selalu cek hak akses sebelum disajikan.
const ARSIP_DIR = process.env.ARSIP_DIR || join(process.cwd(), "data", "arsip");
const ARSIP_MAKS = Number(process.env.ARSIP_MAKS_BYTE || 5 * 1024 * 1024);
const ARSIP_MIME = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const NAMA_ARSIP_RE = /^(\d+)-(\d+)-([a-z0-9]+)\.(pdf|jpg|png|webp)$/;

app.post("/api/upload", auth, async (c) => {
  const u = c.get("user");
  if (!rateOk(`upload:${clientIp(c)}`, 30, 60 * 1000))
    return c.json({ error: "Terlalu banyak unggahan. Coba lagi 1 menit." }, 429);
  const fd = await c.req.formData().catch(() => null);
  if (!fd) return c.json({ error: "Form multipart wajib" }, 400);
  const file = fd.get("file");
  let empId = Number(fd.get("employee_id")) || null;
  if (u.role === "pegawai") empId = await empIdOfUser(c.env.DB, u);
  if (!empId) return c.json({ error: "Akun belum tertaut ke data karyawan" }, 400);
  if (u.role !== "pegawai") {
    const chk = await employeeInScope(c.env.DB, u, empId);
    if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  }
  if (!(file instanceof Blob) || !file.size) return c.json({ error: "file wajib" }, 400);
  if (file.size > ARSIP_MAKS) return c.json({ error: `Ukuran maks ${Math.round(ARSIP_MAKS / 1048576)} MB` }, 400);
  const ext = ARSIP_MIME[file.type];
  if (!ext) return c.json({ error: "Tipe file harus PDF/JPG/PNG/WebP" }, 400);
  const rnd = Math.random().toString(36).slice(2, 8);
  const nama = `${empId}-${Date.now()}-${rnd}.${ext}`;
  await mkdir(ARSIP_DIR, { recursive: true });
  await writeFile(join(ARSIP_DIR, nama), Buffer.from(await file.arrayBuffer()));
  return c.json({ ok: true, nama, url: `/api/arsip/${nama}`, ukuran: file.size });
});

app.get("/api/arsip/:nama", auth, async (c) => {
  const u = c.get("user");
  const m = String(c.req.param("nama")).match(NAMA_ARSIP_RE);
  if (!m) return c.json({ error: "Arsip tidak valid" }, 404);
  const empId = Number(m[1]);
  if (u.role === "pegawai") {
    const milik = await empIdOfUser(c.env.DB, u);
    if (milik !== empId) return c.json({ error: "Akses ditolak" }, 403);
  } else {
    if (!punya(u, "karyawan.lihat")) return c.json({ error: "Akses ditolak (izin kurang)" }, 403);
    const chk = await employeeInScope(c.env.DB, u, empId);
    if (!chk.ok) return c.json({ error: chk.error }, chk.code);
  }
  try {
    const buf = await readFile(join(ARSIP_DIR, m[0]));
    const tipe = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[m[4]];
    return c.body(new Uint8Array(buf), 200, {
      "Content-Type": tipe,
      "Content-Disposition": `inline; filename="${m[0]}"`,
      "Cache-Control": "private, max-age=3600",
    });
  } catch {
    return c.json({ error: "File tidak ditemukan" }, 404);
  }
});

// ---------- Undangan aktivasi via email / WhatsApp ----------
// HR/admin: buatkan sandi sementara + kirim. Butuh SMTP / gateway WA di Pengaturan.
function sandiAcak(n = 12) {
  const abjad = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => abjad[x % abjad.length]).join("");
}

app.post("/api/users/:id/undang", auth, requirePerm("users.kelola"), async (c) => {
  const u = c.get("user");
  const id = c.req.param("id");
  const b = await c.req.json().catch(() => ({}));
  const via = b.via === "wa" ? "wa" : "email";
  const t = await c.env.DB.prepare("SELECT id, email, name, aktif FROM users WHERE id = ?").bind(id).first();
  if (!t) return c.json({ error: "Pengguna tidak ditemukan" }, 404);
  if (!t.aktif) return c.json({ error: "Akun nonaktif — aktifkan dulu" }, 422);
  const set = await getPengaturan(c.env.DB);
  const sandi = sandiAcak();
  const masukUrl = (process.env.CORS_ORIGIN || "").split(",")[0] || "https://hr.office-alwildan.id";
  const pesan = `Assalamu'alaikum ${t.name || t.email},\nakun HRIS AL-WILDAN Anda sudah aktif.\nEmail: ${t.email}\nSandi sementara: ${sandi}\nMasuk: ${masukUrl}/login\nSegera ganti sandi setelah masuk.`;
  if (via === "email") {
    if (!set.SMTP_HOST || !set.SMTP_USER) return c.json({ error: "SMTP belum dikonfigurasi (lihat Pengaturan)" }, 422);
    try {
      const tr = nodemailer.createTransport({
        host: set.SMTP_HOST, port: Number(set.SMTP_PORT || 587),
        secure: set.SMTP_SECURE === "1", auth: { user: set.SMTP_USER, pass: set.SMTP_PASS || "" },
      });
      await tr.sendMail({ from: set.SMTP_FROM || set.SMTP_USER, to: t.email, subject: "Undangan aktivasi HRIS AL-WILDAN", text: pesan });
    } catch (e) {
      return c.json({ error: `Gagal kirim email: ${e.message}` }, 502);
    }
  } else {
    const tujuan = String(b.tujuan || "").replace(/\D/g, "");
    if (!tujuan) return c.json({ error: "Nomor WA tujuan wajib (tujuan, cth. 62812…)" }, 400);
    if (!set.WA_URL || !set.WA_TOKEN) return c.json({ error: "Gateway WA belum dikonfigurasi (lihat Pengaturan)" }, 422);
    try {
      const r = await fetch(set.WA_URL, {
        method: "POST",
        headers: { Authorization: set.WA_TOKEN, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ target: tujuan, message: pesan }),
      });
      if (!r.ok) return c.json({ error: `Gateway WA menolak (${r.status})` }, 502);
    } catch (e) {
      return c.json({ error: `Gateway WA tak terjangkau: ${e.message}` }, 502);
    }
  }
  await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(sandi), id).run();
  await kirimNotif(c.env.DB, id, "Undangan aktivasi HRIS",
    `Undangan dikirim via ${via === "wa" ? "WhatsApp" : "email"} oleh ${u.name || "admin"}. Cek ${via === "wa" ? "WA" : "email"} Anda untuk sandi sementara.`);
  return c.json({ ok: true, via });
});

// ============================================================
//  Tampilan statis (web/dist hasil build frontend) + SPA fallback
// ============================================================
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
