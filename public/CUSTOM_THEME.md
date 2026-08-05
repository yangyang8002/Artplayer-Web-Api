# 自定义主题指南

> 主题系统已迁移到 `theme/` 文件夹架构（theme.json + style.css + 构建脚本），
> 旧版「在 html 内联 CSS 变量」的方式已废弃。本指南基于当前架构。

播放器主题与后台主题各自独立，均以文件夹形式存放于 `theme/player/<id>/` 与 `theme/admin/<id>/`。

## 快速开始：创建「暗金」主题（播放器）

### 1. 创建主题文件夹

```
theme/player/dark-gold/
├── theme.json
└── style.css   （可选）
```

### 2. 编写 theme.json

```json
{
  "id": "dark-gold",
  "displayName": "暗金",
  "variables": {
    "--bg": "#0d0b08",
    "--surface": "#1a1610",
    "--bili-blue": "#d4a030",
    "--bili-blue-hover": "#e8b840",
    "--bili-pink": "#c08020",
    "--text": "#e8e0d0",
    "--text-dim": "#a09070",
    "--danger": "#c04030",
    "--gradient": "linear-gradient(135deg,#d4a030,#c08020)"
  }
}
```

`id` 只允许小写字母/数字/连字符；`variables` 的键可省略 `--` 前缀。

### 3. （可选）style.css 组件造型

```css
.art-settings { border-radius: 16px; }
.btn-primary { box-shadow: 0 0 14px rgba(212,160,48,.3); }
```

选择器会被自动作用域为 `[data-theme="dark-gold"] .xxx`。

### 4. 构建并生效

```bash
node theme/build.js
```

刷新播放器页面，「暗金」即出现在主题下拉框。默认主题通过服务器配置控制：

```bash
# data/config.json
{ "theme": "dark-gold" }
```

## 变量说明

### 播放器主题变量

| 变量 | 说明 |
|---|---|
| `--bg` | 页面背景色 |
| `--surface` | 卡片/面板背景 |
| `--bili-blue` | 主题主色（进度条、链接、hover） |
| `--bili-blue-hover` | 主色 hover |
| `--bili-pink` | 辅色（渐变配合、弹幕发送按钮） |
| `--text` | 正文颜色 |
| `--text-dim` | 次要文字 |
| `--danger` | 危险/删除色 |
| `--gradient` | 渐变色 |

### 后台主题变量（theme/admin/）

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

## 管理后台应用主题

```json
// data/config.json
{ "adminTheme": "dark-gold" }
```

或在后台「服务器配置」页的下拉框中选择。

## 常见问题

**修改了 theme.json 但页面没变化？**
`theme/player.css` / `theme/admin.css` 是构建产物，每次修改后必须运行 `node theme/build.js`。

**两个主题同 ID？**
ID 必须全局唯一，后者会覆盖前者。

## 参考

| 主题 | StyleKit 风格 | 特点 |
|------|-------------|------|
| cyber | 赛博动漫风 | 霓虹光效、全息投影感 |
| shoujo | 少女漫画风 | 柔粉浪漫、花瓣装饰 |
| jrpg | 日式RPG | 华丽边框、幻想风格 |
| neon | 霓虹武士风 | 锐利线条、霓虹光效 |

更多灵感请访问 https://www.stylekit.top/zh/collections/anime-manga

完整主题系统文档见 [theme/README.md](../theme/README.md)。
