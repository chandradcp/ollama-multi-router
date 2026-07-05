# 🔀 Ollama Multi Router

Local AI gateway untuk menghubungkan **4 akun Ollama Cloud** (atau lebih) menjadi **1 endpoint OpenAI-compatible** lokal. Cocok untuk dipakai di **Cursor IDE** dan **Hermes Agent**.

## ✨ Fitur

- 🌐 **1 endpoint lokal** OpenAI-compatible (`http://localhost:20128/v1`)
- 🔑 **Multi API key** — tiap akun Ollama punya key sendiri
- 🔄 **3 Routing Strategy**:
  - **Round Robin** — bergantian antar akun
  - **Least Loaded** — ke akun dengan request paling sedikit
  - **Priority** — prioritas berdasarkan urutan, pindah kalau gagal
- 📊 **Dashboard web** dengan autentikasi, monitoring & kontrol
- 🏥 **Health check** otomatis saat startup
- 💬 Support **streaming** dan **non-streaming** chat completions
- 📝 **Request logging ke file** (Winston)
- 📈 **Rate-Limit info** dari masing-masing akun
- 🔒 **Dashboard authentication** (Basic Auth)
- 🔔 **Notifikasi** saat semua akun down (webhook)
- 🐳 **Docker** support (Dockerfile + docker-compose)
- 🧩 Plug-and-play dengan Cursor IDE & Hermes Agent

---

## 🚀 Quick Start

### 1. Install dependency

```bash
npm install
```

### 2. Konfigurasi environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=20128
LOCAL_API_KEY=sk-local-router-change-me

# Dashboard Authentication
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=admin123

# Routing Strategy: round-robin | least-loaded | priority
ROUTING_STRATEGY=round-robin

# Logging
LOG_REQUESTS=true
LOG_TO_FILE=true
LOG_LEVEL=info

# Request timeout & retries
REQUEST_TIMEOUT=60000
MAX_RETRIES=4

# Notifikasi webhook (opsional)
NOTIFICATION_WEBHOOK=
```

### 3. Konfigurasi akun Ollama

`config/accounts.json` **tidak** di-commit ke git (berisi API key asli). Salin dari template dulu:

```bash
cp config/accounts.example.json config/accounts.json
```

Lalu isi lewat dashboard, atau edit `config/accounts.json`:

```json
{
  "accounts": [
    {
      "id": "ollama-1",
      "name": "Ollama Server A",
      "url": "https://ollama.com",
      "key": "YOUR_OLLAMA_API_KEY",
      "enabled": true,
      "models": [],
      "priority": 1
    }
  ],
  "routingStrategy": "round-robin"
}
```

> **Catatan URL**: cukup pakai host dasar Ollama (`https://ollama.com` atau `https://api.ollama.com`). Router memakai native API Ollama (`/api/chat`, `/api/tags`), jadi kalau kamu tempel URL berakhiran `/v1`, suffix itu otomatis di-strip.

### 4. Jalankan server

```bash
npm start
```

Atau mode development dengan auto-reload:

```bash
npm run dev
```

Server akan berjalan di:

- **Dashboard**: http://localhost:20128/dashboard (login: admin / admin123)
- **API endpoint**: http://localhost:20128/v1
- **Health check**: http://localhost:20128/health

---

## 🐳 Docker

### Build & Run

```bash
docker compose up -d
```

### Build from scratch

```bash
docker build -t ollama-multi-router .
docker run -p 20128:20128 --env-file .env -v $(pwd)/config:/app/config -v $(pwd)/logs:/app/logs ollama-multi-router
```

---

## 🚀 Jalankan sebagai Service (macOS / launchd)

Biar router jalan **standalone** — otomatis nyala saat login dan auto-restart kalau crash — daftarkan sebagai launchd user-agent:

```bash
npm run service:install     # install + langsung start
```

Perintah lain:

```bash
npm run service:status      # cek state & pid
npm run service:logs        # tail log realtime
npm run service:uninstall   # stop & hapus service
```

- Installer otomatis mendeteksi path `node` dan lokasi project (aman walau folder dipindah).
- Plist tersimpan di `~/Library/LaunchAgents/com.dcp.ollama-multi-router.plist`.
- Log service: `logs/service.out.log` & `logs/service.err.log`.
- Setelah jadi service, **jangan** jalankan `npm start` manual bersamaan (bentrok port).

---

## 🔌 Integrasi

### Cursor IDE

1. Buka **Cursor Settings** → **Models** → **OpenAI API**.
2. Atur:
   - **Base URL**: `http://localhost:20128/v1`
   - **API Key**: Local API Key kamu — bisa dilihat/di-**Copy** di **Dashboard → Local API Key**, atau klik **✨ Generate** untuk bikin key acak baru (langsung aktif & tersimpan)
   - **Model**: `ollama/<nama-model>` (lihat daftar di `/v1/models` atau dashboard)

> **Local API Key** default (`sk-local-router-change-me`) sebaiknya diganti. Di dashboard ada panel khusus untuk melihat, menyalin, dan men-generate ulang key ini tanpa restart server. Key hasil generate disimpan di `config/gateway.json` (gitignored) dan menang atas nilai `.env`.

### Hermes Agent

Set environment variable sebelum menjalankan Hermes:

```bash
export OPENAI_BASE_URL="http://localhost:20128/v1"
export OPENAI_API_KEY="sk-local-router-change-me"
```

Atau jika Hermes pakai config file, set:

```json
{
  "openai_base_url": "http://localhost:20128/v1",
  "openai_api_key": "sk-local-router-change-me",
  "model": "ollama/llama3.2"
}
```

---

## 🧪 Testing

### Unit test

Test suite pakai test runner bawaan Node (tanpa dependency tambahan):

```bash
npm test
```

Mencakup: routing/fallback antar akun, translator OpenAI↔Ollama, retry, cache, stats, dan normalisasi URL.

### Cek health

```bash
curl http://localhost:20128/health
```

### List models

```bash
curl http://localhost:20128/v1/models \
  -H "Authorization: Bearer sk-local-router-change-me"
```

### Chat completion

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-local-router-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ollama/llama3.2",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Chat completion (streaming)

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-local-router-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ollama/llama3.2",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

---

## ⚙️ Cara Kerja Routing

```
Cursor / Hermes
       │
       ▼
localhost:20128/v1/chat/completions
       │
       ▼
[Ollama Multi Router]
       │
       ├── Pilih akun berdasarkan strategy
       │
       ├── Translate OpenAI → Ollama format
       │
       ├── Kirim ke akun Ollama
       │
       └── Kalau gagal → coba akun berikutnya (fallback)
```

### Strategi Routing

| Strategi | Deskripsi |
|----------|-----------|
| **round-robin** | Request berikutnya akan dialihkan ke akun berikutnya yang aktif |
| **least-loaded** | Memilih akun dengan jumlah request paling sedikit |
| **priority** | Menggunakan akun dengan priority terendah, pindah kalau gagal |

---

## 🛠️ Konfigurasi

### Environment Variables

| Variable | Default | Keterangan |
|----------|---------|------------|
| `PORT` | `20128` | Port local gateway |
| `LOCAL_API_KEY` | `sk-local-router-change-me` | API key untuk mengakses endpoint `/v1/*` |
| `DASHBOARD_USERNAME` | `admin` | Username untuk login dashboard |
| `DASHBOARD_PASSWORD` | `admin123` | Password untuk login dashboard |
| `ROUTING_STRATEGY` | `round-robin` | Strategi routing default |
| `LOG_REQUESTS` | `true` | Log setiap request ke console |
| `LOG_TO_FILE` | `true` | Log setiap request ke file `logs/router.log` |
| `LOG_LEVEL` | `info` | Level logging (error, warn, info, debug) |
| `REQUEST_TIMEOUT` | `60000` | Timeout request ke Ollama (ms) |
| `MAX_RETRIES` | `4` | Maksimal percobaan antar akun |
| `NOTIFICATION_WEBHOOK` | (kosong) | URL webhook untuk notifikasi saat semua akun gagal |

### Konfigurasi Akun

| Field | Tipe | Keterangan |
|-------|------|------------|
| `id` | string | ID unik akun |
| `name` | string | Nama tampilan |
| `url` | string | URL endpoint Ollama |
| `key` | string | API key Ollama |
| `enabled` | boolean | Aktif/nonaktif |
| `priority` | number | Urutan prioritas (semakin kecil semakin prioritas) |

---

## 📁 Struktur Project

```
ollama-multi-router/
├── config/
│   ├── accounts.example.json  # Template akun (di-commit)
│   └── accounts.json          # Konfigurasi akun Ollama (gitignored, berisi key asli)
├── logs/                      # Log file (auto-created)
│   └── router.log
├── src/
│   ├── server.js              # Entry point Express
│   ├── router.js              # Logic routing multi-strategy + fallback antar akun
│   ├── providers.js           # Load & health-check akun
│   ├── openai-compat.js       # Translator OpenAI ↔ Ollama
│   ├── retry.js               # Retry per-akun (exponential backoff + jitter)
│   ├── cache.js               # Cache response (TTL, LRU sederhana)
│   ├── stats.js               # Statistik request/akun/model
│   ├── notifications.js       # Webhook notification
│   ├── utils.js               # Winston logger & helpers
│   └── dashboard/             # Dashboard web
│       ├── index.html
│       ├── app.js
│       └── style.css
├── .env.example
├── .env
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

---

## 📄 Lisensi

MIT
