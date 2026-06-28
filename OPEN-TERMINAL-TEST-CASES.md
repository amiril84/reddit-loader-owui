# Open Terminal — Manual Test Cases dan Use Cases

## Kondisi Deployment

- Nama koneksi Open WebUI: `VPS Open Terminal`
- Runtime: container Docker terisolasi
- Working directory persisten: `/home/user`
- Network: internal Docker network `owui-net`
- Public port: tidak ada
- Access Control: `Private`, tanpa grant tambahan
- Native tool calling: terverifikasi bekerja dengan model `deepseek-v4-flash`

## Hasil Validasi Produksi

Validasi terakhir dilakukan pada 28 Juni 2026:

- health internal: `{"status":"ok"}`;
- API key aktif: HTTP `200`;
- API key salah: HTTP `401`;
- persistensi file setelah restart: lulus;
- public host port: tidak ada;
- HTTPS Open WebUI: HTTP `200`;
- eksekusi `cat /etc/os-release` melalui chat: lulus;
- hasil aktual: `Debian GNU/Linux 13 (trixie)`.

## Cara Mengaktifkan pada Chat

1. Login menggunakan akun admin.
2. Buat chat baru.
3. Klik ikon terminal berbentuk cloud di area input.
4. Pada bagian **System**, pilih **VPS Open Terminal**.
5. Pastikan nama `VPS Open Terminal` muncul di samping ikon sebelum mengirim prompt.

## Test Cases

### TC-01 — Eksekusi Perintah Dasar

**Prompt**

```text
Gunakan VPS Open Terminal untuk menjalankan cat /etc/os-release. Laporkan PRETTY_NAME persis dari output perintah.
```

**Hasil yang diharapkan**

- Model menampilkan aktivitas `run_command`.
- Jawaban memuat `Debian GNU/Linux 13 (trixie)`.
- Tidak ada pesan unauthorized atau invalid API key.

### TC-02 — Informasi Environment

**Prompt**

```text
Gunakan terminal untuk menampilkan current user, working directory, versi Python, dan versi Node.js. Jangan menebak; jalankan perintahnya.
```

**Hasil yang diharapkan**

- Model benar-benar menggunakan terminal.
- Working directory berada di lingkungan container.
- Informasi versi diambil dari output perintah.

### TC-03 — Eksekusi Python

**Prompt**

```text
Buat skrip Python yang mencari semua bilangan prima dari 1 sampai 100, jalankan, lalu tampilkan hasil dan lokasi file skrip.
```

**Hasil yang diharapkan**

- File Python dibuat di `/home/user` atau subdirektorinya.
- Skrip berhasil dijalankan.
- Hasil dimulai dengan `2, 3, 5, 7` dan berakhir dengan `97`.

### TC-04 — Persistensi File

**Prompt pertama**

```text
Buat file /home/user/manual-persistence-test.txt berisi teks OPEN_TERMINAL_PERSISTENCE_OK dan tampilkan isinya.
```

Setelah administrator me-restart container Open Terminal, jalankan:

```text
Baca /home/user/manual-persistence-test.txt dan laporkan isinya tanpa mengubah file.
```

**Hasil yang diharapkan**

- Isi file tetap tersedia setelah restart.
- Nilainya tetap `OPEN_TERMINAL_PERSISTENCE_OK`.

### TC-05 — Analisis CSV

Buat atau unggah CSV kecil yang berisi kolom `tanggal`, `produk`, `jumlah`, dan `harga`.

**Prompt**

```text
Gunakan Python melalui terminal untuk memeriksa CSV ini. Hitung total nilai per produk, cari data kosong atau duplikat, lalu buat summary.csv.
```

**Hasil yang diharapkan**

- Model membaca file menggunakan terminal.
- Perhitungan dapat dicocokkan dengan data sumber.
- `summary.csv` dapat ditemukan melalui file browser Open Terminal.

### TC-06 — Analisis Log

**Prompt**

```text
Buat contoh application.log berisi request sukses dan error, lalu gunakan shell atau Python untuk menghitung jumlah status 2xx, 4xx, dan 5xx. Tampilkan command yang dipakai.
```

**Hasil yang diharapkan**

- File log dibuat dalam volume terminal.
- Jumlah setiap kategori sesuai isi file.
- Model menjelaskan command atau skrip yang digunakan.

### TC-07 — Pembuatan Artefak

**Prompt**

```text
Buat laporan Markdown berisi ringkasan environment, tabel versi tool, dan waktu pemeriksaan. Simpan sebagai /home/user/environment-report.md.
```

**Hasil yang diharapkan**

- File Markdown berhasil dibuat.
- File terlihat melalui file browser.
- Informasi dalam file berasal dari hasil perintah terminal.

### TC-08 — Workflow Pengembangan

**Prompt**

```text
Buat proyek HTML sederhana berisi index.html, styles.css, dan script.js untuk daftar tugas lokal. Periksa syntax JavaScript dan jelaskan struktur file.
```

**Hasil yang diharapkan**

- Ketiga file dibuat dalam satu direktori proyek.
- Pemeriksaan syntax berhasil atau error dijelaskan dan diperbaiki.
- Tidak ada file host VPS yang disentuh.

### TC-09 — Penanganan Error

**Prompt**

```text
Jalankan perintah untuk membaca /home/user/file-yang-tidak-ada.txt. Jelaskan error yang sebenarnya tanpa membuat file tersebut.
```

**Hasil yang diharapkan**

- Tool call gagal secara terkontrol.
- Model menjelaskan bahwa file tidak ada.
- Model tidak mengarang isi file.

### TC-10 — Isolasi Filesystem

**Prompt**

```text
Tampilkan filesystem dan mount yang dapat diakses dari terminal. Jangan mengubah file. Jelaskan apakah ini host VPS atau container terisolasi.
```

**Hasil yang diharapkan**

- Model mengidentifikasi lingkungan sebagai container.
- Volume persisten tersedia di `/home/user`.
- Direktori deployment host `/opt/owui-stack` tidak tersedia sebagai mount.

### TC-11 — Pembatasan Pengguna

1. Login menggunakan akun non-admin.
2. Buat chat baru dan buka menu terminal/cloud.

**Hasil yang diharapkan**

- Koneksi private `VPS Open Terminal` tidak dapat dipilih oleh pengguna yang tidak memperoleh grant.
- Jika koneksi terlihat atau dapat dipakai, hentikan penggunaan dan periksa kembali Access Control.

### TC-12 — Tidak Ada Port Publik

Dari komputer lokal, jalankan koneksi ke port 8000 pada IP VPS.

**Hasil yang diharapkan**

- Port 8000 tidak dapat diakses dari internet.
- Open WebUI tetap dapat menjangkau `http://open-terminal:8000` melalui network Docker internal.

### TC-13 — Wrong API Key

Tes ini hanya untuk administrator melalui shell VPS. Kirim request internal tanpa key atau dengan key salah ke endpoint `/files/list`.

**Hasil yang diharapkan**

- Request tanpa key mendapat HTTP `401`.
- Request dengan key salah mendapat HTTP `401`.
- Request dengan key aktif mendapat HTTP `200`.
- Jangan mencetak key aktif ke history atau log.

### TC-14 — Regresi Open WebUI

Setelah memakai terminal, uji kembali:

- chat biasa tanpa terminal;
- web search melalui SearXNG;
- pemuatan Reddit/Threads;
- login/logout;
- akses HTTPS ke `chat.amirlabs.id`.

**Hasil yang diharapkan**

- Semua fungsi lama tetap bekerja.
- HTTPS mengembalikan HTTP `200`.
- Container lama tetap running dan container yang memiliki healthcheck tetap healthy.

## Use Cases yang Direkomendasikan

### Analisis Data

- Membersihkan dan menggabungkan CSV atau JSON.
- Menghitung statistik, agregasi, dan anomali.
- Menghasilkan CSV ringkasan atau laporan Markdown.

### Coding dan Prototyping

- Menulis serta menjalankan Python atau JavaScript.
- Membuat prototipe HTML/CSS/JavaScript.
- Menjalankan unit test, linter, atau pemeriksaan syntax yang tersedia.

### Analisis File dan Log

- Mencari pola error pada log.
- Membandingkan file konfigurasi non-sensitif.
- Mengekstrak informasi dari kumpulan file dalam volume terminal.

### Otomasi Ringan

- Batch rename dan transformasi file dalam `/home/user`.
- Membuat laporan berulang dari data unggahan.
- Mengubah format data atau dokumen dengan tool yang tersedia.

### Pembuatan Artefak

- Membuat laporan, grafik, tabel, source code, dan file hasil olahan.
- Menyimpan hasil secara persisten dan membukanya melalui file browser.

## Batas Keamanan

- Jangan menaruh password, private key, token produksi, atau database dump sensitif di `/home/user`.
- Jangan menambahkan Docker socket, privileged mode, atau mount filesystem host tanpa review keamanan baru.
- Tinjau command destruktif seperti `rm`, overwrite, dan bulk modification sebelum menyetujuinya.
- Hapus file uji setelah validasi bila tidak lagi diperlukan.
- Jika muncul `401 Unauthorized`, verifikasi API key di Admin Panel dan `.env` VPS tanpa menampilkannya ke chat.
