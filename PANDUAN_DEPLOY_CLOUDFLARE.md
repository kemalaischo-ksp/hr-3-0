# Panduan Deploy HRIS AW3: Cloudflare + VPS Tencent (Lengkap)

> Dokumen hidup — diperbarui mengikuti langkah nyata yang sudah dilalui.
> Status: VPS aktif, DNS dalam propagasi, deploy aplikasi berikutnya.

## 0. Inventaris (isi nyata)

| Item | Nilai |
|---|---|
| Domain | `office-alwildan.id` (DomaiNesia) |
| Subdomain HRIS | `hr.office-alwildan.id` |
| Cloudflare plan | Free ($0) |
| Nameserver CF | `elias.ns.cloudflare.com`, `jasmine.ns.cloudflare.com` |
| VPS | Tencent Lighthouse 2C4G Singapore, Ubuntu24.04–Docker29 |
| IP publik VPS | `43.156.130.183` |
| Masa aktif VPS | s.d. 21 Sep 2027 |
| User SSH | `ubuntu` (login via console OrcaTerm / SSH) |

---

## BAGIAN A — Domain di Cloudflare ✅ SELESAI

- [x] Tambah `office-alwildan.id` ke Cloudflare, paket **Free** (cukup: DNS, SSL,
      proxy, 5 WAF rules, Bot Fight Mode).
- [x] Record A: `hr` → `43.156.130.183`, **Proxied ON**.
- [x] Nameserver di DomaiNesia → `elias` + `jasmine` (custom, NS 3–5 kosong).
- [x] DNSSEC OFF (form kosong = benar, jangan diisi).
- [ ] Cloudflare status **Active** (propagasi 1–24 jam; cek: `nslookup hr.office-alwildan.id`).
- [ ] SSL/TLS → **Full (strict)** + Always Use HTTPS (setelah Caddy hijau di VPS).

## BAGIAN B — Pembelian VPS ✅ SELESAI

- Produk: **Lighthouse Linux 2c 1yr, Starter 2vCPUs4G 30M70G** ($36/thn).
- Region **Singapore** (Jakarta tak tersedia untuk Lighthouse), Image
  **Ubuntu24.04–Docker29** (Docker preinstal), login password via webmail.

## BAGIAN C — Akses & penyiapan VPS (BERJALAN)

1. Console Tencent → Lighthouse → Instances → **Log in** (AUTO/`ubuntu`).
   - Bila "Password-free login is not available" (umum sesaat setelah reboot):
     tunggu 1–2 mnt dan ulangi; alternatif: protocol **SSH** + password webmail,
     atau **Log in via VNC**.
2. Verifikasi: `docker --version && docker compose version` (terkonfirmasi
   v29.6.1 + v5.3.1 ✅).
3. `sudo apt update && sudo apt upgrade -y`; reboot bila kernel baru
   (aman bila belum ada aplikasi jalan), login ulang.

## BAGIAN D — Transfer file & deploy (BERIKUTNYA)

1. Dari Terminal Mac:
   ```bash
   ssh ubuntu@43.156.130.183   # tes dulu; password dari webmail Tencent
   ```
2. Transfer folder (keluarkan yang berat):
   ```bash
   cd "/Users/kemal/Documents/KSP-AI/BLACK MIRROR"
   rsync -avz --exclude 'web/node_modules' --exclude 'api/node_modules' \
     --exclude 'web/dist' --exclude 'data' \
     "HR 3.0/" ubuntu@43.156.130.183:~/hr30/
   ```
3. Di VPS:
   ```bash
   cd ~/hr30
   cp .env.prod.example .env && chmod 600 .env
   nano .env   # isi AUTH_SECRET (openssl rand -base64 32) + DB_PASSWORD
   docker compose up -d --build
   sleep 25
   curl http://127.0.0.1:3000/api/health
   docker compose logs --tail 15 hr30   # "Migrasi HR 3.0 selesai"
   ```

## BAGIAN E — Caddy + go-live (SETELAH D AKTIF)

```bash
sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile
# isi:
# hr.office-alwildan.id {
#     reverse_proxy 127.0.0.1:3000
# }
sudo systemctl reload caddy
```

Verifikasi: `https://hr.office-alwildan.id/login` gembok hijau → login admin demo
→ **amankan akun demo** → NIP final → 1 aktivasi + 1 slip → backup pertama →
cron harian (detail: `RUNBOOK_OPERASIONAL.md`).
