// Siklus hidup entri melawan env make.fun — ditulis ulang dari nol dengan
// kata-kata sendiri. Tugas file ini cuma jadi pengikat antara server aplikasi
// (app.ts, yang dinilai harness) dan env yang menjalankan trial:
//
//   1. Baca MAKEFUN_ENV_URL. Variabel ini menunjuk origin env, misalnya
//      http://store:8080 di dalam container trial. Kalau kosong, tidak ada
//      lawan bicara sama sekali, jadi proses langsung berhenti dengan kode 1.
//   2. Nyalakan server aplikasi di port acak (listen 0, kernel yang memilih).
//      Port 8080 adalah milik env — jangan pernah diikat di sini.
//   3. Kabari env lewat POST /register {"port": N} supaya env tahu alamat
//      baliknya dan mulai memanggil server kita. Pendaftaran pertama yang
//      menang; jawaban 409 artinya entri lain sudah mendaftar lebih dulu,
//      dan itu bukan urusan kita — proses tetap lanjut menunggu seperti biasa.
//   4. Tanyakan GET /done berulang-ulang sampai jawabannya {"done": true}.
//      Env menjawab seketika ({"done": false} selama suite berjalan), jadi
//      ini polling biasa, bukan request yang ditahan lama. Poll yang gagal
//      atau lambat diulang dengan jeda yang membesar secara eksponensial;
//      proses tidak pernah keluar sebelum env menyatakan selesai.
//   5. Tutup server lalu keluar 0. Harness kemudian mematikan env, yang
//      menulis export untuk dibaca scorer.
//
// File ini hanya mengimpor servernya sendiri: tidak ada package luar, tidak
// ada built-in Node tambahan, tidak ada panggilan model.

import { createApp } from './app.ts';

// Origin env, tanpa garis miring di ujung supaya penempelan path konsisten.
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL belum diset: tidak ada env untuk didaftari\n');
  process.exit(1);
}

/** Batas waktu satu panggilan register/done sebelum dianggap gagal dan diulang. */
const BATAS_PANGGIL_MS = 30_000;
/** Jeda pertama antar percobaan ulang, dan jeda paling lama. */
const JEDA_AWAL_MS = 250;
const JEDA_MAKS_MS = 2_000;
/** Pangkat dua dibatasi supaya jeda tidak membesar tanpa ujung. */
const PANGKAT_MAKS = 8;

const tunggu = (ms: number): Promise<void> => new Promise((selesai) => setTimeout(selesai, ms));

/** Jeda setelah percobaan ke-`n` gagal: mulai dari JEDA_AWAL_MS, berlipat dua, dibatasi. */
function jedaKe(n: number): number {
  return Math.min(JEDA_MAKS_MS, JEDA_AWAL_MS * 2 ** Math.min(n, PANGKAT_MAKS));
}

/**
 * Jalankan `langkah` berulang-ulang sampai ia mengembalikan true. Kalau langkah
 * melempar error, error itu dibiarkan keluar — hanya jawaban "belum" (false)
 * yang memicu jeda lalu percobaan berikutnya.
 */
async function cobaLagi(langkah: () => Promise<boolean>): Promise<void> {
  for (let percobaan = 0; ; percobaan += 1) {
    if (await langkah()) return;
    await tunggu(jedaKe(percobaan));
  }
}

/**
 * POST port yang terikat sampai env menerimanya. Jawaban 200 berarti diterima;
 * 409 berarti pendaftaran pertama sudah dimenangkan entri lain, yang sama
 * baiknya buat kita. Jawaban 400 dan 405 adalah kesalahan kontrak dan
 * menghentikan program; status lain atau error jaringan diulang, karena
 * env mungkin masih dalam tahap menyala.
 */
async function daftarkanPort(port: number): Promise<void> {
  await cobaLagi(async () => {
    let jawaban: Response;
    try {
      jawaban = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(BATAS_PANGGIL_MS),
      });
    } catch {
      // Env belum bisa dihubungi: bukan akhir dunia, coba lagi.
      return false;
    }
    if (jawaban.status === 200 || jawaban.status === 409) return true;
    if (jawaban.status === 400 || jawaban.status === 405) {
      let rincian = '';
      try {
        rincian = await jawaban.text();
      } catch {
        // Badan jawaban tak terbaca; pesan error tetap jalan tanpa rincian.
      }
      throw new Error(`register ditolak HTTP ${jawaban.status}${rincian ? `: ${rincian}` : ''}`);
    }
    return false;
  });
}

/** Tanya GET /done sampai ia menjawab {"done": true}; jangan kembali sebelum itu. */
async function tungguSelesai(): Promise<void> {
  await cobaLagi(async () => {
    try {
      const jawaban = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(BATAS_PANGGIL_MS),
      });
      if (!jawaban.ok) return false;
      const isi = (await jawaban.json()) as { done?: unknown };
      return isi.done === true;
    } catch {
      // Env belum menjawab, atau poll kehabisan waktu: belum selesai, tanya lagi.
      return false;
    }
  });
}

/** Ikat server ke port TCP acak dan kembalikan nomor portnya. */
function ikatPortAcak(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise<number>((selesai, gagal) => {
    server.once('error', gagal);
    server.listen(0, () => {
      const alamat = server.address();
      if (alamat === null || typeof alamat === 'string') {
        gagal(new Error('server tidak mengikat port TCP acak'));
        return;
      }
      selesai(alamat.port);
    });
  });
}

/** Seluruh hidup proses: nyalakan, daftarkan, tunggu selesai, tutup. */
async function jalankan(): Promise<void> {
  const server = createApp();
  const port = await ikatPortAcak(server);
  process.stdout.write(`[entry] mendengarkan di port ${port}\n`);

  await daftarkanPort(port);
  process.stdout.write('[entry] terdaftar; menunggu env menyatakan selesai\n');

  await tungguSelesai();
  server.close();
  process.stdout.write('[entry] selesai\n');
}

try {
  await jalankan();
  process.exit(0);
} catch (galat) {
  process.stderr.write(`[entry] ${galat instanceof Error ? galat.message : String(galat)}\n`);
  process.exit(1);
}
