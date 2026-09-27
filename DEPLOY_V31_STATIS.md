# Deploy Tampilan v3.1 (Paket Statis) — 2 Opsi

> Konten: `index.html`, `data.js` (1.659 karyawan), `recruit.js` (239 kandidat),
> `logo.png`, `template_rekrutmen.csv`.
> ⚠️ **Aplikasi ini 100% localStorage** — login & data TIDAK terhubung ke
> backend Postgres. Data tidak tersinkron antar perangkat. HANYA untuk demo
> tampilan / tahap pengembangan, bukan pengganti produksi HR 3.0.

---

## Opsi A — Demo terpisah (DISARANKAN, produksi tetap aman)

Meletakkan paket v3.1 sebagai subdomain demo **tanpa menyentuh** `hr.office-alwildan.id`.

### 1. Di VPS — salin file (dari laptop atau git checkout)
```bash
mkdir -p /var/www/sdm-v31 && cd /var/www/sdm-v31
# opsional: ambil dari repo (file aman) lalu tambahkan data.js & recruit.js via scp
git clone --depth 1 https://github.com/kemalaischo-ksp/hr-3-0.git tmp
cp tmp/"5. updatev3.1_SDM-ALWILDAN-deploy"/index.html tmp/"5. updatev3.1_SDM-ALWILDAN-deploy"/logo.png tmp/"5. updatev3.1_SDM-ALWILDAN-deploy"/template_rekrutmen.csv .
# data.js + recruit.js (PII) — kirim terpisah:
scp "5. updatev3.1_SDM-ALWILDAN-deploy/data.js" "5. updatev3.1_SDM-ALWILDAN-deploy/recruit.js" ubuntu@43.156.130.183:/var/www/sdm-v31/
```

### 2. Caddy — subdomain demo
Tambahkan blok di `/etc/caddy/Caddyfile`:
```caddyfile
sdm.office-alwildan.id {
    encode gzip
    root * /var/www/sdm-v31
    file_server
    try_files {path} /index.html
}
```
lalu `sudo systemctl reload caddy`. Tambahkan DNS A record `sdm` → `43.156.130.183`
(Proxied ON) di Cloudflare.

→ Demo hidup di `https://sdm.office-alwildan.id`, produksi tidak terganggu.

---

## Opsi B — Ganti total halaman utama hr.office-alwildan.id (TIDAK DISARANKAN)

Menimpa frontend Docker dengan paket statis. **Efek:** login/DB Postgres,
RBAC, sesi server, aktivasi THP, payroll, backup — semua berhenti. Data yang
dimunculkan adalah snapshot statis, bukan DB live.

### Backup dulu (wajib):
```bash
docker exec hr30-db pg_dump -U hr30 -d hr30_aw3 > /root/hr30_aw3_backup_pre_v31.sql
```

### Ganti frontend Docker (build dalam image):
```bash
cd ~/hr30
mkdir -p public-dist
cp -r "5. updatev3.1_SDM-ALWILDAN-deploy"/index.html "5. updatev3.1_SDM-ALWILDAN-deploy"/data.js "5. updatev3.1_SDM-ALWILDAN-deploy"/recruit.js "5. updatev3.1_SDM-ALWILDAN-deploy"/logo.png "5. updatev3.1_SDM-ALWILDAN-deploy"/template_rekrutmen.csv public-dist/
docker compose up -d --build
```

### Rollback ke produksi semula:
```bash
cd ~/hr30
rm public-dist/index.html public-dist/data.js public-dist/recruit.js
docker compose up -d --build   # Dockerfile rebuild web/ React + migrasi
```

---

**Rekomendasi:** pakai **Opsi A**. Kalau tujuan akhirnya tampilan v3.1 untuk
produksi dengan data live, itu pekerjaan integrasi (hubungkan `loadAccts/loadLocal/...`
di `index.html` ke API `/api/*`). Lihat `INTEGRASI_BETTER_AUTH_D1.md` untuk
arah integrasinya.