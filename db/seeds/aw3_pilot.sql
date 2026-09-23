-- ============================================================
-- HR 3.0 PILOT AW3 — Seed: 2 karyawan sampel ternormalisasi
-- Sumber PDF: Muhammad Muthy Abdullah (aktif) & Faqih Ahmad Rizki (diajukan).
-- Normalisasi yang diterapkan:
--  nama resmi = nama_gelar formulir ('Rizki' bukan 'Rizky');
--  tanggal -> ISO; no HP wa.me/0858.. -> 628..; nominal Rp -> angka.
-- NIP sementara 260001/260002. SEBELUM produksi, sesuaikan dengan nomor
-- urut aktual dari HR (UPDATE nip_sequences + NIP di bawah bila perlu).
-- Idempoten: aman dijalankan ulang (ON CONFLICT DO NOTHING/UPDATE).
-- ============================================================

-- Cabang pilot
INSERT INTO cabangs (kode, nama, alamat) VALUES
  ('AW3','Al-Wildan 3 BSD City','BSD City')
ON CONFLICT (kode) DO NOTHING;

-- Unit SMP-SMA milik AW3 (pisah dari unit generik 2.0 agar tidak campur cabang)
INSERT INTO units (nama, kode, alamat, cabang_id) VALUES
  ('SMP-SMA AW3','SMP-SMA-AW3','Al-Wildan 3 BSD City',(SELECT id FROM cabangs WHERE kode='AW3'))
ON CONFLICT (kode) DO NOTHING;

-- Sequence NIP tahun 26: 2 sudah terpakai oleh seed ini
INSERT INTO nip_sequences (tahun, terakhir) VALUES ('26', 2)
ON CONFLICT (tahun) DO UPDATE SET terakhir = GREATEST(nip_sequences.terakhir, 2);

-- 1) Muhammad Muthy Abdullah, S.Pd. — AKTIF (THP BERSIH FULL, TMT 2026-08-31)
INSERT INTO employees (
  unit_id, cabang_id, nip, nama, nama_gelar, nama_ktp, email, no_hp, nik_ktp,
  alamat, tempat_lahir, tgl_lahir, status_kawin, tinggi_cm, berat_kg, transport,
  posisi_diajukan, mapel, gaji_diajukan,
  bank_utama, norek_utama, bank_lain, norek_lain,
  thp_kotor, konfirmasi, thp_bersih, total_tk_thr, tk, thr_bulan,
  tmt_aktif, mode_thp, status_aktivasi,
  cv_url, kesehatan_url, arsip_key, aktif
) VALUES (
  (SELECT id FROM units WHERE kode='SMP-SMA-AW3'),
  (SELECT id FROM cabangs WHERE kode='AW3'),
  '260001',
  'Muhammad Muthy Abdullah, S.Pd.',
  'Muhammad Muthy Abdullah, S.Pd.',
  'Muhammad Muthy Abdullah',
  'muthymuhammad@gmail.com',
  '6285886593150',          -- wa.me/085886593150 & wa.me/6285886593150 -> kanonis
  '3303071012990006',
  'Perum Permata A5 Wirasana Purbalingga, Jawa Tengah',
  'Jakarta', '1999-12-10', 'Lajang', 163, 72, 'Motor Pribadi',
  'Musyrif (Non-ITBA)', NULL, 5000000,
  'BSI', '9541934730', NULL, NULL,
  4500000, 'Aktif 31 August 2026 (THP BERSIH FULL)', 4115200, 384800, 184800, 200000,
  '2026-08-31', 'FULL', 'aktif',
  'https://drive.google.com/file/d/1pJUj7YhgPPo6RPPnnM-QhCqh-VimOHSY/view?usp=drive_link',
  'https://docs.google.com/document/d/1fOlWLWwBmwsw2PLFeuheheaA93NUK0rZb15D6b2nb-Y/edit?usp=sharing',
  'AW/LM/kem/21-22/Arsip SDM', 1
)
ON CONFLICT (nip) DO UPDATE SET
  nama_gelar=EXCLUDED.nama_gelar, email=EXCLUDED.email, no_hp=EXCLUDED.no_hp,
  status_aktivasi=EXCLUDED.status_aktivasi, tmt_aktif=EXCLUDED.tmt_aktif;

-- 2) Faqih Ahmad Rizki, B.A. — DIAJUKAN finance (konfirmasi: dipertimbangkan)
INSERT INTO employees (
  unit_id, cabang_id, nip, nama, nama_gelar, nama_ktp, email, no_hp, nik_ktp,
  alamat, tempat_lahir, tgl_lahir, status_kawin, tinggi_cm, berat_kg, transport,
  posisi_diajukan, mapel, gaji_diajukan,
  bank_utama, norek_utama, bank_lain, norek_lain,
  thp_kotor, konfirmasi, thp_bersih, total_tk_thr, tk, thr_bulan,
  tmt_aktif, mode_thp, status_aktivasi,
  cv_url, kesehatan_url, arsip_key, aktif
) VALUES (
  (SELECT id FROM units WHERE kode='SMP-SMA-AW3'),
  (SELECT id FROM cabangs WHERE kode='AW3'),
  '260002',
  'Faqih Ahmad Rizki, B.A.',
  'Faqih Ahmad Rizki, B.A.',   -- kanonis formulir; tabel aktivasi tertulis 'Rizky'
  'Faqih Ahmad Rizki',
  'faqih240297@gmail.com',
  '6285785027408',              -- wa.me/085785027408 -> kanonis
  '3216192402970003',
  'Perumahan Sukatani Permai Tapos Depok',
  'Bekasi', '1997-02-24', 'Menikah', 160, 74, 'Motor Pribadi',
  'Guru Mata Pelajaran', 'Diniyyah', 10000000,
  'BSI', '4949145900', 'BNI', '1362328679',
  6384800, 'Akan dipertimbangkan', 6000000, 384800, 184800, 200000,
  NULL, NULL, 'diajukan_finance',
  'https://drive.google.com/file/d/135b5FLwbaAv8cuc5DpBTjgsY769Lm337/view?usp=sharing',
  'https://docs.google.com/document/d/1jQSuPwx1J4_6bbe5sg4sUcK-LI9lfyBP2vJdD4g3Zfo/edit?usp=sharing',
  'AW/LM/kem/21-22/Arsip SDM', 0
)
ON CONFLICT (nip) DO UPDATE SET
  nama_gelar=EXCLUDED.nama_gelar, email=EXCLUDED.email, no_hp=EXCLUDED.no_hp,
  status_aktivasi=EXCLUDED.status_aktivasi;

-- Pendidikan
INSERT INTO pendidikan (employee_id, jenjang, perguruan_tinggi, prodi, ipk) VALUES
  ((SELECT id FROM employees WHERE nip='260001'),'S1','STAI Ali bin Abi Thalib SBY','Pendidikan Bahasa Arab',3.52),
  ((SELECT id FROM employees WHERE nip='260002'),'S1','Universitas Islam Madinah','Aqidah dan Dakwah',3.93)
ON CONFLICT (employee_id, jenjang) DO UPDATE SET
  perguruan_tinggi=EXCLUDED.perguruan_tinggi, prodi=EXCLUDED.prodi, ipk=EXCLUDED.ipk;

-- Pengalaman (maks 3)
INSERT INTO pengalaman (employee_id, urutan, deskripsi, salary) VALUES
  ((SELECT id FROM employees WHERE nip='260001'),1,'Koordinator Homebase SMA BPIBS',4550000),
  ((SELECT id FROM employees WHERE nip='260002'),1,'Musyrif dan Staff Guru',750000),
  ((SELECT id FROM employees WHERE nip='260002'),2,'Staff Guru dan Sekertaris',2500000),
  ((SELECT id FROM employees WHERE nip='260002'),3,'Wakil Kepala Sekolah dan Kesiswaan',500000)
ON CONFLICT (employee_id, urutan) DO UPDATE SET
  deskripsi=EXCLUDED.deskripsi, salary=EXCLUDED.salary;

-- Jejak aktivasi
INSERT INTO aktivasi_logs (employee_id, dari_status, ke_status, catatan) VALUES
  ((SELECT id FROM employees WHERE nip='260001'),'diverifikasi_doni','aktif','Aktif 31 August 2026 (THP BERSIH FULL) — finance input, Doni verifikasi, Kemal setuju'),
  ((SELECT id FROM employees WHERE nip='260002'),'draft','diajukan_finance','Akan dipertimbangkan — menunggu verifikasi Doni');

-- Sinkronkan sequence SERIAL setelah insert eksplisit (pola seed 2.0)
SELECT setval(pg_get_serial_sequence('cabangs','id'), (SELECT max(id) FROM cabangs));
SELECT setval(pg_get_serial_sequence('employees','id'), (SELECT max(id) FROM employees));
SELECT setval(pg_get_serial_sequence('pendidikan','id'), (SELECT max(id) FROM pendidikan));
SELECT setval(pg_get_serial_sequence('pengalaman','id'), (SELECT max(id) FROM pengalaman));
SELECT setval(pg_get_serial_sequence('aktivasi_logs','id'), (SELECT max(id) FROM aktivasi_logs));
