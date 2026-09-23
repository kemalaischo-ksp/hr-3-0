import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge, STATUS_BADGE, STATUS_LABEL } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Field, Input, Select } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Skeleton } from "../components/ui/tabs";
import { toast } from "../components/ui/toaster";
import { api, bisa, type Employee, type SessionUser } from "../lib/api";
import { rupiah } from "../lib/format";

const F_AWAL = {
  nama_gelar: "", email: "", no_hp: "", posisi_diajukan: "", mapel: "",
  unit_id: "", nip: "", nik_ktp: "", alamat: "", tempat_lahir: "", tgl_lahir: "",
  status_kawin: "", transport: "", gaji_diajukan: "", bank_utama: "BSI",
  norek_utama: "", bank_lain: "", norek_lain: "",
};

export function KaryawanList() {
  const nav = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<Employee[] | null>(null);
  const [me, setMe] = useState<SessionUser | null>(null);
  const [q, setQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [units, setUnits] = useState<{ id: number; nama: string; kode: string }[]>([]);
  const [f, setF] = useState(F_AWAL);
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [arsipNama, setArsipNama] = useState<string | null>(null);
  const [cvLink, setCvLink] = useState<string | null>(null);
  const [pend, setPend] = useState({ pt: "", prodi: "", ipk: "" });
  const [peng, setPeng] = useState({ p1: "", s1: "", p2: "", s2: "", p3: "", s3: "" });
  const [peringatan, setPeringatan] = useState<string[]>([]);

  const muat = () => api.employees().then(setData).catch((e) => toast(e.message));
  useEffect(() => {
    api.me().then(setMe).catch(() => {});
    muat();
  }, []); // eslint-disable-line

  const bolehTambah = bisa(me, "karyawan.tambah");

  const bukaForm = () => {
    api.units().then(setUnits).catch(() => setUnits([]));
    setShowForm(true);
  };

  const cocokUnit = (nama: string, daftar: { id: number; nama: string }[]) => {
    const n = nama.toLowerCase().replace(/[^a-z]/g, "");
    return daftar.find((u) => {
      const m = u.nama.toLowerCase().replace(/[^a-z]/g, "");
      return m === n || m.includes(n) || n.includes(m);
    })?.id;
  };

  const uploadPDF = async (file: File) => {
    setParsing(true);
    try {
      const r = await api.parseSDM(file);
      const d = r.data as Record<string, string | number | null>;
      const daftar = units.length ? units : await api.units().catch(() => []);
      if (!units.length && daftar.length) setUnits(daftar);
      const uid = d.unit_nama ? cocokUnit(String(d.unit_nama), daftar) : undefined;
      setF({
        ...F_AWAL,
        nama_gelar: String(d.nama_gelar ?? ""),
        email: String(d.email ?? ""),
        no_hp: String(d.no_hp ?? ""),
        posisi_diajukan: String(d.posisi_diajukan ?? ""),
        mapel: String(d.mapel ?? ""),
        unit_id: uid ? String(uid) : "",
        nik_ktp: String(d.nik_ktp ?? ""),
        alamat: String(d.alamat ?? ""),
        tempat_lahir: String(d.tempat_lahir ?? ""),
        tgl_lahir: String(d.tgl_lahir ?? ""),
        status_kawin: String(d.status_kawin ?? ""),
        transport: String(d.transport ?? ""),
        gaji_diajukan: d.gaji_diajukan != null ? String(d.gaji_diajukan) : "",
        bank_utama: String(d.bank_utama ?? "BSI"),
        norek_utama: String(d.norek_utama ?? ""),
        bank_lain: String(d.bank_lain ?? ""),
        norek_lain: String(d.norek_lain ?? ""),
      });
      const pd = (d.pendidikan ?? null) as { perguruan_tinggi?: string; prodi?: string; ipk?: number } | null;
      if (pd) setPend({ pt: pd.perguruan_tinggi ?? "", prodi: pd.prodi ?? "", ipk: pd.ipk != null ? String(pd.ipk) : "" });
      const pg = (Array.isArray(d.pengalaman) ? d.pengalaman : []) as { deskripsi?: string; salary?: number }[];
      setPeng({
        p1: pg[0]?.deskripsi ?? "", s1: pg[0]?.salary != null ? String(pg[0].salary) : "",
        p2: pg[1]?.deskripsi ?? "", s2: pg[1]?.salary != null ? String(pg[1].salary) : "",
        p3: pg[2]?.deskripsi ?? "", s3: pg[2]?.salary != null ? String(pg[2].salary) : "",
      });
      setArsipNama(r.arsip_nama);
      setCvLink(typeof d.cv_link === "string" ? d.cv_link : null);
      setPeringatan(r.warnings);
      toast(r.warnings.length ? `Terbaca dgn ${r.warnings.length} peringatan — verifikasi dulu` : "PDF terbaca — verifikasi sebelum simpan");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal membaca PDF");
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const simpan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.nama_gelar.trim() || !f.unit_id) {
      toast("Nama dan unit wajib diisi");
      return;
    }
    setSaving(true);
    try {
      const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
      const pengalaman = [
        { deskripsi: peng.p1.trim() || undefined, salary: num(peng.s1) },
        { deskripsi: peng.p2.trim() || undefined, salary: num(peng.s2) },
        { deskripsi: peng.p3.trim() || undefined, salary: num(peng.s3) },
      ].filter((p) => p.deskripsi || p.salary != null);
      const r = await api.createEmployee({
        nama_gelar: f.nama_gelar.trim(),
        unit_id: Number(f.unit_id),
        email: f.email.trim() || undefined,
        no_hp: f.no_hp.trim() || undefined,
        posisi_diajukan: f.posisi_diajukan.trim() || undefined,
        mapel: f.mapel.trim() || undefined,
        nip: f.nip.trim() || undefined,
        nik_ktp: f.nik_ktp.trim() || undefined,
        alamat: f.alamat.trim() || undefined,
        tempat_lahir: f.tempat_lahir.trim() || undefined,
        tgl_lahir: f.tgl_lahir.trim() || undefined,
        status_kawin: f.status_kawin || undefined,
        transport: f.transport.trim() || undefined,
        gaji_diajukan: num(f.gaji_diajukan),
        bank_utama: f.bank_utama.trim() || undefined,
        norek_utama: f.norek_utama.trim() || undefined,
        bank_lain: f.bank_lain.trim() || undefined,
        norek_lain: f.norek_lain.trim() || undefined,
        cv_url: cvLink || undefined,
        arsip_nama: arsipNama || undefined,
        pendidikan: pend.pt.trim() || pend.prodi.trim()
          ? { perguruan_tinggi: pend.pt.trim() || undefined, prodi: pend.prodi.trim() || undefined, ipk: num(pend.ipk) }
          : undefined,
        pengalaman: pengalaman.length ? pengalaman : undefined,
      });
      toast(`Karyawan ditambah (NIP ${r.nip})`);
      setShowForm(false);
      setF(F_AWAL);
      setPend({ pt: "", prodi: "", ipk: "" });
      setPeng({ p1: "", s1: "", p2: "", s2: "", p3: "", s3: "" });
      setArsipNama(null);
      setCvLink(null);
      setPeringatan([]);
      nav(`/karyawan/${r.nip}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menambah karyawan");
    } finally {
      setSaving(false);
    }
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    if (!s) return data;
    return data.filter((e) => `${e.nama_gelar} ${e.nip} ${e.posisi_diajukan}`.toLowerCase().includes(s));
  }, [data, q]);

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <p className="text-xs text-muted-foreground">HRIS · <b className="text-foreground">Daftar karyawan</b></p>
          <h1 className="font-display text-2xl font-bold">Karyawan AW3</h1>
        </div>
        <Input placeholder="Cari nama / NIP / posisi…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        {bolehTambah ? (
          <Button variant="secondary" onClick={bukaForm}>+ Tambah karyawan</Button>
        ) : null}
      </div>

      {showForm && bolehTambah ? (
        <Card className="wd-card border-primary/40">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
            <CardTitle className="text-base">Tambah karyawan baru</CardTitle>
            <div className="flex items-center gap-2">
              <input
                ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden"
                onChange={(e) => { const fl = e.target.files?.[0]; if (fl) uploadPDF(fl); }}
              />
              <Button type="button" variant="outline" size="sm" disabled={parsing} onClick={() => fileRef.current?.click()}>
                {parsing ? "Membaca PDF…" : "Upload PDF SDM"}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {peringatan.length > 0 ? (
              <div className="mt-4 rounded-md border border-warning/40 bg-[#fff8ec] px-3 py-2 text-xs text-foreground">
                <p className="font-bold">Verifikasi sebelum simpan:</p>
                <ul className="list-disc pl-4">{peringatan.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            ) : null}
            <form onSubmit={simpan} className="grid gap-4 pt-4 md:grid-cols-2">
              <Field label="Nama lengkap + gelar *">
                <Input value={f.nama_gelar} onChange={(e) => setF({ ...f, nama_gelar: e.target.value })} placeholder="cth. Ahmad Hidayat, S.Pd." required />
              </Field>
              <Field label="Unit *">
                <Select value={f.unit_id} onChange={(e) => setF({ ...f, unit_id: e.target.value })} required>
                  <option value="">— Pilih unit —</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>{u.nama} ({u.kode})</option>
                  ))}
                </Select>
              </Field>
              <Field label="Posisi diajukan">
                <Input value={f.posisi_diajukan} onChange={(e) => setF({ ...f, posisi_diajukan: e.target.value })} placeholder="cth. Guru Mata Pelajaran" />
              </Field>
              <Field label="Mapel (opsional)">
                <Input value={f.mapel} onChange={(e) => setF({ ...f, mapel: e.target.value })} placeholder="cth. Diniyyah" />
              </Field>
              <Field label="Email">
                <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="nama@alwildan.sch.id" />
              </Field>
              <Field label="No HP" hint="Format 628… tanpa +">
                <Input value={f.no_hp} onChange={(e) => setF({ ...f, no_hp: e.target.value })} placeholder="628…" />
              </Field>
              <Field label="NIK KTP" hint="Sensitif — tersimpan, tak ditampilkan di daftar">
                <Input value={f.nik_ktp} onChange={(e) => setF({ ...f, nik_ktp: e.target.value })} placeholder="16 digit" maxLength={16} />
              </Field>
              <Field label="Tanggal lahir">
                <Input type="date" value={f.tgl_lahir} onChange={(e) => setF({ ...f, tgl_lahir: e.target.value })} />
              </Field>
              <Field label="Alamat domisili">
                <Input value={f.alamat} onChange={(e) => setF({ ...f, alamat: e.target.value })} />
              </Field>
              <Field label="Tempat lahir">
                <Input value={f.tempat_lahir} onChange={(e) => setF({ ...f, tempat_lahir: e.target.value })} />
              </Field>
              <Field label="Status kawin">
                <Select value={f.status_kawin} onChange={(e) => setF({ ...f, status_kawin: e.target.value })}>
                  <option value="">—</option>
                  {["Lajang", "Menikah", "Janda", "Duda"].map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </Field>
              <Field label="Transport">
                <Input value={f.transport} onChange={(e) => setF({ ...f, transport: e.target.value })} />
              </Field>
              <Field label="Gaji diajukan (Rp)">
                <Input inputMode="numeric" value={f.gaji_diajukan} onChange={(e) => setF({ ...f, gaji_diajukan: e.target.value.replace(/[^0-9]/g, "") })} placeholder="cth. 10000000" />
              </Field>
              <Field label="NIP manual (opsional)" hint="Kosongkan = otomatis">
                <Input value={f.nip} onChange={(e) => setF({ ...f, nip: e.target.value })} placeholder="Otomatis" />
              </Field>
              <Field label="Bank utama">
                <Input value={f.bank_utama} onChange={(e) => setF({ ...f, bank_utama: e.target.value })} placeholder="BSI" />
              </Field>
              <Field label="Norek utama" hint="Sensitif — tersimpan, tak ditampilkan">
                <Input value={f.norek_utama} onChange={(e) => setF({ ...f, norek_utama: e.target.value.replace(/[^0-9]/g, "") })} />
              </Field>
              <Field label="Bank lain">
                <Input value={f.bank_lain} onChange={(e) => setF({ ...f, bank_lain: e.target.value })} placeholder="BNI" />
              </Field>
              <Field label="Norek lain">
                <Input value={f.norek_lain} onChange={(e) => setF({ ...f, norek_lain: e.target.value.replace(/[^0-9]/g, "") })} />
              </Field>
              <Field label="Pendidikan S1 — PT">
                <Input value={pend.pt} onChange={(e) => setPend({ ...pend, pt: e.target.value })} />
              </Field>
              <Field label="Pendidikan S1 — Prodi / IPK">
                <div className="flex gap-2">
                  <Input value={pend.prodi} onChange={(e) => setPend({ ...pend, prodi: e.target.value })} placeholder="Prodi" />
                  <Input value={pend.ipk} onChange={(e) => setPend({ ...pend, ipk: e.target.value.replace(/[^0-9.]/g, "") })} placeholder="IPK" className="max-w-24" />
                </div>
              </Field>
              {[1, 2, 3].map((n) => (
                <Field key={n} label={`Pengalaman ${n}`}>
                  <div className="flex gap-2">
                    <Input
                      value={peng[`p${n}` as "p1"]} onChange={(e) => setPeng({ ...peng, [`p${n}`]: e.target.value })}
                      placeholder="Deskripsi" />
                    <Input
                      value={peng[`s${n}` as "s1"]} onChange={(e) => setPeng({ ...peng, [`s${n}`]: e.target.value.replace(/[^0-9]/g, "") })}
                      placeholder="Salary" className="max-w-32" />
                  </div>
                </Field>
              ))}
              {cvLink ? <p className="text-xs text-muted-foreground md:col-span-2">Link CV terdeteksi: <span className="break-all text-primary">{cvLink}</span></p> : null}
              {arsipNama ? <p className="text-xs text-muted-foreground md:col-span-2">PDF sumber tersimpan sebagai arsip dan akan dilampirkan otomatis.</p> : null}
              <div className="flex items-end gap-2 md:col-span-2">
                <Button type="submit" disabled={saving}>{saving ? "Menyimpan…" : "Simpan (status draft)"}</Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Batal</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card className="wd-card overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border pb-4"><CardTitle className="text-base">{rows.length} karyawan</CardTitle><span className="text-xs uppercase tracking-[.14em] text-muted-foreground">Table list</span></CardHeader>
        <CardContent>
          {!data ? (
            <div className="grid gap-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>NIP</TableHead>
                  <TableHead>Nama</TableHead>
                  <TableHead>Posisi</TableHead>
                  <TableHead>THP bersih</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.nip}>
                    <TableCell className="tnum font-medium">{e.nip}</TableCell>
                    <TableCell>
                      <Link to={`/karyawan/${e.nip}`} className="font-semibold text-primary hover:underline">
                        {e.nama_gelar}
                      </Link>
                      <p className="text-xs text-muted-foreground">{e.email}</p>
                    </TableCell>
                    <TableCell>{e.posisi_diajukan}{e.mapel ? ` · ${e.mapel}` : ""}</TableCell>
                    <TableCell className="tnum">{rupiah(e.thp_bersih)}</TableCell>
                    <TableCell><Badge variant={STATUS_BADGE[e.status_aktivasi]}>{STATUS_LABEL[e.status_aktivasi]}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
