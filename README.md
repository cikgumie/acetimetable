# Jadual Web

Penyusun jadual waktu sekolah berasaskan web — berjalan sepenuhnya dalam pelayar, sesuai dihoskan di **GitHub Pages**.
Tiada pelayan, tiada pangkalan data: semua data disimpan dalam pelayar pengguna (localStorage) dan boleh disimpan sebagai fail JSON.

## Ciri

- **Data**: sekolah, hari, waktu (masa mula/tamat), subjek, guru, kelas (dengan kumpulan/pembahagian), bilik.
- **Pelajaran**: subjek + kelas/kumpulan (termasuk kelas gabungan) + guru + bilik, kad seminggu × tempoh (waktu berkembar).
- **Masa tidak tersedia** untuk guru, kelas, bilik dan subjek.
- **Penjana automatik** (Web Worker): letak semua kad tanpa pertembungan guru, kelas/kumpulan dan bilik; hormati kad berkunci.
- **Susun manual**: seret & lepas kad, sorotan sel sah/tidak sah, amaran pertembungan, kunci kad.
- **Paparan**: jadual setiap kelas/guru/bilik, dan gambaran "semua kelas/guru/bilik".
- **Guru ganti (relief)**: pilih tarikh & guru tidak hadir, cadangan guru lapang ikut beban, agih automatik, cetak slip.
- **Cetak / PDF**: satu halaman A4 landskap setiap jadual.
- **Import**: fail aSc TimeTables `.roz` / `.rox` / sandaran `.ziptt` (diuji pada versi fail 702 & 802), XML `<timetable>`, JSON.
- **Eksport**: JSON (fail projek), XML `<timetable>`, CSV (Excel).

## Jalankan secara setempat

Modul ES memerlukan pelayan HTTP (bukan `file://`):

```bash
python -m http.server 8000
```

Kemudian buka <http://localhost:8000>.

## Hos di GitHub Pages

1. Cipta repositori baharu di GitHub (cth. `jadual-web`).
2. Tolak kod ini ke cawangan `main`.
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pilih `main` / `(root)`.
4. Laman akan tersedia di `https://<nama-pengguna>.github.io/jadual-web/`.

## Struktur

```
index.html            antara muka
css/app.css           gaya (tema cerah/gelap, cetakan)
js/app.js             paparan & interaksi
js/model.js           model data, pertembungan, storan
js/io.js              import/eksport (roz, XML, JSON, CSV)
js/roz.js             pembaca format .roz/.rox (lihat docs/FORMAT-ROZ.md)
js/zip.js             pembaca ZIP kecil (DecompressionStream)
js/solver.js          algoritma penjana
js/generator-worker.js
```

## Nota

Projek ini ialah pelaksanaan bebas dan tidak bergabung dengan mana-mana pengeluar perisian jadual komersial.
Pembaca `.roz` dibina melalui kejuruteraan balik format fail untuk tujuan kebolehoperasian (membaca data sekolah sendiri);
tiada kod, grafik atau aset perisian asal digunakan. **Jangan muat naik fail jadual sekolah sebenar ke repositori awam.**
