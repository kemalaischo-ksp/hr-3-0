# HR 3.0 — DB Pilot AW3 BSD City

## Isi folder

| File | Fungsi |
|---|---|
| `migrations/001_hr30_pilot_aw3.sql` | DDL inti: `cabangs`, perluasan `employees`, `pendidikan`, `pengalaman`, `aktivasi_logs`, stub `absensi`+`cuti` |
| `migrations/002_nip_sequence.sql` | Sequence NIP `YYNNNN` + fungsi `next_nip('26')` |
| `seeds/aw3_pilot.sql` | 2 karyawan sampel ternormalisasi (Muthy aktif, Faqih diajukan) |
| `scripts/biodata_template.csv` | Template biodata (contoh = 2 sampel valid) |
| `scripts/aktivasi_template.csv` | Template aktivasi (contoh = 2 sampel valid) |
| `scripts/validate_import.py` | Validator stdlib-only: `python3 validate_import.py biodata.csv aktivasi.csv` |

## Cara pakai

**Fresh pilot:**
```bash
psql -d sim_hr -f <HR2/schema.pg.sql> -f migrations/001_hr30_pilot_aw3.sql \
  -f migrations/002_nip_sequence.sql -f seeds/aw3_pilot.sql
```

**Upgrade DB 2.0 yang sudah ada:** hanya `001` + `002` (tanpa seed).

**Import batch:** isi CSV dari template → `python3 validate_import.py ...` (exit 0 = valid).
Baris tidak balance **ditolak**, bukan dibetulkan diam-diam.

## Verifikasi yang sudah dilakukan (PostgreSQL 16 lokal)

- Fresh install + seed: OK, 2 baris balance (`4115200 = 4500000-384800`, dst.)
- `next_nip('26')` → `260003`: OK
- Insert THP tidak balance: DITOLAK `chk_emp_thp_balance`: OK
- Migrasi idempoten (rerun aman): OK
- Upgrade path dengan NIP lama 12 digit: OK (`nama_gelar` ter-backfill)

## Blocker sebelum produksi

Nomor urut NIP 2026 aktual dari HR belum diketahui — seed memakai `260001/260002`
sementara. Sesuaikan `nip_sequences` + NIP bila HR memberi angka terakhir.
