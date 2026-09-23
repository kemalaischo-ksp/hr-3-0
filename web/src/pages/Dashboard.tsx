import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, STATUS_BADGE, STATUS_LABEL } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/tabs";
import { api, bisa, type Dokumen, type Employee, type Pengumuman, type PresensiSaya, type Profil, type SessionUser } from "../lib/api";
import { masaKerja, rupiah, tglISOtoID } from "../lib/format";

export function Dashboard() {
  const [data, setData] = useState<Employee[] | null>(null);
  const [me, setMe] = useState<SessionUser | null>(null);
  const [pres, setPres] = useState<PresensiSaya | null>(null);
  const [mum, setMum] = useState<Pengumuman[]>([]);
  const [dokExp, setDokExp] = useState<(Dokumen & { nip?: string; nama_gelar?: string })[]>([]);
  const [profil, setProfil] = useState<Profil | null>(null);

  useEffect(() => {
    api.employees().then(setData);
    api.pengumuman().then(setMum).catch(() => {});
    api.me().then((m) => {
      setMe(m);
      if (m.role === "pegawai") {
        api.profilSaya().then(setProfil).catch(() => {});
        api.presensiSaya().then(setPres).catch(() => {});
      } else {
        if (bisa(m, "presensi.mandiri") && !bisa(m, "absensi.kelola"))
          api.presensiSaya().then(setPres).catch(() => {});
      }
      if (bisa(m, "karyawan.kelola"))
        api.dokumenKedaluwarsa().then(setDokExp).catch(() => {});
    }).catch(() => {});
  }, []);

  if (!data)
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );

  const aktif = data.filter((e) => e.status_aktivasi === "aktif");
  const pending = data.filter((e) => e.status_aktivasi !== "aktif");
  const totalThp = aktif.reduce((s, e) => s + e.thp_bersih, 0);

  return (
    <div className="grid gap-5">
      <div>
        <p className="text-xs text-muted-foreground">HRIS · <b className="text-foreground">AW3 BSD City</b></p>
        <h1 className="font-display text-2xl font-bold">{me?.role === "pegawai" ? "Dashboard saya" : "Dashboard cabang"}</h1>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: "Karyawan aktif", value: String(aktif.length), icon: "👥", tint: "bg-[#fce8f5] text-primary" },
          { label: "Menunggu aktivasi", value: String(pending.length), icon: "⏳", tint: "bg-[#e3f0ff] text-info" },
          { label: "Total THP bersih aktif", value: rupiah(totalThp), icon: "💰", tint: "bg-[#e6faf4] text-success", small: true },
        ].map((s) => (
          <Card key={s.label} className="wd-card">
            <CardContent className="flex items-center gap-4 py-5">
              <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-full text-xl ${s.tint}`}>{s.icon}</div>
              <div className="min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">{s.label}</p>
                <p className={`tnum truncate font-bold text-foreground ${s.small ? "text-xl" : "text-3xl"}`}>{s.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {me?.role === "pegawai" && profil ? (
        <Card className="wd-card">
          <CardContent className="flex flex-wrap items-center gap-4 py-4">
            {profil.foto_url ? (
              <img src={profil.foto_url} alt="Foto profil" className="h-14 w-14 rounded-full border border-border object-cover" />
            ) : (
              <div className="grid h-14 w-14 place-items-center rounded-full bg-primary text-xl font-bold text-white">
                {(profil.nama_gelar || "?").slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{profil.nama_gelar}</p>
              <p className="text-xs text-muted-foreground">
                {profil.posisi_diajukan || profil.jabatan || "–"} · {profil.unit || "–"} · Masuk {tglISOtoID(profil.tgl_masuk ?? profil.tmt_aktif)} ({masaKerja(profil.tgl_masuk ?? profil.tmt_aktif)})
              </p>
            </div>
            <Badge variant={profil.status_kerja === "aktif" ? "success" : "muted"}>{profil.status_kerja ?? "aktif"}</Badge>
            <Link to="/profil"><Button size="sm" variant="secondary">Lihat profil</Button></Link>
            {bisa(me, "slip.lihat") ? <Link to={`/slip/${profil.nip}`}><Button size="sm">Slip saya</Button></Link> : null}
          </CardContent>
        </Card>
      ) : null}
      {mum.length > 0 ? (
        <Card className="wd-card">
          <CardHeader><CardTitle>Pengumuman</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            {mum.slice(0, 3).map((m) => (
              <div key={m.id} className="rounded-md border border-border px-4 py-3">
                <p className="text-sm font-semibold">{m.judul}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{m.isi}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      {dokExp.length > 0 ? (
        <Card className="wd-card">
          <CardHeader>
            <CardTitle>Dokumen segera kedaluwarsa</CardTitle>
            <CardDescription>{dokExp.length} dokumen kedaluwarsa ≤ 60 hari</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {dokExp.slice(0, 5).map((d) => (
              <div key={d.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1">{d.nama_gelar} · {d.judul} ({d.jenis})</span>
                <Badge variant="warning" className="tnum">{tglISOtoID(d.kedaluwarsa)}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      {me && bisa(me, "presensi.mandiri") && !bisa(me, "absensi.kelola") ? (
        <Card className="wd-card">
          <CardContent className="flex flex-wrap items-center gap-4 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                Presensi hari ini · {tglISOtoID(pres?.tanggal ?? null)}
              </p>
              <p className="text-xs text-muted-foreground">
                {!pres
                  ? "Memuat status…"
                  : pres.hari_ini?.check_out
                    ? `Selesai (masuk ${pres.hari_ini.check_in ? new Date(pres.hari_ini.check_in).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "–"})`
                    : pres.hari_ini?.check_in
                      ? "Sudah check-in — jangan lupa check-out."
                      : "Belum presensi hari ini."}
              </p>
            </div>
            {pres?.hari_ini?.check_in ? <Badge variant="success">sudah masuk</Badge> : <Badge variant="muted">belum presensi</Badge>}
            <Link to="/presensi"><Button size="sm">Buka presensi</Button></Link>
          </CardContent>
        </Card>
      ) : null}
      <Card className="wd-card">
        <CardHeader>
          <CardTitle>Perlu perhatian</CardTitle>
          <CardDescription>Pengajuan aktivasi yang belum selesai</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">Semua karyawan sudah aktif. 🎉</p>
          ) : (
            pending.map((e) => (
              <Link
                key={e.nip}
                to={`/karyawan/${e.nip}`}
                className="flex items-center gap-3 rounded-md border border-border px-4 py-3 transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{e.nama_gelar}</p>
                  <p className="text-xs text-muted-foreground tnum">NIP {e.nip} · {e.posisi_diajukan}</p>
                </div>
                <Badge variant={STATUS_BADGE[e.status_aktivasi]}>{STATUS_LABEL[e.status_aktivasi]}</Badge>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
