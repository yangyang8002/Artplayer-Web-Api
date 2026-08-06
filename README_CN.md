# ArtPlayer Web API 中文文档

> 📖 [English](README_EN.md) · 🐳 [Docker 部署](DOCKER.md) · 🎨 [主题系统](theme/README.md)

基于 [ArtPlayer](https://artplayer.org) 的弹幕视频播放器 + Web 管理后台。自带自研 Canvas 弹幕引擎、多主题系统、PoW 防爬虫、API 限流与统计、文件管理、多字幕支持。

**v26.8.4** · MIT License

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [目录结构](#目录结构)
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
- **双主题系统**：播放器主题与后台主题完全独立，各 10 套主题（含 StyleKit 动漫/漫画风格），支持自定义导入
- **Web 管理后台**：弹幕/视频/屏蔽词/文件/日志/API 统计 一站式管理
- **API 管理**：每个 API 独立开关、RPS 限速、带宽统计；1 秒精度实时曲线，时间跨度可调（5 分钟 ~ 3 个月）
- **安全防护**：PoW 工作量证明（Anubis 同款）、登录令牌、登录限流、全局速率限制
- **文件管理**：在线预览、批量删除/复制、压缩（zip/7z/tar/tar.gz）、解压（多格式）、多文件上传

## 快速开始

### 方式一：npm 安装（推荐）

```bash
npm install -g artplayer-web-api
artplayer-web-api                 # 全局命令
# 或无需安装直接运行
npx artplayer-web-api
```

### 方式二：Docker Hub 镜像

```bash
docker run -d --name artplayer-web-api -p 1919:1919 -v "$(pwd)/data:/app/data" yangyang8002/artplayer-web-api:latest
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

> 首次启动自动创建 `data/` 目录及默认数据文件，默认账号已初始化（**上线前请务必修改密码**）。

## 目录结构

```
Artplayer-Web-Api/
├── server.js               # Express 服务端（全部 API）
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
└── data/                   # 运行时数据（JSON 持久化）
    ├── danmu.json          # 弹幕数据
    ├── banned_words.json   # 屏蔽词
    ├── videos.json         # 视频 ID 映射表（vid → url）
    ├── accounts.json       # 账号（sha256 加盐）
    ├── config.json         # 服务器配置
    └── api-stats.json      # API 统计（自动保存）
```

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
| `subtitle` | 指定字幕文件（可选，缺省时自动检测） |
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
| 视频管理 | 查看/新增/删除视频 ID 映射 |
| 服务器配置 | PoW 开关与难度、速率限制、弹幕频率限制、渲染参数、会话时长、双主题、CDN 前缀 |
| 文件管理 | 目录浏览、文本预览（≤200KB）、批量删除/复制、压缩（zip/7z/tar/tar.gz）、解压（zip/7z/rar/gz/tar 等）、上传 |
| 日志 | 最近 500 条请求（时间/方法/路径/状态码/IP/耗时） |
| API 管理 | 每个 API 的开关、RPS、带宽；实时调用曲线（1s 精度，跨度 5 分钟 ~ 3 个月）；站点运行时间、总调用次数、总带宽 |
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
| `render.maxPerSecond` | 弹幕渲染最大每秒发射数 |
| `api.apis` | 每个 API 的开关 / RPS / 带宽上限（KB/s），超限返回 429 |
| `api.retentionDays` | API 统计保留天数（1-90 天） |
| `security.adminPath` | 自定义后台路径（如 `"panel"` 则后台位于 `/panel/`） |
| `cdn` | 开启后播放器为相对路径视频自动拼接 CDN 前缀 |

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

- 全部数据为 `data/` 下 JSON 文件，直接复制目录即可备份
- API 统计每分钟自动持久化，进程退出时保存；重启后历史统计不丢失

## 常见问题

**弹幕不显示？**
确认视频 ID 一致（同一 URL 应解析到同一 ID）；检查后台「屏蔽词管理」中是否包含该文本；确认 API 管理页 `/api/danmu/` 未被停用。

**历史弹幕丢了？**
不会。`resolve` 会自动检测旧散列 ID 并继承，升级到新版本后旧弹幕依然可见。

**如何修改默认密码？**
后台 → 服务器配置页或直接编辑 `data/accounts.json`（salt + sha256）。

**CSS 主题修改不生效？**
`theme/player.css` / `theme/admin.css` 是构建产物，请修改 `theme/<type>/<id>/theme.json` 后运行 `node theme/build.js`。

## License

MIT
