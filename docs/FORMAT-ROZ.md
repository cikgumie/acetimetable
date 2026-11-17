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

   **Matriks masa tidak tersedia** (dalam rekod subjek, guru, kelas, bilik): `bilHari × 32 × int32`, diindeks ikut nombor waktu.
   `4` = tersedia, `0` = tidak tersedia (tanda × dalam program asal), `6` = waktu tidak wujud.
3. **Gred** (bilangan didahului `int32`)
4. **Subjek**
5. **Guru** — rekod mengandungi semula nama pertama/nama akhir sebagai CString berasingan (digunakan untuk mengesan sempadan subjek/guru)
   Syarat guru (susunan medan dari rutin Serialize asal, dianalisis dengan Ghidra), bermula 9 bait sebelum
   pasangan `maksGapSeminggu, maksHari` yang terletak 17 bait selepas singkatan:
   `int32 gapOverride, int32 maksHariOn, int32 maksGapSeminggu, int32 maksHari, int32 ?, byte adaMatriks,
   [10 × 32 × int32 matriks], int32 maksBerturutan, int32 maksBerturutanOn, int32 ?, int32 maksGapSehari`.
   Had berturutan/gap guru hanya berkuat kuasa jika tetapan global yang sepadan dihidupkan dalam program asal.
6. **Kumpulan** — tiada singkatan: `CString nama, int32 seluruhKelas(0/1), int32 indeksPembahagian, …`
7. **Kelas** — selepas singkatan: `1 bait, int32 bilPembahagian, int32 n, n × int32 indeks kumpulan`
8. **Bilik**
9. **Pelajaran** (nama kosong) — selepas singkatan:
   ```
   11 bait, int32 (waktuSetiapKad − 1), int32 kadSeminggu, 5 bait, int32, int32,
   int32 indeksSubjek,
   int32 n, n × indeksKumpulan,
   int32 n, n × indeksGuru,
   int32 n, n × indeksBilik   (10001 = bilik kelas sendiri)
   ```
10. **Kad** (tanpa pengepala objek), disusun mengikut indeks pelajaran:
   ```
   int32 indeksPelajaran, int32 n, n × indeksBilik (-1 = tiada),
   int32 nomborWaktu (1-based), int32 (tempoh − 1), int32 0, int32 topengHari (bit0 = hari 1), int32 topengMinggu,
   00 FFFFFFFF, 28 × 00, int32 1, …
   ```
   Jika `int32` selepas `00 FFFFFFFF` kad sebelumnya bernilai 1, kad berikutnya menyimpan **indeks bilik
   yang ditetapkan** (cth. makmal untuk SC/KIM/BIO/FZ) di antara indeks pelajaran dan senarai:
   `lesson, room, n, senarai…`. Pembaca mengesan badan tetap kad (`waktu … 00 FFFFFFFF`) dan menyahkod ke belakang.
   Bait ke-59 dari awal badan kad = **kad berkunci** (1 = dikunci).
11. **Relasi** (selepas kad; pengepala objek biasa): `int32 5, CString keterangan, int32 n + n × indeksKelas,
   int32 n + n × indeksSubjek, int32 jenis`. Jenis yang dikenal pasti:

   | Kod | Maksud | Jadual Web |
   |---|---|---|
   | 1 | Tidak boleh pada hari sama | `tidakHariSama` |
   | 5 | Dua subjek mesti berturutan | `berturutan` |
   | 12 | Subjek untuk **kumpulan** kelas tersenarai mesti bermula serentak (dipadankan ikut tempoh kad yang sama; pelajaran seluruh kelas tidak terlibat) | `serentak` + `groupsOnly` |
   | 13 | Subjek mesti pada masa sama dalam semua kelas dipilih | `serentak` |
   | 14 | Subjek mesti pada waktu sama setiap hari | `waktuSama` |

## Pengesahan

| Fail | Kad dibaca | Pertembungan guru/kelas |
|---|---|---|
| v702 `.rox` (modul ganti) | 667 | 0 |
| v802 `.roz` / `.ziptt` | 677 daripada 678 (semua kelas penuh) | 0 |

Sifar pertembungan dalam jadual siap ialah bukti kukuh bahawa indeks pelajaran, kumpulan, guru, hari dan waktu dinyahkod dengan betul.
Kedudukan, tempoh kad dan tanda × juga dibandingkan dengan tangkapan skrin program asal bagi fail yang sama dan didapati sepadan.

## Belum dinyahkod

Jenis relasi lain, tetapan global penjana, had min/maks waktu sehari guru & kelas, murid & pilihan subjek, reka bentuk cetakan,
dan format lama (< v600). Untuk fail versi lain, eksport XML dari aplikasi asal dan import XML.
