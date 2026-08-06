# ArtPlayer Web API

**ArtPlayer 弹幕视频播放器 + Web 管理后台**

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Node.js + Express + [ArtPlayer](https://artplayer.org) 自托管弹幕视频播放系统，支持自研 Canvas 弹幕引擎、HLS/FLV 流媒体、API 限流与实时统计、PoW 防火墙、双主题系统、多字幕、文件管理。

**v26.8.3**

📖 [中文文档](README_CN.md) · 📖 [English Documentation](README_EN.md) · 🐳 [Docker 部署](DOCKER.md)

## Quick Start

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
npm install
npm start
```

| Page | URL |
|---|---|
| Player | `http://localhost:1919/player/` |
| Admin | `http://localhost:1919/admin/` |

**Default account:** `admin` / `admin123`（首次登录后请立即修改密码）

## Features

- 自研 Canvas 弹幕引擎：轨道调度、顶/底堆叠、密度/速度/透明度调节
- DPlayer 兼容弹幕 API（`/api/danmu/v3/`）
- 服务端分配 8 位唯一视频 ID，自动继承旧散列 ID 历史弹幕
- 多字幕自动检测（简/繁/日/英/韩…）与一键切换
- API 独立开关 / RPS 限速 / 带宽控制，1 秒精度实时曲线（跨度 5 分钟 ~ 3 个月）
- PoW 工作量证明防火墙、全局速率限制、登录限流
- 播放器 + 后台双主题系统（各 10 套，支持自定义导入）
- 管理后台：弹幕 / 视频 / 屏蔽词 / 文件 / 日志 / API 统计

## Documentation

- [README_CN.md](README_CN.md) — 完整中文文档（配置、API 参考、常见问题）
- [README_EN.md](README_EN.md) — Full English documentation
- [DOCKER.md](DOCKER.md) — Docker / docker-compose / Nginx 部署
- [theme/README.md](theme/README.md) — 主题系统与自定义主题指南

## License

MIT
