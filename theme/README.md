# 主题系统

本项目支持**播放器主题**与**后台主题**两套完全独立的主题系统，主题以文件夹形式存放，可自由导入导出。

## 目录结构

```
theme/
├── build.js              # 构建脚本：theme.json + style.css → player.css / admin.css
├── player.css            # 构建产物（播放器主题包，勿手改）
├── admin.css             # 构建产物（后台主题包，勿手改）
├── player/               # 播放器主题
│   ├── bilibili/
│   │   ├── theme.json    # 主题变量定义
│   │   └── style.css     # （可选）组件样式
│   ├── cyber/
│   ├── shoujo/
│   └── ...               # 每个主题一个文件夹
└── admin/                # 后台主题（结构与 player/ 相同）
    ├── bilibili/
    ├── cyber/
    └── ...
```

## 内置主题

播放器与后台各 10 套主题：

| 主题 ID | 风格 |
|---|---|
| `bilibili` | 默认（哔哩哔哩蓝） |
| `sakura` | 樱花粉 |
| `ocean` | 海洋蓝 |
| `sunset` | 日落橙 |
| `forest` | 森林绿 |
| `mono` | 黑白极简 |
| `cyber` | 赛博动漫（霓虹光效） |
| `shoujo` | 少女漫画（柔粉浪漫） |
| `jrpg` | 日式 RPG（华丽边框） |
| `neon` | 霓虹武士（锐利线条） |

后 4 套灵感来自 [StyleKit Anime/Manga 合集](https://www.stylekit.top/zh/collections/anime-manga)。

## 主题结构

每个主题文件夹包含：

### theme.json（必填）

```json
{
  "id": "my-theme",
  "displayName": "我的主题",
  "variables": {
    "--bg": "#07070d",
    "--surface": "#14141f",
    "--bili-blue": "#00a1d6",
    "--bili-blue-hover": "#00b3e6",
    "--bili-pink": "#fb7299",
    "--text": "#e6e6ee",
    "--text-dim": "#9099a3",
    "--danger": "#ff4d6a",
    "--gradient": "linear-gradient(135deg, #00a1d6, #fb7299)"
  }
}
```

- `id`：唯一标识（URL/存储用，只能小写字母数字连字符，会写入 `data-theme` 属性）
- `displayName`：下拉框显示名称
- `variables`：CSS 变量映射（键自动补 `--` 前缀）

### style.css（可选，组件造型）

```css
/* 主题专属组件样式，选择器自动作用域到该主题 */
.card, .cfg-card { border-radius: 20px; }
.btn-primary { box-shadow: 0 0 14px rgba(0, 229, 255, .25); }
```

构建脚本自动将每个选择器包装为 `[data-theme="xxx"] .card, [data-theme="xxx"] .cfg-card { ... }`。

## 两种主题变量表

### 播放器主题（theme/player/*/theme.json）

| 变量 | 说明 |
|---|---|
| `--bg` | 页面背景 |
| `--surface` | 面板/卡片背景 |
| `--bili-blue` | 主题主色（进度条/高亮） |
| `--bili-blue-hover` | 主色悬停 |
| `--bili-pink` | 辅色（渐变配合） |
| `--text` | 正文 |
| `--text-dim` | 次要文字 |
| `--danger` | 危险色 |
| `--gradient` | 渐变 |

### 后台主题（theme/admin/*/theme.json）

| 变量 | 说明 |
|---|---|
| `--bg` | 页面背景 |
| `--sidebar` | 侧边栏背景 |
| `--surface` / `--surface2` | 卡片 / 输入框背景 |
| `--border` | 边框色 |
| `--text` / `--text2` / `--text3` | 三级文字 |
| `--primary` / `--primary2` / `--accent` | 三强调色 |
| `--danger` / `--success` / `--warn` | 状态色 |
| `--radius` / `--radius-sm` / `--radius-lg` | 三级圆角 |
| `--gradient` | 页面渐变背景 |
| `--corner` | 卡片装饰边角颜色 |

## 导入自定义主题

1. 创建文件夹 `theme/player/my-theme/`（后台主题为 `theme/admin/my-theme/`）
2. 放入 `theme.json`（必填）和 `style.css`（可选）
3. 运行构建：`node theme/build.js`
4. 刷新页面，主题出现在下拉框中（播放器主题由 `config.theme` 控制，后台由 `config.adminTheme` 控制）

## 构建

```bash
node theme/build.js
# 输出：
#   theme/player.css   → /api/theme/player.css
#   theme/admin.css    → /api/theme/admin.css
```

构建脚本会：
1. 读取 `theme/player/*/theme.json` 合并为 `[data-theme="id"]{...}` 变量块
2. 读取可选 `style.css`，选择器自动加主题作用域前缀
3. 输出为单个 CSS 包供页面加载

## API

| 端点 | 说明 |
|---|---|
| `GET /api/theme/player/list` | 播放器主题列表 `[{id, name}]` |
| `GET /api/theme/admin/list` | 后台主题列表 |
| `GET /api/theme/player.css` | 播放器主题 CSS 包 |
| `GET /api/theme/admin.css` | 后台主题 CSS 包 |

## 页面加载机制

- `player.html` / `admin.html` 通过 `<link href="/api/theme/*.css">` 加载主题包
- 切换主题 = 修改 `<html data-theme="xxx">`，CSS 自动生效
- 主题列表通过 `/api/theme/*/list` 动态渲染，新增主题无需改前端代码
