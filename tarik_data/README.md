# Modul Tarik Data

Step pertama: paksa tabel SMILE tampil banyak baris tanpa pagination.

## Cara Tes Manual

1. Buka halaman SMILE, contoh:

```text
https://smile2.bpjsketenagakerjaan.go.id/smile/mod_pn/form/pn5053_form_detil_sla.php?kdktr=L00&tgl1=%5C%5C&tgl2=
```

2. Tunggu tabel tampil.
3. Buka file ini:

```text
tarik_data\buka_script_tampilkan_semua_data.cmd
```

4. Copy seluruh isi `tampilkan_semua_data.js`.
5. Paste ke DevTools Console halaman SMILE, lalu tekan Enter.

Script akan mencoba mengubah `Show entries` menjadi `10000` lewat DataTables API dan dropdown.

## Filter Sisa Hari Pembayaran

Setelah semua data tampil, jalankan script kedua:

```text
tarik_data\buka_script_filter_sisa_hari.cmd
```

Copy seluruh isi `filter_sisa_hari_pembayaran_3.js`, paste ke DevTools Console halaman SMILE, lalu tekan Enter.

Script ini akan menampilkan hanya baris dengan `Sisa Hari Pembayaran` bernilai `0`, `1`, `2`, atau `3`.

## Script Gabungan

Untuk menjalankan dua aktivitas sekaligus, buka:

```text
tarik_data\buka_script_tampilkan_semua_dan_filter.cmd
```

Copy seluruh isi `tampilkan_semua_dan_filter_sisa_hari.js`, paste ke DevTools Console halaman SMILE, lalu tekan Enter.

Script gabungan ini akan:

1. Mengubah `Show entries` menjadi `10000`.
2. Memfilter `Sisa Hari Pembayaran` hanya `0`, `1`, `2`, dan `3`.
