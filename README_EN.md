# ArtPlayer Web API — English Documentation

<p align="center"><img src="https://cdn.jsdelivr.net/gh/yangyang8002/Artplayer-Web-Api@master/public/favicon.svg" width="96" height="96" alt="ArtPlayer Web API"></p>

<p align="center">
  <a href="https://github.com/yangyang8002/Artplayer-Web-Api/releases"><img src="https://img.shields.io/github/v/release/yangyang8002/Artplayer-Web-Api.svg?color=62d5ff&label=version" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-green.svg" alt="Node.js"></a>
  <a href="Dockerfile"><img src="https://img.shields.io/badge/Docker-Ready-blue.svg" alt="Docker"></a>
  <a href="#database-support"><img src="https://img.shields.io/badge/Databases-JSON%20%7C%20SQLite%20%7C%20MySQL%20%7C%20PostgreSQL%20%7C%20MongoDB-ff85a2.svg" alt="Databases"></a>
  <a href="https://www.npmjs.com/package/artplayer-web-api"><img src="https://img.shields.io/npm/v/artplayer-web-api?label=npm&color=cb3837" alt="npm"></a>
  <a href="https://github.com/yangyang8002/Artplayer-Web-Api"><img src="https://img.shields.io/github/stars/yangyang8002/Artplayer-Web-Api?style=social&label=Stars" alt="Stars"></a>
</p>

> 📖 [中文文档](README_CN.md) · 🐳 [Docker Deployment](DOCKER.md) · 🎨 [Theme System](theme/README.md)

A self-hosted danmaku video player + web admin panel built on [ArtPlayer](https://artplayer.org) and Express. Features a custom Canvas danmaku engine, dual theme system, PoW anti-bot protection, per-API rate limiting with 1-second-precision live stats, multi-subtitle support, a full file manager, and multi-database storage.

**v26.8.8** · MIT License

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [China Acceleration](#china-acceleration)
- [Project Structure](#project-structure)
- [Database Support](#database-support)
- [Player Usage](#player-usage)
- [Admin Panel](#admin-panel)
- [Server Configuration](#server-configuration)
- [API Reference](#api-reference)
- [Themes](#themes)
- [Docker Deployment](#docker-deployment)
- [Data & Backup](#data--backup)
- [FAQ](#faq)

## Features

- **Custom Canvas danmaku engine**: lane scheduling, top/bottom stacking, density / speed / opacity controls, pause freezing, seek support
- **DPlayer-compatible API**: `/api/danmu/v3/?id=` works with existing DPlayer danmaku clients
- **Server-assigned video IDs**: `/api/video/resolve` issues unique 8-character alphanumeric IDs and automatically inherits legacy hash IDs (no danmaku loss on upgrade)
- **Multi-subtitle detection**: auto-detects `.srt/.vtt/.ass` files next to the video, grouped by language (SC/TC/EN/JA/KO...), switchable in the player`n- **Subtitle library**: a dedicated Subtitles tab with its own IDs — add subtitles from URL (one-click localize), pasted text, or uploaded files; apply one or more subtitles to any video (videos still get same-directory auto-detection merged in); OpenList/AList cloud videos get same-folder subtitle detection via the configured instance API; player supports `subtitle=id:xxxx`
- **6-language UI**: Simplified Chinese / Traditional Chinese / Classical Chinese / English / 日本語 / Français, auto-detected from the browser with manual override
- **Security Center**: IP geolocation (auto-updating ip2region DB, city-level with ISP), world map distribution, request/traffic anomaly detection, IP ban & whitelist
- **Dual theme system**: independent player & admin themes, 10 themes each (incl. StyleKit anime/manga styles), custom themes supported
- **Admin panel**: danmaku / videos / banned words / files / logs / API stats / database in one place
- **API management**: per-API enable switch, RPS limit, bandwidth stats; live chart at 1s precision, selectable span (5 min ~ 3 months)
- **Security**: PoW proof-of-work firewall (Anubis-style), session tokens, login rate limit, global API rate limit
- **File manager**: online preview, batch delete/copy, archive (zip/7z/tar/tar.gz), extract (multi-format), multi-file upload
- **Multi-database storage**: JSON files (default) / SQLite / MySQL / MariaDB / PostgreSQL / MongoDB, freely convertible with hot-swap auto migration

## Quick Start

### Option 1: npm install (recommended)

```bash
npm install -g artplayer-web-api
artplayer-web-api                 # global command
# Or run without installing
npx artplayer-web-api
```

### Option 2: Docker image (Docker Hub / GHCR)

```bash
# Docker Hub
docker run -d --name artplayer-web-api -p 1919:1919 -v "$(pwd)/data:/app/data" yangyang8002/artplayer-web-api:latest

# GHCR (GitHub Container Registry)
docker run -d --name artplayer-web-api -p 1919:1919 -v "$(pwd)/data:/app/data" ghcr.io/yangyang8002/artplayer-web-api:latest
```

### Option 3: Run from source

```bash
git clone https://github.com/yangyang8002/Artplayer-Web-Api.git
cd Artplayer-Web-Api

# Install dependencies
npm install

# Start (default port 1919)
npm start
# Or with a custom port
PORT=8080 node server.js
```

| Page | URL |
|---|---|
| Player | http://localhost:1919/player/ |
| Admin | http://localhost:1919/admin/ |
| Default account | `admin` / `admin123` |

> The `data/` directory and default data files are created on first run. **A first-run wizard forces you to configure: UI language, timezone, storage type (JSON/SQLite/MySQL/MariaDB/PostgreSQL/MongoDB), a new admin password and a custom admin entry path** before the panel can be used.

## China Acceleration

- **GitHub accelerator** (clone / download / raw): prefix any GitHub URL with `https://fast.fumor.top/`

  ```bash
  git clone https://fast.fumor.top/https://github.com/yangyang8002/Artplayer-Web-Api.git
  ```

- **Docker Hub mirror** (Nanjing University): replace the registry prefix with `docker.nju.edu.cn/`

  ```bash
  docker pull docker.nju.edu.cn/yangyang8002/artplayer-web-api:latest
  ```

- **GHCR mirror** (Nanjing University): use the `docker.nju.edu.cn/ghcr.io/` prefix

  ```bash
  docker pull docker.nju.edu.cn/ghcr.io/yangyang8002/artplayer-web-api:latest
  ```

> Images are published to Docker Hub, GHCR and npm; users in mainland China are advised to use the NJU mirrors above.

## Project Structure

```
Artplayer-Web-Api/
├── server.js               # Express backend (all APIs)
├── lib/                    # Unified storage layer
│   ├── store.js            # Storage abstraction (JSON/SQLite/MySQL/PostgreSQL) + migration
│   └── backends/           # Database backends
├── public/                 # Frontend static assets
│   ├── player.html         # Player page (custom DanmakuEngine)
│   ├── admin.html          # Admin panel
│   ├── test_video1.mp4     # Test video
│   └── test_video1.*.vtt   # Test multi-language subtitles
├── theme/                  # Theme system (see theme/README.md)
│   ├── build.js            # Build script
│   ├── player.css          # Build output
│   ├── admin.css
│   ├── player/<id>/        # Player themes (theme.json + style.css)
│   └── admin/<id>/         # Admin themes
└── data/                   # Runtime data
    ├── danmu.json          # Danmaku data (JSON storage mode)
    ├── banned_words.json   # Banned words
    ├── videos.json         # Video ID map (vid → url)
    ├── accounts.json       # Accounts (salted sha256)
    ├── config.json         # Server configuration (incl. DB connection)
    ├── api-stats.json      # API stats (auto-saved)
    └── app.db              # SQLite database file (optional)
```

## Database Support

Six storage backends are built in: **JSON files (default) / SQLite / MySQL / MariaDB / PostgreSQL / MongoDB**, manageable from the "Database" tab in the admin panel.

### Data stored

| Data | Description |
|---|---|
| Danmaku | all danmaku (author, color, position, timestamp) |
| Video map | vid → url mappings |`n| Subtitle library | subtitle database (ID/name/lang/content/localized) + video-subtitle links |
| Banned words | keyword list (incl. subscribed lexicons) |
| Accounts | admin accounts (scrypt salted hash) |
| IP data | bans / whitelist, login records, login fail locks, per-IP request stats |
| Stats | API / IP access stats (1s time buckets) |

### Switching & migration

- Admin → Database → pick the target type (SQLite only needs a file path; MySQL/MariaDB/PostgreSQL need connection params) → "Switch & Migrate"
- All data is migrated automatically to the target storage (**any-to-any** between JSON ↔ SQLite ↔ MySQL ↔ MariaDB ↔ PostgreSQL ↔ MongoDB), no restart needed; writes pause briefly during migration
- Leave the password empty to reuse the saved one; use "Test Connection" first
- **Auto-migration**: set `db.type` in `config.json` and restart — if the target DB is empty and JSON files contain data, it syncs automatically once (zero-touch upgrade)
- Table browsing: inspect every table (danmaku / videos / banned words / accounts / bans & whitelist / login records / stats)
- Export backup: one-click download of all data as a JSON file

### Config example (config.json)

```json
{
  "db": {
    "type": "mysql",
    "sqlite": { "file": "data/app.db" },
    "mysql": { "host": "126.8.8.1", "port": 3306, "user": "root", "password": "", "database": "artplayer" },
    "postgres": { "host": "126.8.8.1", "port": 5432, "user": "postgres", "password": "", "database": "artplayer" },
    "mongodb": { "host": "126.8.8.1", "port": 27017, "user": "", "password": "", "database": "artplayer" }
  }
}
```

> `type` is one of `json` (default) / `sqlite` / `mysql` / `mariadb` / `postgres` / `mongodb`. MongoDB user/password may be empty (unauthenticated). Connection params can also be filled in and saved from the admin panel.

## Player Usage

### URL Parameters

```
/player/?url=/test_video1.mp4
/player/?url=https://example.com/a.m3u8&vid=xxx&title=Title
/player/?url=/test_video1.mp4&subtitle=/test_video1.en.vtt
```

| Param | Description |
|---|---|
| `url` | Video URL (local path or http/https); mp4 / flv / m3u8 (HLS) supported |
| `vid` | Video ID (optional; resolved/assigned by the server when omitted) |
| `subtitle` | Explicit subtitle file (optional; auto-detected when omitted) |
| `title` | Custom title |

### Danmaku Settings

Available in the top-right settings menu:

| Setting | Description |
|---|---|
| Danmaku on/off | Show/hide all danmaku |
| Opacity | 20% ~ 100% |
| Speed | 3s ~ 15s (scroll duration per line) |
| Amount | 5% ~ 100% (density) |
| Top/bottom stacking | 10% ~ 100% (stacking depth) |
| Bottom margin | 0% ~ 100% (clearance above masked area) |

All settings persist to `localStorage`.

### Subtitles

- Auto-detects `.srt/.vtt/.ass/.webvtt` files sharing the video basename
- Grouped by language suffix: `video.sc.srt` (Simplified Chinese), `video.tc.srt` (Traditional), `video.en.vtt` (English), etc.
- Switch languages, font size (14-32px) and bottom offset (5-80px) from the settings menu

### Video ID Mechanism

Danmaku is archived per video ID, assigned by the server:

```
GET /api/video/resolve?url=/test_video1.mp4
→ {"code":0,"data":{"vid":"a5sdkqcp","source":"new"}}
```

Resolution priority:
1. Existing mapping in `videos.json` → return the original ID (stable across sessions)
2. Legacy hash ID has danmaku → inherit it (no data loss on upgrade)
3. Brand-new video → assign a random 8-char ID (ambiguous chars 0/1/l/o/i excluded)

You can also assign video IDs manually in the admin panel under "视频管理" (Videos).

## Admin Panel

| Tab | Features |
|---|---|
| Banned Words | Add/remove/search (paged); subscribe to external word-list URLs (bundled GitHub lexicon), scheduled/manual refresh |
| Danmaku List | Filter by video/keyword, pagination, single delete |
| Videos | View/add/delete video ID mappings |
| Server Config | PoW toggle & difficulty, rate limit, danmaku rate limit, render params, session duration, themes, CDN prefix |
| Files | Browse, preview (≤200KB), batch delete/copy, archive (zip/7z/tar/tar.gz), extract (zip/7z/rar/gz/tar...), upload |
| Logs | Last 500 requests (time/method/path/status/IP/latency) |
| API Management | Per-API switch / RPS / bandwidth; live chart (1s precision, span 5 min ~ 3 months); uptime, total calls, total bandwidth |
| About | Project info |

The admin theme (`adminTheme`) is independent of the player theme (`theme`).

## Server Configuration

`data/config.json` (also editable in the admin panel):

```json
{
  "pow": { "enabled": false, "difficulty": 4 },
  "rateLimit": { "enabled": false, "windowMs": 60000, "max": 60 },
  "danmakuLimit": { "enabled": false, "maxPerMinute": 10 },
  "render": { "maxPerSecond": 250, "speedJitter": 10 },
  "api": {
    "apis": {
      "/api/config/public": { "enabled": true, "rps": 0, "bandwidth": 0 },
      "/api/danmu/": { "enabled": true, "rps": 0, "bandwidth": 0 }
    },
    "retentionDays": 1
  },
  "bannedWords": { "subscriptions": [] },
  "security": { "sessionMinutes": 120, "adminPath": "" },
  "theme": "bilibili",
  "adminTheme": "bilibili",
  "cdn": { "enabled": false, "baseUrl": "" }
}
```

| Key | Description |
|---|---|
| `pow.enabled` | Require a SHA-256 PoW challenge before entering the player (anti-bot) |
| `rateLimit` | Global API rate limit (sliding window) |
| `danmakuLimit` | Max danmaku sends per IP per minute |
| `danmaku.maxLength` | Max danmaku text length (default 500, 1-2000) |
| `danmaku.authorMaxLength` | Max danmaku author name length (default 50, 1-200) |
| `upload.maxMB` | Max file upload size (default 200MB, 1-2048) |
| `upload.previewKB` | File manager text preview limit (default 200KB) |
| `render.maxPerSecond` | Max danmaku spawned per second |
| `api.apis` | Per-API enable / RPS / bandwidth cap (KB/s); over-limit returns 429 |
| `api.retentionDays` | API stats retention in days (1-90) |
| `security.adminPath` | Custom admin path (e.g. `"panel"` → `/panel/`) |
| `timezone` | Site timezone (IANA name, e.g. Asia/Shanghai); affects server times like backup filenames |
| `language` | Default UI language (zh/zhHant/wyw/en/ja/fr) |
| `cdn` | Prepends CDN base URL to relative video paths in the player |

## API Reference

### Public APIs

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/danmu/v3/?id={vid}` | Fetch danmaku (DPlayer-compatible array format) |
| GET | `/api/danmu/v3/{vid}` | Same (path param) |
| GET | `/api/danmu/?id={vid}` | Fetch danmaku (JSON object array format) |
| POST | `/api/danmu/` | Submit danmaku `{id, text, color, type, time, author}` |
| POST | `/api/danmu/v3/` | Same (v3) |
| GET | `/api/video/resolve?url=` | Resolve/assign video ID |
| POST | `/api/video/map` | Manually record vid → url mapping |
| GET | `/api/subtitle/detect?url=` | Detect subtitles next to video |
| POST | `/api/subtitle/external` | Load external subtitle |
| GET | `/api/config/public` | Public config (CDN/theme/render) |
| GET | `/api/theme/{player\|admin}/list` | Theme list |
| GET | `/api/theme/{player\|admin}.css` | Theme CSS bundle |
| POST | `/api/pow/verify` | Verify PoW answer (issues cookie) |

### Admin APIs (require `Authorization: Bearer <token>`)

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/admin/login` | Login to obtain token (5/min rate limit) |
| POST | `/api/admin/change-password` | Change password |
| GET/POST | `/api/admin/config` | Read/update server config |
| GET | `/api/admin/danmu?vid=&page=` | Danmaku list (paged) |
| GET | `/api/admin/danmu/vids` | Danmaku summary by video |
| DELETE | `/api/admin/danmu` | Delete danmaku |
| GET/POST/DELETE | `/api/admin/banned-words` | Banned words CRUD (paged) |
| GET/POST/DELETE | `/api/admin/banned-words/subscriptions` | Lexicon subscription management |
| POST | `/api/admin/banned-words/refresh` | Refresh lexicons manually |
| GET/POST/DELETE | `/api/admin/videos` | Video mapping management |
| GET | `/api/admin/files?path=` | Browse/preview files |
| POST | `/api/admin/files/delete` | Batch delete |
| POST | `/api/admin/files/copy` | Batch copy |
| POST | `/api/admin/files/zip` | Archive (zip/7z/tar/tar.gz) |
| POST | `/api/admin/files/unzip` | Extract (multi-format) |
| POST | `/api/admin/files/upload` | Multi-file upload |
| GET | `/api/admin/logs?limit=` | Request logs |
| GET | `/api/admin/api/stats?span=` | API stats (span in seconds, 30 ~ 7776000) |
| POST | `/api/admin/api` | Update API rules / retention |

## Themes

10 themes each for player and admin: `bilibili / sakura / ocean / sunset / forest / mono / cyber / shoujo / jrpg / neon`.

See [theme/README.md](theme/README.md) for custom themes.

## Docker Deployment

```bash
# Option 1: pull from Docker Hub
docker run -d --name artplayer-web-api -p 1919:1919 -v "$(pwd)/data:/app/data" yangyang8002/artplayer-web-api:latest

# Option 2: build from source and start
docker compose up -d --build

# Or build directly
docker build -t artplayer-web-api .
docker run -d --name artplayer-web-api -p 1919:1919 -v "$(pwd)/data:/app/data" artplayer-web-api
```

Data is persisted via the `./data:/app/data` volume. See [DOCKER.md](DOCKER.md) for details (incl. Nginx reverse proxy).

## Data & Backup

- **JSON mode**: all data lives as JSON files under `data/` — copy the directory to back up
- **SQL mode**: data lives in database tables (SQLite file defaults to `data/app.db`, inside the `./data` volume); back up MySQL/PostgreSQL the usual way
- One-click **export backup** in the Database tab (all data → JSON file download)`n- **Scheduled auto-backup** (Database tab → Scheduled backup): configurable interval (hours), max backups kept, and contents (database data / server config); backups are stored in `data/backups/`; manual backup, download, delete and **restore from backup** are supported (restore overwrites the current storage; config restore keeps the current DB connection and backup settings)
- API stats auto-persist every minute and on graceful shutdown; history survives restarts

## FAQ

**Danmaku not showing?**
Make sure the video ID matches (same URL resolves to the same ID); check the banned-words list; confirm `/api/danmu/` is not disabled in API Management.

**Lost historical danmaku?**
No. `resolve` auto-detects legacy hash IDs and inherits them, so old danmaku remains visible after upgrading.

**How do I switch databases?**
Admin → Database → pick target storage → Test Connection → Switch & Migrate, no restart needed. You can also set the `db` field in `config.json` and restart (first boot syncs JSON data automatically).

**Can switching lose data?**
No. Migration is all-or-nothing: data is fully exported from the current storage, written to the target, and only then the switch takes effect; on failure it rolls back and the original storage is untouched.

**Duplicate danmaku IDs in legacy JSON data?**
JSON storage has no primary-key constraint, so historical duplicates may exist. They are deduplicated by id (one kept) automatically when migrating into SQL databases — the only cleanup migration performs.

**How to change the default password?**
Via the admin panel, or edit `data/accounts.json` directly (salt + sha256); if accounts are stored in a database, use the admin panel instead.

**Theme CSS changes not taking effect?**
`theme/player.css` / `theme/admin.css` are build outputs — edit `theme/<type>/<id>/theme.json` and run `node theme/build.js`.

## Update

- **Check for updates** in About → Update: compares GitHub Releases / npm / the remote `update.xml` manifest, showing the latest version and release notes
- **Running an update** is handled by a standalone process (`update.js`), started from the panel:
  1. **Backs up `data/`** first (data is never part of the update; `.gitignore` excludes it, and a backup is still made to `data/backup_update_<ts>/`)
  2. `git fetch` + `git pull --ff-only`
  3. **Verifies the `update.xml` manifest** (SHA-256 of every file; aborts if any mismatch, preventing partial updates)
  4. `npm install --production --package-lock=false`
  5. Verifies the version, then **restarts the service automatically** (stop old process, wait for the port, spawn the new one; `--no-restart` updates without restarting)
- `update.xml` is the version manifest (version + per-file SHA-256); regenerate it with `node tools/gen-update-xml.js "message"` before releasing
- On failure it rolls back safely: the data backup is kept, the old service keeps running, logs go to `data/update.log`, and code can be restored with `git checkout -- .`
- Docker deployments do not self-update; pull the new image manually

## License

MIT
