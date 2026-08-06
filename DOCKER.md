# Docker 部署指南

> 📖 [中文文档](README_CN.md) · 📖 [English Documentation](README_EN.md)

## 方式一：Docker 镜像直接拉取（推荐）

官方镜像已发布到 **Docker Hub** 与 **GHCR（GitHub Container Registry）**：

```bash
# Docker Hub
docker run -d \
  --name artplayer-web-api \
  -p 1919:1919 \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  yangyang8002/artplayer-web-api:latest

# GHCR
docker run -d \
  --name artplayer-web-api \
  -p 1919:1919 \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  ghcr.io/yangyang8002/artplayer-web-api:latest
```

- 指定版本：`yangyang8002/artplayer-web-api:26.8.6`（tag 与 npm 包版本一致）
- 启动后访问播放器 `http://localhost:1919/player/`、后台 `http://localhost:1919/admin/`
- 镜像基于 `node:22-alpine`，仅生产依赖，自带健康检查

### 国内拉取加速（南大源）

```bash
# Docker Hub 南大源
docker pull docker.nju.edu.cn/yangyang8002/artplayer-web-api:latest
# GHCR 南大源
docker pull docker.nju.edu.cn/ghcr.io/yangyang8002/artplayer-web-api:latest
# 拉取后可重新打标使用
docker tag docker.nju.edu.cn/yangyang8002/artplayer-web-api:latest yangyang8002/artplayer-web-api:latest
```

## 方式二：docker-compose（源码构建）

```bash
git clone https://github.com/yangyang8002/Artplayer-Web-Api.git
cd Artplayer-Web-Api
docker compose up -d --build
```

- 服务名：`artplayer-api`，容器名：`artplayer-web-api`
- 映射端口 `1919:1919`，数据卷 `./data:/app/data`
- 自带健康检查（`/api/config/public`），失败自动重启（`restart: unless-stopped`）

## 方式三：Dockerfile 直接构建

```bash
docker build -t artplayer-web-api .
docker run -d \
  --name artplayer-web-api \
  -p 1919:1919 \
  -v "$(pwd)/data:/app/data" \
  artplayer-web-api
```

镜像基于 `node:22-alpine`，仅安装生产依赖，暴露 `1919` 端口，内置健康检查。

## 数据持久化

**务必挂载 `data/` 目录**，否则容器销毁后弹幕/配置/账号全部丢失：

| 文件 | 内容 |
|---|---|
| `data/danmu.json` | 弹幕数据 |
| `data/config.json` | 服务器配置 |
| `data/accounts.json` | 账号 |
| `data/videos.json` | 视频 ID 映射 |
| `data/api-stats.json` | API 统计 |

```bash
docker compose exec artplayer-api ls -la /app/data
docker compose cp artplayer-api:/app/data ./backup-data   # 备份
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `1919` | 服务端口（容器内） |
| `NODE_ENV` | `production` | 运行环境 |

## Nginx 反向代理

参考 [nginx.conf.example](nginx.conf.example)：

```nginx
location / {
    proxy_pass http://127.0.0.1:1919;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

配置 HTTPS 时取消 `nginx.conf.example` 中注释的 `server { listen 443 ssl ... }` 块，并填入证书路径。

## 升级

```bash
# 拉取镜像方式：直接更新镜像重启
docker pull yangyang8002/artplayer-web-api:latest
docker stop artplayer-web-api && docker rm artplayer-web-api
docker run -d --name artplayer-web-api -p 1919:1919 -v "$(pwd)/data:/app/data" yangyang8002/artplayer-web-api:latest

# 源码构建方式
git pull
docker compose up -d --build
```
数据卷不受影响，升级不会丢失弹幕与配置。
