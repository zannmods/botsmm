# Bot Telegram Jual Layanan IndoSMM

Bot Telegram untuk jualan layanan sosmed dari IndoSMM. User isi saldo dulu lewat Zapay, baru bisa beli layanan. Semua navigasi pakai button. Data disimpan di file JSON lokal, tanpa database server.

## Isi folder

| File | Fungsi |
| --- | --- |
| `index.js` | Seluruh logika bot, webhook, dan sinkron status |
| `settings.js` | Semua pengaturan: token, admin, API key, fee, tampilan |
| `package.json` | Daftar dependency |
| `database.json` | Dibuat otomatis saat bot jalan (user, order, deposit, config) |

## Cara jalan

1. Pasang Node.js 18 atau lebih baru.
2. Install dependency:
   ```
   npm install
   ```
3. Edit `settings.js`: isi `botToken`, `adminChatId`, `indosmm.apiKey`, `zapay.apiKey`.
4. Jalankan:
   ```
   npm start
   ```
5. Buka bot di Telegram, kirim `/start`. Admin kirim `/admin` untuk buka panel.

Saat start, log menampilkan awal dan akhir API key IndoSMM yang terbaca, berguna untuk memastikan key sudah benar.

Untuk jalan terus di VPS, pakai pm2: `pm2 start index.js --name smmbot`.

## Webhook Zapay

Zapay mengirim notifikasi bayar ke server kamu. Bot membuka server HTTP di `zapay.webhookPort` (bawaan 3000) dengan path `zapay.webhookPath` (bawaan `/zapay/webhook`).

Syarat dari Zapay: URL harus https, domain publik, port 443 atau 1024 sampai 65535.

Contoh Nginx dengan SSL:

```
location /zapay/webhook {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
}
```

Lalu isi kolom URL webhook di menu Project Zapay dengan `https://domainkamu.com/zapay/webhook`.

Webhook dari Zapay tidak diulang kalau gagal. Karena itu bot juga mengecek deposit yang masih pending tiap `zapay.pollSeconds` detik lewat endpoint statustransaksi. Jadi saldo tetap masuk walau webhook telat atau server sempat mati.

Keamanan webhook yang sudah dipasang: cek signature HMAC-SHA256 dari body mentah, tolak timestamp lebih dari 10 menit, cocokkan nominal dengan data deposit di database, dan saldo hanya ditambah sekali per deposit.

## Tes dulu di sandbox

1. Pakai key `zps_...` di `zapay.apiKey`.
2. Jalankan bot, buat deposit dari menu Isi Saldo.
3. Di pesan pembayaran ada tombol **Simulasi Lunas**. Tekan, tunggu webhook, saldo masuk.
4. Kalau sudah beres, ganti ke key `zp_...` dan tes satu deposit kecil.

Key sandbox dan live tidak bisa dipakai bersamaan, bot membaca satu key saja dari `settings.js`.

## Cara hitung harga dan untung

Rate dari API IndoSMM dipakai langsung sebagai rupiah per 1.000, sama seperti versi web. Tidak ada konversi kurs. Kalau panelmu memakai USD, jangan pakai bot ini tanpa menambah konversi sendiri.

Markup persen:

```
harga jual per 1.000 = ceil(rate x (1 + persen / 100))
harga order = ceil(harga jual per 1.000 / 1.000 x jumlah)
```

Contoh: rate 17, markup 5%, harga jual Rp18 per 1.000. Order 100.000 views dibayar Rp1.800.

Markup rupiah ditambahkan ke rate per 1.000: `ceil(rate + nominal)`.

Modal tiap order disimpan saat order dibuat, jadi statistik untung tetap benar walau markup diubah belakangan.

### Fee deposit

User deposit Rp50.000 dengan fee 2%:

- Dikirim ke Zapay: Rp51.000
- Saldo user bertambah: Rp50.000
- Untung kamu: Rp1.000

Biaya Zapay sendiri diatur lewat `zapay.feeBearer`:

- `buyer`: biaya Zapay ditambahkan ke total bayar user. Untung deposit utuh. Ini yang disarankan.
- `seller`: biaya Zapay dipotong dari saldo kamu. Virtual account kena Rp5.000 flat, hati-hati kalau nominal deposit kecil.

Untung deposit dihitung dari `net` yang dikirim Zapay dikurangi saldo yang diberikan ke user, jadi sudah memperhitungkan biaya Zapay.

Markup dan fee bisa diubah langsung dari bot lewat Panel Admin, Harga dan Fee. Nilai yang diubah dari bot disimpan di `database.json` dan menimpa nilai di `settings.js`.

## Alur pesanan

1. User pilih platform, kategori, layanan, lalu kirim jumlah dan link.
2. Bot tampilkan konfirmasi dengan harga dan sisa saldo.
3. Saat dikonfirmasi, saldo dipotong lalu order dikirim ke IndoSMM. Kalau IndoSMM menolak, saldo langsung dikembalikan dan admin dapat notifikasi berisi alasannya.
4. Bot cek status semua order aktif tiap `sync.orderSeconds` detik (maksimal 100 order per request).
5. Status Canceled, Failed, atau Refunded mengembalikan saldo penuh. Status Partial mengembalikan saldo sesuai sisa yang belum terkirim.
6. User dapat notifikasi saat status berubah. Tombol Refill dan Batalkan muncul kalau layanannya mendukung.

Bot hanya menampilkan layanan bertipe yang ada di `indosmm.allowedTypes` (bawaan `Default`). Tipe lain seperti Custom Comments butuh parameter tambahan yang tidak ada di dokumentasi API yang dipakai, jadi sengaja tidak dimunculkan.

## Fitur

User:
- Daftar layanan bertingkat: platform, kategori, layanan
- Cari layanan pakai kata kunci, plus menu Terlaris (layanan yang paling sering dipesan di tokomu)
- Progress bar status pesanan, emoji status, dan tombol bagikan link referral
- Isi saldo lewat QRIS dan virtual account, QR tampil langsung di chat
- Riwayat deposit, daftar pesanan, detail dan perbarui status, refill, batalkan
- Referral dengan bonus saldo
- Hubungi CS langsung dari bot

Admin (`/admin`):
- Statistik hari ini dan semua waktu: omzet, untung pesanan, untung deposit, total saldo user
- Saldo IndoSMM dan Zapay
- Broadcast teks, foto, video, atau file, ada preview sebelum kirim
- Kelola user: cek, tambah atau kurangi saldo, blokir
- Ubah markup dan fee deposit dari bot
- Refresh daftar layanan, mode maintenance, backup `database.json` langsung ke chat
- Notifikasi otomatis: pesanan baru, deposit lunas, order gagal, nominal webhook tidak cocok, saldo IndoSMM menipis

Pesan CS dari user masuk ke `adminChatId` lengkap dengan tombol Balas. Balasan admin sampai ke user lewat bot.

## Kustomisasi di settings.js

| Pengaturan | Keterangan |
| --- | --- |
| `store.name`, `store.tagline`, `store.info` | Teks di menu dan halaman info |
| `store.thumbnails` | Banner tiap layar: `menu`, `services`, `deposit`, `account`, `orders`, `info`, `help`, `referral`, `admin`, `success`. Isi dengan path file lokal atau link gambar. Kosongkan satu untuk mematikan banner di layar itu |
| `platforms[].icon` | Emoji di depan nama platform |
| `zapay.methods[].icon` | Emoji di depan nama metode bayar |
| `store.buttonStyle` | `true` untuk warna button (biru, hijau, merah). Hanya tampil di aplikasi Telegram versi terbaru, versi lama menampilkan button biasa |
| `store.channelUrl` | Kalau diisi, muncul tombol Channel di menu |
| `store.supportUsername` | Kalau diisi, halaman CS punya tombol chat langsung |
| `deposit.presets` | Nominal cepat yang tampil sebagai button |
| `deposit.min`, `deposit.max` | Batas nominal deposit |
| `deposit.maxPending` | Batas deposit yang boleh menunggu bayar bersamaan |
| `referral.percent` | Bonus referral, isi 0 untuk mematikan |
| `platforms` | Daftar platform di menu layanan. Kategori dicocokkan lewat kata di `keys`, sisanya masuk Lainnya |
| `zapay.methods` | Metode bayar yang ditampilkan ke user |
| `indosmm.lowBalance` | Batas saldo IndoSMM (rupiah) sebelum admin diberi peringatan |

### Banner dan tampilan

Folder `assets/` berisi 10 banner (1280x640). Ganti dengan banner buatanmu sendiri dengan nama file yang sama, atau arahkan `store.thumbnails` ke file lain. Rasio 2:1 paling pas. Setelah mengganti file, hapus bagian `thumbs` di `database.json` supaya bot mengunggah ulang, karena bot menyimpan file_id dari Telegram agar pengiriman berikutnya cepat.

Pindah antar layar yang sama-sama punya banner memakai edit di tempat, jadi tidak ada pesan yang muncul lalu hilang. Layar dengan teks lebih dari 1.000 karakter otomatis tampil tanpa banner karena batas caption Telegram.

Teks memakai `<blockquote>` dan garis pemisah. Gaya header ada di fungsi `head` dan `quote` dekat bagian atas `index.js`, ubah di situ kalau mau ganti gaya semua layar sekaligus.

Mau ubah teks atau tampilan layar tertentu? Cari fungsi `show...` di `index.js`, misalnya `showMenu`, `showDeposit`, `showService`. Tiap layar adalah satu fungsi yang isinya teks dan susunan button.

## Peta kode di index.js

| Bagian | Fungsi utama |
| --- | --- |
| Database | `loadDb`, `save`, `flush` |
| API eksternal | `smm`, `zapay` |
| Harga | `sellRate`, `priceOf`, `feeOf` |
| Layar user | `showMenu`, `showPlatforms`, `showServices`, `showService`, `showAccount` |
| Pesanan | `placeOrder`, `confirmOrder`, `syncOrders`, `applyStatus`, `settleRefund` |
| Deposit | `createDepositFlow`, `creditDeposit`, `syncDeposit`, `pollDeposits` |
| Webhook | `startWebhookServer`, `handleWebhook`, `processWebhook` |
| Admin | `showAdmin`, `showStats`, `showPrices`, `userCard`, `runBroadcast` |
| Router | `route` untuk button, `handleInput` untuk teks yang diketik |

Callback button memakai format `perintah:argumen`, contoh `s:123` untuk detail layanan 123. Tambah fitur baru dengan menambah satu `case` di `route` dan satu fungsi layar.

## Catatan

- Satu bot hanya boleh dijalankan di satu proses. Dua proses dengan token yang sama akan bentrok.
- `database.json` berisi saldo semua user. Jangan masuk repositori publik dan backup berkala lewat tombol Backup DB.
- Jangan pernah membagikan `settings.js` karena memuat token bot dan API key.
- Rate limit Zapay 60 request per menit. Polling deposit dibatasi 25 transaksi tiap siklus supaya aman.
