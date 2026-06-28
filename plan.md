# Rencana Instalasi Open Terminal dan Integrasi Open WebUI

## Status Implementasi

**Selesai dan tervalidasi pada 28 Juni 2026.**

- Open Terminal `0.11.34` berjalan sebagai container terisolasi.
- Health internal melalui Open WebUI mengembalikan `{"status":"ok"}`.
- API key benar menghasilkan HTTP `200`; key salah menghasilkan HTTP `401`.
- Tidak ada host port untuk Open Terminal.
- Persistensi `/home/user` berhasil melewati restart container.
- Koneksi `VPS Open Terminal` aktif, menggunakan Bearer auth, dan bersifat
  private tanpa grant tambahan.
- Native tool calling berhasil menjalankan `cat /etc/os-release` dan
  mengembalikan `Debian GNU/Linux 13 (trixie)`.
- Open WebUI, Caddy, SearXNG, dan Reddit/Threads loader tetap sehat.

## Ringkasan

Tambahkan Open Terminal sebagai container terisolasi pada stack `/opt/owui-stack`, terhubung hanya melalui network internal `owui-net`. Port Open Terminal tidak dibuka ke internet. Koneksi dikonfigurasi melalui Admin Panel Open WebUI agar API key tetap server-side dan akses dibatasi untuk admin.

Setiap tahap mengikuti pola berikut:

1. Jalankan pre-check.
2. Lakukan satu perubahan terukur.
3. Jalankan post-check.
4. Hentikan proses dan lakukan rollback apabila pemeriksaan gagal.

Panduan resmi:

- [Open Terminal Installation](https://docs.openwebui.com/features/open-terminal/setup/installation/)
- [Connecting Open Terminal to Open WebUI](https://docs.openwebui.com/features/open-terminal/setup/connecting/)

## Kondisi Awal yang Sudah Diverifikasi

- Deployment aktif berada di `/opt/owui-stack`.
- Open WebUI, SearXNG, Reddit loader, dan Caddy sedang berjalan.
- Container Open WebUI berstatus sehat.
- Docker Compose aktif dan konfigurasi saat ini valid.
- Semua service menggunakan network internal `owui-net`.
- Open WebUI hanya memiliki binding lokal `127.0.0.1:3000`; akses publik dilayani Caddy melalui HTTPS.
- VPS memiliki sekitar 46 GB disk kosong dan sekitar 1,2 GB RAM available saat preflight.
- Firewall hanya ditujukan untuk SSH, HTTP, HTTPS, dan HTTP/3; Open Terminal tidak boleh menambah port publik.

## Tahap 1 — Preflight dan Backup

### Pre-check

- Pastikan SSH key authentication ke VPS berhasil.
- Jalankan `docker compose ps` dan pastikan semua service lama aktif.
- Jalankan `docker compose config --quiet`.
- Periksa RAM, swap, disk, dan kapasitas Docker.
- Periksa health Open WebUI dan respons HTTPS publik.
- Catat container serta port yang terhubung ke `owui-net`.

### Perubahan

- Buat backup bertanggal untuk `compose.yaml` dan `.env` aktif di VPS.
- Jangan menyalin atau mencetak isi secret ke log.

### Post-check

- Pastikan file backup ada, hanya dapat diakses oleh pemilik yang sesuai, dan dapat dibaca.
- Pastikan checksum atau isi Compose backup cocok dengan konfigurasi sebelum perubahan.

## Tahap 2 — Konfigurasi Open Terminal

### Pre-check

- Pastikan service atau container bernama `open-terminal` belum ada.
- Pastikan volume bernama Open Terminal belum berbenturan dengan volume lain.
- Pastikan nama service `open-terminal` dapat di-resolve di network Compose.

### Perubahan

- Buat API key acak yang kuat dan simpan sebagai `OPEN_TERMINAL_API_KEY` di `.env` aktif VPS.
- Tambahkan placeholder `OPEN_TERMINAL_API_KEY=replace-with-a-strong-random-secret` ke `.env.example`.
- Tambahkan service berikut ke Compose lokal dan Compose deployment VPS:
  - image `ghcr.io/open-webui/open-terminal`
  - container name `open-terminal`
  - restart policy `unless-stopped`
  - environment `OPEN_TERMINAL_API_KEY` dari `.env`
  - persistent volume `open-terminal:/home/user`
  - network `owui-net`
- Deklarasikan named volume `open-terminal`.
- Jangan tambahkan host port, host-directory mount, Docker socket, privileged mode, atau capability tambahan.

### Post-check

- Jalankan `docker compose config --quiet`.
- Periksa hasil Compose ter-render tanpa mencetak API key.
- Pastikan Open Terminal tidak memiliki konfigurasi `ports`.
- Pastikan hanya volume terisolasi `/home/user` yang terpasang.

## Tahap 3 — Deployment Bertahap

### Pre-check

- Pastikan baseline Open WebUI dan HTTPS masih sehat.
- Pastikan resource VPS masih mencukupi sebelum image diunduh.

### Perubahan

- Pull hanya image Open Terminal.
- Jalankan hanya service `open-terminal` tanpa recreate service lama.

### Post-check

- Pastikan container berstatus running dan tidak restart-loop.
- Periksa log startup untuk error tanpa menampilkan secret.
- Pastikan volume `/home/user` terpasang dan persisten.
- Pastikan container terhubung ke `owui-net`.
- Pastikan tidak ada public host port untuk Open Terminal.
- Dari container Open WebUI, panggil `http://open-terminal:8000/health` dan wajib menerima status sehat.
- Uji autentikasi API menggunakan key benar dan key salah; key salah wajib ditolak.
- Jalankan kembali pemeriksaan Open WebUI, SearXNG, Reddit loader, Caddy, HTTPS, dan penggunaan resource.

## Tahap 4 — Menghubungkan ke Open WebUI

### Pre-check

- Pastikan health check internal dari Open WebUI ke Open Terminal berhasil.
- Pastikan API key tersedia secara aman untuk pengisian Admin Panel.
- Pastikan akun yang digunakan memiliki hak admin.

### Perubahan

- Buka `Admin Panel → Settings → Integrations → Open Terminal`.
- Tambahkan koneksi dengan nilai:
  - URL: `http://open-terminal:8000`
  - Auth Type: `Bearer`
  - API Key: nilai `OPEN_TERMINAL_API_KEY` pada VPS
- Aktifkan koneksi dan batasi akses untuk admin saja.
- Pada model yang akan digunakan, aktifkan Native Function Calling atau tool use.
- Refresh halaman, pilih terminal System melalui ikon cloud pada area chat, lalu aktifkan untuk percakapan.

Jika sesi admin belum tersedia, proses berhenti di halaman login agar pemilik memasukkan kredensial sendiri. Password admin tidak disimpan atau dikirim melalui chat.

### Post-check

- Pastikan indikator integrasi menunjukkan `Connected`.
- Pastikan terminal muncul di daftar System untuk admin.
- Pastikan terminal tidak tersedia bagi pengguna non-admin.
- Minta model memeriksa sistem operasi dan pastikan model benar-benar memanggil tool terminal.
- Pastikan operasi terminal tidak dapat membaca filesystem host di luar volume terisolasi.

## Tahap 5 — Dokumentasi dan Rollback

### Dokumentasi

- Catat perubahan konfigurasi dan waktu deployment.
- Catat image Open Terminal yang benar-benar digunakan.
- Catat semua hasil pre-check dan post-check tanpa secret.
- Tambahkan prosedur operasi, troubleshooting, dan test manual ke dokumentasi repo.

### Rollback

Jika deployment gagal:

1. Hentikan dan hapus hanya container Open Terminal.
2. Pulihkan Compose dan `.env` dari backup.
3. Jalankan `docker compose config --quiet`.
4. Jalankan kembali service lama bila diperlukan.
5. Verifikasi seluruh fungsi Open WebUI dan HTTPS.
6. Pertahankan volume Open Terminal untuk investigasi; jangan hapus data tanpa persetujuan pemilik.

## Test Case Manual

### TC-01 — Konektivitas Terminal

Prompt: `Sistem operasi apa yang sedang Anda jalankan? Gunakan terminal untuk memeriksanya.`

Hasil yang diharapkan: model memanggil tool terminal dan mengembalikan informasi OS dari container.

### TC-02 — Eksekusi Python

Prompt: `Buat dan jalankan skrip Python untuk mencari semua bilangan prima dari 1 sampai 100.`

Hasil yang diharapkan: skrip berhasil dijalankan dan daftar bilangan prima benar.

### TC-03 — Persistensi File

Prompt: `Buat /home/user/manual-test.txt dengan isi timestamp saat ini, lalu baca kembali.`

Setelah itu restart container Open Terminal dan minta model membaca file yang sama.

Hasil yang diharapkan: isi file tetap tersedia setelah restart.

### TC-04 — Analisis Data

Unggah CSV kecil, lalu gunakan prompt: `Analisis CSV ini, hitung statistik ringkas, dan tunjukkan baris yang tampak anomali.`

Hasil yang diharapkan: terminal membaca file, menghasilkan statistik yang dapat diverifikasi, dan menjelaskan dasar deteksi anomali.

### TC-05 — Pembuatan Artefak

Prompt: `Buat laporan Markdown dan CSV ringkasan dari data ini, lalu beri tahu lokasi filenya.`

Hasil yang diharapkan: kedua file muncul di volume atau file browser Open Terminal dan dapat dibuka.

### TC-06 — Workflow Pengembangan

Prompt: `Buat halaman HTML sederhana dengan form kontak, lalu periksa struktur HTML-nya.`

Hasil yang diharapkan: file dibuat, pemeriksaan berhasil, dan seluruh pekerjaan tetap berada di volume terisolasi.

### TC-07 — Pembatasan Akses

Login sebagai pengguna non-admin dan periksa menu terminal.

Hasil yang diharapkan: Open Terminal tidak muncul atau tidak dapat dipilih.

### TC-08 — Isolasi Jaringan

Coba akses port `8000` melalui alamat publik VPS atau domain.

Hasil yang diharapkan: koneksi publik gagal, sementara `/health` dari container Open WebUI berhasil.

### TC-09 — Autentikasi API

Kirim request internal dengan API key salah dan kemudian dengan key benar.

Hasil yang diharapkan: key salah ditolak dan key benar diterima.

### TC-10 — Isolasi Filesystem

Prompt: `Tampilkan direktori kerja dan filesystem yang dapat Anda akses. Jangan mengubah file.`

Hasil yang diharapkan: model hanya melihat lingkungan container dan volume Open Terminal, bukan filesystem host VPS.

### TC-11 — Regresi Fitur Lama

Uji login Open WebUI, chat biasa, web search, SearXNG, Reddit/Threads loader, dan HTTPS.

Hasil yang diharapkan: semua fungsi lama tetap berjalan seperti sebelum deployment.

### TC-12 — Recovery Setelah Restart

Restart service Open Terminal, lalu restart stack atau VPS pada maintenance window yang disetujui.

Hasil yang diharapkan: container kembali aktif otomatis, koneksi Open WebUI pulih, dan file persisten tetap ada.

## Use Case

- Menjalankan Python, Node.js, dan utilitas shell dari percakapan.
- Menganalisis CSV, JSON, log, dan dokumen unggahan.
- Membuat laporan, grafik, Markdown, atau file hasil transformasi data.
- Membuat prototipe aplikasi serta menjalankan test atau linter.
- Men-debug skrip dalam sandbox persisten.
- Mengotomasi konversi, ekstraksi, pengelompokan, dan pembersihan data.
- Menggunakan file browser bawaan Open Terminal untuk melihat artefak hasil kerja model.
- Menjalankan workflow multi-langkah tanpa memberi AI akses luas ke host VPS.

## Asumsi dan Batasan

- Open Terminal berjalan dalam container terisolasi.
- Tidak ada mount direktori host atau Docker socket.
- Tidak ada port Open Terminal yang dipublikasikan.
- Hanya admin yang mendapat akses.
- Koneksi disimpan melalui Admin Panel, bukan Personal Settings.
- API key hanya disimpan di `.env` VPS dan tidak masuk Git.
- Native Function Calling diaktifkan pada model yang digunakan.
- Data sensitif tidak ditempatkan di volume terminal tanpa kebutuhan dan kontrol tambahan.
