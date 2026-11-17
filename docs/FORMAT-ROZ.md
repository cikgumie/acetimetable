# Nota format fail `.roz` / `.rox` / `.ziptt`

Nota kejuruteraan balik untuk **kebolehoperasian** (membaca data jadual sendiri ke dalam Jadual Web).
Hasil daripada analisis `roz.exe` (Win32 x86, MFC, dipaut statik — disahkan melalui jadual import PE) dan perbandingan
bait demi bait fail versi **702** dan **802**. Tiada kod asal disalin; pembaca dalam `js/roz.js` ditulis semula sepenuhnya.

## Bekas fail

| Sambungan | Isi |
|---|---|
| `.roz` / `.rox` | Aliran bersiri MFC `CArchive` (little-endian) |
| `.ziptt` | ZIP (deflate) mengandungi `tt.roz` — sandaran automatik dalam folder `backup` |
| `.zipsubst` | ZIP mengandungi `main.spl` (modul ganti) + salinan `.rox` |

## Kepala

```
int32   versi format        (cth. 0x2BE = 702, 0x322 = 802)
CString "ASCTT"
...
```

`CString` = 1 bait panjang (0xFF → u16 menyusul) + teks Windows-1252.

## Pengepala objek

Setiap entiti (waktu, gred, subjek, guru, kumpulan, kelas, bilik, pelajaran) mempunyai pengepala tetap:

```
[warna R G B]  02000000 02000000 0200 0100  [id 8 bait]  [7 bait]  [flag 1 bait]  CString nama  CString singkatan  ...
```

Kelas menyisipkan penanda `CString "CLASSTT"` sebelum nama dan berakhir dengan `"CLASSTT_END"`.

## Turutan bahagian (v702/v802)

1. Objek tetapan hari/minggu (13 objek)
2. **Waktu**: `int32 nombor, 3 bait, CString nama, CString singkatan, int32 jamMula, minitMula, jamTamat, minitTamat`, diikuti matriks ketersediaan besar
3. **Gred** (bilangan didahului `int32`)
4. **Subjek**
5. **Guru** — rekod mengandungi semula nama pertama/nama akhir sebagai CString berasingan (digunakan untuk mengesan sempadan subjek/guru)
6. **Kumpulan** — tiada singkatan: `CString nama, int32 seluruhKelas(0/1), int32 indeksPembahagian, …`
7. **Kelas** — selepas singkatan: `1 bait, int32 bilPembahagian, int32 n, n × int32 indeks kumpulan`
8. **Bilik**
9. **Pelajaran** (nama kosong) — selepas singkatan:
   ```
   11 bait, int32 waktuSetiapKad, int32 kadSeminggu, 5 bait, int32, int32,
   int32 indeksSubjek,
   int32 n, n × indeksKumpulan,
   int32 n, n × indeksGuru,
   int32 n, n × indeksBilik   (10001 = bilik kelas sendiri)
   ```
10. **Kad** (tanpa pengepala objek), disusun mengikut indeks pelajaran:
   ```
   int32 indeksPelajaran, int32 n, n × indeksBilik (-1 = tiada),
   int32 waktu (0-based), int32 tempoh, int32 0, int32 topengHari (bit0 = hari 1), int32 topengMinggu,
   00 FFFFFFFF, 28 × 00, int32 1, …
   ```
   Sesetengah kad membawa data tambahan berpanjangan berubah, jadi pembaca mencari "ekor" tetap rekod dan
   menyahkod ke belakang.

## Pengesahan

| Fail | Kad dibaca | Pertembungan guru/kelas |
|---|---|---|
| v702 `.rox` (modul ganti) | 667 | 0 |
| v802 `.ziptt` (sandaran) | 608 | 0 |

Sifar pertembungan dalam jadual siap ialah bukti kukuh bahawa indeks pelajaran, kumpulan, guru, hari dan waktu dinyahkod dengan betul.

## Belum dinyahkod

Kekangan lanjutan, matriks ketersediaan (masa tidak tersedia), murid & pilihan subjek, reka bentuk cetakan,
dan format lama (< v600). Untuk fail versi lain, eksport XML dari aplikasi asal dan import XML.
