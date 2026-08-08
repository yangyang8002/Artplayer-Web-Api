# ArtPlayer Web API 中文文档

<p align="center"><img src="https://cdn.jsdelivr.net/gh/yangyang8002/Artplayer-Web-Api@master/public/favicon.svg" width="96" height="96" alt="ArtPlayer Web API"></p>

<p align="center">
  <a href="https://github.com/yangyang8002/Artplayer-Web-Api/releases"><img src="https://img.shields.io/github/v/release/yangyang8002/Artplayer-Web-Api.svg?color=62d5ff&label=version" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-green.svg" alt="Node.js"></a>
  <a href="Dockerfile"><img src="https://img.shields.io/badge/Docker-Ready-blue.svg" alt="Docker"></a>
  <a href="#数据库支持"><img src="https://img.shields.io/badge/Databases-JSON%20%7C%20SQLite%20%7C%20MySQL%20%7C%20PostgreSQL%20%7C%20MongoDB-ff85a2.svg" alt="Databases"></a>
  <a href="https://www.npmjs.com/package/artplayer-web-api"><img src="https://img.shields.io/npm/v/artplayer-web-api?label=npm&color=cb3837" alt="npm"></a>
  <a href="https://github.com/yangyang8002/Artplayer-Web-Api"><img src="https://img.shields.io/github/stars/yangyang8002/Artplayer-Web-Api?style=social&label=Stars" alt="Stars"></a>
</p>

> 📖 [English](README_EN.md) · 🐳 [Docker 部署](DOCKER.md) · 🎨 [主题系统](theme/README.md)

基于 [ArtPlayer](https://artplayer.org) 的弹幕视频播放器 + Web 管理后台。自带自研 Canvas 弹幕引擎、多主题系统、PoW 防爬虫、API 限流与统计、文件管理、多字幕支持、多数据库存储。

**v26.8.8** · MIT License

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [中国用户加速](#中国用户加速)
- [目录结构](#目录结构)
- [数据库支持](#数据库支持)
- [播放器使用](#播放器使用)
- [管理后台](#管理后台)
- [服务器配置](#服务器配置)
- [API 参考](#api-参考)
- [主题](#主题)
- [Docker 部署](#docker-部署)
- [数据与备份](#数据与备份)
- [常见问题](#常见问题)

## 特性

- **弹幕播放器**：自研 Canvas 弹幕引擎（轨道调度、顶部/底部堆叠、密度/速度/透明度调节、暂停冻结、进度跳转）
- **DPlayer 兼容 API**：`/api/danmu/v3/?id=` 可直接对接现有 DPlayer 弹幕生态
- **服务端视频 ID**：`/api/video/resolve` 为每个视频分配 8 位唯一 ID（数字字母混合），自动继承旧散列 ID 的历史弹幕
- **多字幕**：自动检测同目录 `.srt/.vtt/.ass` 字幕并按语言（简繁日英韩...）分组，播放器内一键切换
- **六语言界面**：简体中文 / 繁體中文 / 文言 / English / 日本語 / Français，自动检测浏览器语言 + 手动切换，覆盖播放器与后台全部界面
- **安全中心**：IP 地理定位（ip2region 地址库自动更新，城市级精确到运营商）、世界地图分布、请求/流量异常检测、IP 封禁与白名单
- **双主题系统**：播放器主题与后台主题完全独立，各 10 套主题（含 StyleKit 动漫/漫画风格），支持自定义导入
- **Web 管理后台**：弹幕/视频/屏蔽词/文件/日志/API 统计/数据库管理/备份管理/**字幕管理** 一站式管理
- **API 管理**：每个 API 独立开关、RPS 限速、带宽统计；1 秒精度实时曲线，时间跨度可调（5 分钟 ~ 3 个月）
- **安全防护**：PoW 工作量证明（Anubis 同款）、登录令牌、登录限流、全局速率限制
- **文件管理**：在线预览、批量删除/复制、压缩（zip/7z/tar/tar.gz）、解压（多格式）、多文件上传
- **多数据库存储**：JSON 文件（默认）/ SQLite / MySQL / MariaDB / PostgreSQL / MongoDB 六种存储后端，任意互转、热切换自动迁移

## 快速开始

### 方式一：npm 安装（推荐）

```bash
npm install -g artplayer-web-api
artplayer-web-api                 # 全局命令
# 或无需安装直接运行
npx artplayer-web-api
```

### 方式二：Docker 镜像（Docker Hub / GHCR）

```bash
# Docker Hub
docker run -d --name artplayer-web-api -p 1919:1919 -v "$(pwd)/data:/app/data" yangyang8002/artplayer-web-api:latest

# GHCR（GitHub Container Registry）
docker run -d --name artplayer-web-api -p 1919:1919 -v "$(pwd)/data:/app/data" ghcr.io/yangyang8002/artplayer-web-api:latest
```

### 方式三：源码运行

```bash
git clone https://github.com/yangyang8002/Artplayer-Web-Api.git
cd Artplayer-Web-Api

# 安装依赖
npm install

# 启动（默认端口 1919）
npm start
# 或指定端口
PORT=8080 node server.js
```

| 页面 | 地址 |
|---|---|
| 播放器 | http://localhost:1919/player/ |
| 管理后台 | http://localhost:1919/admin/ |
| 默认账号 | `admin` / `admin123` |

> 首次启动自动创建 `data/` 目录及默认数据文件，默认账号已初始化。**首次启动会强制进入初始化向导**：依次选择界面语言、时区、存储类型（数据库，可选 JSON/SQLite/MySQL/MariaDB/PostgreSQL/MongoDB），然后设置管理员新密码与自定义后台入口路径；完成后才可使用后台（**上线前请务必完成初始化**）。

## 中国用户加速

- **GitHub 加速**（clone / 下载 / raw 通用）：在原始 GitHub 链接前加 `https://fast.fumor.top/`

  ```bash
  git clone https://fast.fumor.top/https://github.com/yangyang8002/Artplayer-Web-Api.git
  ```

- **Docker Hub 镜像加速**（南大源）：将镜像前缀替换为 `docker.nju.edu.cn/`

  ```bash
  docker pull docker.nju.edu.cn/yangyang8002/artplayer-web-api:latest
  ```

- **GHCR 镜像加速**（南大源）：`docker.nju.edu.cn/ghcr.io/` 前缀

  ```bash
  docker pull docker.nju.edu.cn/ghcr.io/yangyang8002/artplayer-web-api:latest
  ```

> 镜像已同时发布到 Docker Hub、GHCR 与 npm；国内拉取镜像建议使用上述南大源加速。

## 目录结构

```
Artplayer-Web-Api/
├── server.js               # Express 服务端（全部 API）
├── lib/                    # 统一存储层
│   ├── store.js            # 存储抽象（JSON/SQLite/MySQL/PostgreSQL）+ 迁移工具
│   └── backends/           # 各数据库后端
├── package.json
├── public/                 # 前端静态资源
│   ├── player.html         # 播放器页面（自研 DanmakuEngine）
│   ├── admin.html          # 管理后台
│   ├── test_video1.mp4     # 测试视频
│   └── test_video1.*.vtt   # 测试多语言字幕
├── theme/                  # 主题系统（详见 theme/README.md）
│   ├── build.js            # 构建脚本
│   ├── player.css          # 构建产物
│   ├── admin.css
│   ├── player/<id>/        # 播放器主题（theme.json + style.css）
│   └── admin/<id>/         # 后台主题
└── data/                   # 运行时数据
    ├── danmu.json          # 弹幕数据（JSON 存储模式）
    ├── banned_words.json   # 屏蔽词
    ├── videos.json         # 视频 ID 映射表（vid → url）
    ├── accounts.json       # 账号（sha256 加盐）
    ├── config.json         # 服务器配置（含数据库连接配置）
    ├── api-stats.json      # API 统计（自动保存）
    └── app.db              # SQLite 模式下的数据库文件（可选）
```

## 数据库支持

系统内置 **JSON 文件 / SQLite / MySQL / MariaDB / PostgreSQL / MongoDB** 六种存储后端，管理后台「数据库管理」分栏可随时查看与切换。

### 支持的数据

| 数据 | 说明 |
|---|---|
| 弹幕 | 全量弹幕（含发送者、颜色、位置、时间戳） |
| 视频映射 | vid → url 映射表 |
| 字幕库 | 字幕数据库（ID/名称/语言/内容/本地化状态）+ 视频字幕关联 |
| 屏蔽词 | 关键词列表（含订阅词库） |
| 账号 | 管理员账号（scrypt 加盐哈希） |
| IP 数据 | 封禁 / 白名单、登录记录、登录失败锁定、IP 请求统计 |
| 统计 | API / IP 访问统计（1s 精度时间桶） |

### 切换与迁移

- 后台 → 数据库管理 → 切换存储，选择目标类型（SQLite 只需填文件路径，MySQL/MariaDB/PostgreSQL/MongoDB 填连接参数），点击「切换并迁移」
- 切换时自动把当前存储的全部数据迁移到目标存储（JSON ↔ SQLite ↔ MySQL ↔ MariaDB ↔ PostgreSQL ↔ MongoDB **任意互转**），无需重启服务，迁移期间暂停写入
- 密码留空沿用已保存的连接密码；可先「测试连接」再切换
- **自动迁移**：在 `config.json` 配置 `db.type` 后重启，若目标库为空且 `data/` 下 JSON 有数据，会自动同步一次（老用户升级零操作）
- 数据浏览：可浏览每张表的内容（弹幕/视频/屏蔽词/账号/封禁白名单/登录记录/统计）
- 导出备份：一键导出全部数据为 JSON 备份文件

### 配置示例（config.json）

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

> `type` 可选 `json`（默认）/ `sqlite` / `mysql` / `mariadb` / `postgres` / `mongodb`。MongoDB 的 user/password 可留空（无认证部署）；连接参数也可全部在后台填写保存，无需手改配置。

### 安全建议

- **数据库账号最小权限**：为系统创建专用数据库账号（如 `artplayer`），**不要使用 `root` / `postgres` 超级账号**；建议仅授予目标库的读写权限
- **连接密码**保存在 `data/config.json` 中（明文），请确保 `data/` 目录权限收紧（Linux 建议 `chmod 700 data`），并妥善备份；后台「数据库管理」界面对密码一律脱敏显示
- 数据管理接口（切换/测试/导出/浏览）全部要求管理员令牌，未登录一律 401；表浏览仅限系统白名单表，SQL 全部参数化
- 管理员账号请**立即修改默认密码**，建议开启 PoW 防火墙与速率限制（服务器配置页）
- 切换数据库后，旧的存储数据仍保留在原处（JSON 文件 / 旧数据库），如需清理请自行删除

## 播放器使用

### URL 参数

```
/player/?url=/test_video1.mp4
/player/?url=https://example.com/a.m3u8&vid=xxx&title=标题
/player/?url=/test_video1.mp4&subtitle=/test_video1.en.vtt
```

| 参数 | 说明 |
|---|---|
| `url` | 视频地址（本地路径或 http/https），支持 mp4/flv/m3u8(HLS) |
| `vid` | 视频 ID（可选，缺省时服务端自动解析/分配） |
| `subtitle` | 指定字幕（可选，缺省时自动检测）：文件路径 / 字幕链接 / 字幕库 ID（`id:xxxx`） |
| `title` | 自定义标题 |

### 弹幕设置

右上设置菜单：

| 设置 | 说明 |
|---|---|
| 弹幕开关 | 显示/隐藏全部弹幕 |
| 透明度 | 20% ~ 100% |
| 速度 | 3s ~ 15s（单条滚动时长） |
| 数量 | 5% ~ 100%（密度） |
| 顶/底堆叠 | 10% ~ 100%（顶部/底部弹幕堆叠深度） |
| 底边距 | 0% ~ 100%（弹幕与底部遮挡区距离） |

所有设置自动持久化到 `localStorage`。

### 字幕

- 自动检测与视频同名的 `.srt/.vtt/.ass/.webvtt` 字幕文件
- 按文件名语言后缀分组：`视频.sc.srt`（简体）、`视频.tc.srt`（繁体）、`视频.en.vtt`（英文）等
- 设置菜单中可切换字幕、调整字号（14-32px）与底距（5-80px）

### 字幕库（字幕管理）

后台「字幕管理」分栏提供独立的**字幕数据库**：

- 每个字幕有独立 **ID**（`s` + 7 位随机字符），支持三种来源：
  - **链接**：远程字幕 URL，可一键「本地化」下载到服务器（`data/subtitles/`）
  - **文本内容**：直接粘贴 WEBVTT/SRT 内容
  - **上传文件**：本地上传 srt/vtt/ass/ssa/webvtt（自动识别语言）
- **应用到视频**：一个视频可应用多个字幕（多语言）；视频即使应用了字幕，仍会**同时扫描视频链接同目录**的字幕并合并展示
- 播放器加载字幕库字幕：`/player/?url=...&subtitle=id:xxxx` 或由视频自动检测（`subtitle:id` 由服务端 `/api/subtitle/by-id` 输出）
- **OpenList/AList 同目录字幕**：视频 URL 属于已配置的 OpenList 云端实例（`/d/` 路径）时，自动用该实例 API 列出视频同目录的字幕文件（`视频.sc.srt` 等）并作为字幕选项
- 删除字幕时自动解除所有视频关联

### 视频 ID 机制

弹幕按视频 ID 归档。ID 由服务端统一分配：

```
GET /api/video/resolve?url=/test_video1.mp4
→ {"code":0,"data":{"vid":"a5sdkqcp","source":"new"}}
```

解析优先级：
1. `videos.json` 已有映射 → 返回原 ID（跨会话稳定）
2. 旧散列算法 ID 存在历史弹幕 → 继承旧 ID（**升级不丢弹幕**）
3. 全新视频 → 分配 8 位随机 ID（字符集去除易混淆 0/1/l/o/i）

也可在管理后台「视频管理」手动指定视频码。

## 管理后台

| 标签页 | 功能 |
|---|---|
| 屏蔽词管理 | 增删屏蔽词、搜索分页；订阅外部词库 URL（内置 GitHub 词库），定时/手动刷新 |
| 弹幕列表 | 按视频/关键词过滤、分页、单条删除 |
| 视频管理 | 视频 ID 映射增删、批量删除；关联字幕库字幕；一键生成并批量复制快捷代码（HTML iframe / Markdown / JS / 直链） |
| 字幕管理 | 字幕数据库：链接（可本地化）/文本/上传文件三种来源，独立字幕 ID，应用到视频、语言识别、删除 |
| 服务器配置 | PoW 开关与难度、速率限制、弹幕频率限制、渲染参数、会话时长、双主题、CDN 前缀 |
| 文件管理 | 目录浏览、文本预览（≤200KB）、批量删除/复制、压缩（zip/7z/tar/tar.gz）、解压（zip/7z/rar/gz/tar 等）、上传 |
| 日志 | 最近 500 条请求（时间/方法/路径/状态码/IP/耗时） |
| API 管理 | 每个 API 的开关、RPS、带宽；实时调用曲线（1s 精度，跨度 5 分钟 ~ 3 个月）；站点运行时间、总调用次数、总带宽 |
| 安全中心 | IP 归属地与地图分布、异常检测、封禁/白名单、登录记录与失败锁定 |
| 数据库管理 | 查看当前存储与各表数据量、切换存储（JSON/SQLite/MySQL/MariaDB/PostgreSQL/MongoDB）并自动迁移、测试连接、数据浏览、导出备份、**定时备份** |
| 关于 | 项目信息 |

后台可换主题（`adminTheme`），与播放器主题（`theme`）互不影响。

## 服务器配置

`data/config.json`（也可在后台「服务器配置」页修改）：

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

| 配置 | 说明 |
|---|---|
| `pow.enabled` | 开启后访问播放器前需完成 SHA-256 PoW 挑战（防爬虫） |
| `rateLimit` | 全局 API 速率限制（滑动窗口） |
| `danmakuLimit` | 单 IP 每分钟弹幕发送上限 |
| `danmaku.maxLength` | 弹幕内容最长字符（默认 500，1-2000） |
| `danmaku.authorMaxLength` | 弹幕作者名最长字符（默认 50，1-200） |
| `upload.maxMB` | 文件上传单文件大小上限（默认 200MB，1-2048） |
| `upload.previewKB` | 文件管理器文本预览大小上限（默认 200KB，超过不预览） |
| `render.maxPerSecond` | 弹幕渲染最大每秒发射数 |
| `api.apis` | 每个 API 的开关 / RPS / 带宽上限（KB/s），超限返回 429 |
| `api.retentionDays` | API 统计保留天数（1-90 天） |
| `security.adminPath` | 自定义后台路径（如 `"panel"` 则后台位于 `/panel/`） |
| `cdn` | 开启后播放器为相对路径视频自动拼接 CDN 前缀 |`n| `timezone` | 站点时区（IANA 名称，如 Asia/Shanghai），影响备份文件名等服务器时间 |`n| `language` | 站点默认界面语言（zh/zhHant/wyw/en/ja/fr） |

## API 参考

### 公开 API

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/api/danmu/v3/?id={vid}` | 获取弹幕（DPlayer 兼容格式数组） |
| GET | `/api/danmu/v3/{vid}` | 同上（路径参数） |
| GET | `/api/danmu/?id={vid}` | 获取弹幕（JSON 对象数组格式） |
| POST | `/api/danmu/` | 提交弹幕 `{id, text, color, type, time, author}` |
| POST | `/api/danmu/v3/` | 同上（v3） |
| GET | `/api/video/resolve?url=` | 解析/分配视频 ID |
| POST | `/api/video/map` | 手动记录 vid → url 映射 |
| GET | `/api/subtitle/detect?url=` | 检测同目录字幕 |
| POST | `/api/subtitle/external` | 加载外部字幕 |
| GET | `/api/config/public` | 公开配置（CDN/主题/渲染） |
| GET | `/api/theme/{player\|admin}/list` | 主题列表 |
| GET | `/api/theme/{player\|admin}.css` | 主题 CSS 包 |
| POST | `/api/pow/verify` | 校验 PoW 答案（通过后下发 cookie） |

### 管理 API（需 `Authorization: Bearer <token>`）

| 方法 | 端点 | 说明 |
|---|---|---|
| POST | `/api/admin/login` | 登录获取 token（5 次/分钟限流） |
| POST | `/api/admin/change-password` | 修改密码 |
| GET/POST | `/api/admin/config` | 读取/更新服务器配置 |
| GET | `/api/admin/danmu?vid=&page=` | 弹幕列表（分页） |
| GET | `/api/admin/danmu/vids` | 弹幕视频汇总 |
| DELETE | `/api/admin/danmu` | 删除弹幕 |
| GET/POST/DELETE | `/api/admin/banned-words` | 屏蔽词增删查（分页） |
| GET/POST/DELETE | `/api/admin/banned-words/subscriptions` | 词库订阅管理 |
| POST | `/api/admin/banned-words/refresh` | 手动刷新词库 |
| GET/POST/DELETE | `/api/admin/videos` | 视频映射管理 |
| GET | `/api/admin/files?path=` | 文件浏览/预览 |
| POST | `/api/admin/files/delete` | 批量删除 |
| POST | `/api/admin/files/copy` | 批量复制 |
| POST | `/api/admin/files/zip` | 压缩（zip/7z/tar/tar.gz） |
| POST | `/api/admin/files/unzip` | 解压（多格式） |
| POST | `/api/admin/files/upload` | 多文件上传 |
| GET | `/api/admin/logs?limit=` | 请求日志 |
| GET | `/api/admin/api/stats?span=` | API 统计（span=秒，30 ~ 7776000） |
| POST | `/api/admin/api` | 更新 API 规则/保留天数 |

## 主题

播放器与后台各 10 套主题：`bilibili / sakura / ocean / sunset / forest / mono / cyber / shoujo / jrpg / neon`。

自定义主题请参阅 [theme/README.md](theme/README.md)。

## Docker 部署

```bash
# 方式一：Docker Hub 拉取镜像
docker run -d --name artplayer-web-api -p 1919:1919 -v "$(pwd)/data:/app/data" yangyang8002/artplayer-web-api:latest

# 方式二：源码构建并启动
docker compose up -d --build

# 或直接构建
docker build -t artplayer-web-api .
docker run -d --name artplayer-web-api -p 1919:1919 -v "$(pwd)/data:/app/data" artplayer-web-api
```

数据通过 `./data:/app/data` 卷持久化。详细说明（含 Nginx 反代）见 [DOCKER.md](DOCKER.md)。

## 数据与备份

- **JSON 模式**：全部数据为 `data/` 下 JSON 文件，直接复制目录即可备份
- **SQL 模式**：数据在数据库表中（SQLite 数据库文件默认 `data/app.db`，与 JSON 文件同目录，随 `./data` 卷持久化）；MySQL/PostgreSQL 请按数据库常规方式备份
- 管理后台「数据库管理」可一键**导出备份**（全部数据 → JSON 文件下载）
- **定时自动备份**（备份管理分栏）：可配置间隔（小时）、保留份数、备份内容（数据库数据 / 服务器配置），备份文件保存在 `data/backups/`；支持随时手动备份、下载、删除，以及**从备份恢复**（单项或多项，按时间旧→新依次恢复；恢复数据覆盖当前存储，恢复配置时保留当前数据库连接与备份设置）
- **云端同步备份**（备份管理分栏）：支持 FTP / FTPS / SFTP / WebDAV / **OpenList（AList 兼容 API，如 fox.oplist.org）**，本地备份后自动同步到云端；云端备份可列表、下载到本地、下载并恢复、删除；连接可先测试
- API 统计每分钟自动持久化，进程退出时保存；重启后历史统计不丢失

## 常见问题

**弹幕不显示？**
确认视频 ID 一致（同一 URL 应解析到同一 ID）；检查后台「屏蔽词管理」中是否包含该文本；确认 API 管理页 `/api/danmu/` 未被停用。

**历史弹幕丢了？**
不会。`resolve` 会自动检测旧散列 ID 并继承，升级到新版本后旧弹幕依然可见。

**如何切换数据库？**
后台 → 数据库管理 → 选择目标存储 → 测试连接 → 切换并迁移，全程无需重启；也可在 `config.json` 的 `db` 字段配置后重启（首次会自动同步 JSON 数据）。

**切换数据库会不会丢数据？**
不会。切换是「整体迁移」：先完整导出当前存储，再写入目标存储，迁移完成才切换生效；迁移失败会自动回退，原存储数据不变。

**历史 JSON 数据里有重复弹幕 id？**
JSON 存储无主键约束，历史上可能产生重复 id 的记录。迁入 SQL 数据库时会自动按 id 去重（保留一条），这是唯一会被整理的数据。

**如何修改默认密码？**
后台 → 服务器配置页或直接编辑 `data/accounts.json`（salt + sha256）；若账号数据已存入数据库，请通过后台修改。

**CSS 主题修改不生效？**
`theme/player.css` / `theme/admin.css` 是构建产物，请修改 `theme/<type>/<id>/theme.json` 后运行 `node theme/build.js`。

## 版本更新

- 后台「关于 → 版本更新」可**检测更新**：对比 GitHub Releases / npm / 远程 `update.xml` 清单，显示最新版本与变更说明
- **执行更新**由独立进程 `update.js` 完成（后台点击后自动启动），流程：
  1. **备份 `data/`**（数据不参与更新，`.gitignore` 已忽略；更新前仍自动备份到 `data/backup_update_<时间戳>/`）
  2. `git fetch` + `git pull --ff-only`
  3. **校验 `update.xml` 清单**（65+ 个文件 SHA-256 哈希，与清单不符立即中止，防止部分更新）
  4. `npm install --production --package-lock=false`
  5. 校验版本号一致后**自动重启服务**（先停旧进程、等待端口释放、拉起新进程；`--no-restart` 可只更新不重启）
- `update.xml` 为版本清单（版本号 + 每个文件的 SHA-256 哈希），发布前用 `node tools/gen-update-xml.js "更新说明"` 重新生成
- 失败时安全回退：数据备份保留、旧服务继续运行、日志写入 `data/update.log`、可 `git checkout -- .` 还原代码
- Docker 部署不执行自更新，请手动 `docker pull yangyang8002/artplayer-web-api:latest`

## License

MIT
