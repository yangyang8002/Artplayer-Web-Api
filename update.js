#!/usr/bin/env node
/* ==========================================================================
 * 独立更新进程（update.js）
 * 用法: node update.js [--no-restart] [--force]
 * 流程: 锁定 → 备份 data/ → git fetch/pull → 校验 update.xml 清单 →
 *       校验 data/ 未被改动 → npm install → 校验版本 → 重启服务（默认）
 * 说明: data/ 不参与更新；更新前自动备份到 data/backup_update_<时间戳>/
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'update.log');
const LOCK_FILE = path.join(DATA_DIR, '.update.lock');
const PORT = process.env.PORT || '1919';

const args = process.argv.slice(2);
const noRestart = args.includes('--no-restart');
const force = args.includes('--force');
const srcArg = (args.find(a => a.startsWith('--source=')) || '--source=auto').split('=')[1];
const source = ['git', 'npm'].includes(srcArg) ? srcArg : 'auto';

function log(msg) {
    const line = '[' + new Date().toISOString() + '] ' + msg;
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}
function sh(cmd, opts) {
    log('执行: ' + cmd);
    try {
        const r = execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 20 * 1024 * 1024, ...(opts || {}) });
        return { ok: true, out: String(r || '').trim() };
    } catch (e) {
        const out = String((e && (e.stdout || '')) || '') + String((e && (e.stderr || '')) || '');
        return { ok: false, out: out.trim() };
    }
}
function sha256(file) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}
/* 部署方式检测（auto 来源推断用） */
function detectDeploy() {
    if (fs.existsSync('/.dockerenv')) return 'docker';
    try {
        const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
        if (globalRoot && ROOT.startsWith(globalRoot)) return 'npm-global';
    } catch (e) {}
    return fs.existsSync(path.join(ROOT, '.git')) ? 'git-source' : 'source';
}

/* 简化 XML 解析：提取 version/message 与 file 列表 */
function parseUpdateXml(text) {    const ver = (text.match(/<version>([^<]+)<\/version>/) || [])[1] || '';
    const msg = (text.match(/<message>([\s\S]*?)<\/message>/) || [])[1] || '';
    const files = [];
    const re = /<file\s+path="([^"]+)"\s+sha256="([^"]+)"(?:\s+size="(\d+)")?\/>/g;
    let m;
    while ((m = re.exec(text))) files.push({ path: m[1], sha256: m[2], size: m[3] ? parseInt(m[3]) : 0 });
    return { version: ver, message: msg, files };
}
/* 备份 data/（跳过 ip2region xdb 大文件与备份自身） */
function backupData() {
    if (!fs.existsSync(DATA_DIR)) { log('data/ 不存在，跳过备份'); return null; }
    const dest = path.join(DATA_DIR, 'backup_update_' + Date.now());
    fs.mkdirSync(dest, { recursive: true });
    let n = 0;
    for (const name of fs.readdirSync(DATA_DIR)) {
        if (name.startsWith('backup_update_') || /\.xdb$/.test(name) || name === '.update.lock' || name === 'update.log') continue;
        const full = path.join(DATA_DIR, name);
        try {
            if (fs.statSync(full).isDirectory()) fs.cpSync(full, path.join(dest, name), { recursive: true });
            else fs.copyFileSync(full, path.join(dest, name));
            n++;
        } catch (e) { log('备份失败: ' + name + ' (' + e.message + ')'); }
    }
    log('已备份 data/ ' + n + ' 项 → ' + path.relative(ROOT, dest));
    return dest;
}
/* 校验清单：本地文件与 update.xml 对比 */
function verifyManifest() {
    const xmlPath = path.join(ROOT, 'update.xml');
    if (!fs.existsSync(xmlPath)) { log('update.xml 不存在，跳过清单校验'); return { ok: true }; }
    let xml;
    try { xml = parseUpdateXml(fs.readFileSync(xmlPath, 'utf8')); } catch (e) { log('update.xml 解析失败'); return { ok: false, reason: 'update.xml 解析失败' }; }
    let bad = 0;
    for (const f of xml.files) {
        if (f.path.startsWith('data/')) continue;
        const full = path.join(ROOT, f.path);
        const h = sha256(full);
        if (h !== f.sha256) { log('文件校验失败: ' + f.path); bad++; }
    }
    if (bad) return { ok: false, reason: bad + ' 个文件与清单不符' };
    log('清单校验通过（' + xml.files.length + ' 个文件）');
    return { ok: true, xml };
}
/* 找到并停止当前服务进程 */
function findServerPid() {
    try {
        const out = execSync('netstat -ano', { encoding: 'utf8' });
        const line = out.split(/\r?\n/).find(l => l.includes(':' + PORT) && l.includes('LISTENING'));
        if (!line) return null;
        const m = line.match(/LISTENING\s+(\d+)\s*$/);
        return m ? m[1] : null;
    } catch (e) { return null; }
}
function stopServer() {
    const pid = findServerPid();
    if (!pid) { log('未发现端口 ' + PORT + ' 的服务进程（可能已停止）'); return true; }
    log('停止旧服务进程 PID=' + pid);
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
        } else {
            try { process.kill(parseInt(pid), 'SIGTERM'); } catch (e) {}
        }
        return true;
    } catch (e) { log('停止失败: ' + e.message); return false; }
}
function startServer() {
    log('启动新版本服务（PORT=' + PORT + '）...');
    const child = require('child_process').spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT },
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    log('新服务已启动 PID=' + child.pid);
}

/* 从 npm 更新：下载 artplayer-web-api 包并覆盖项目文件（排除 data/ node_modules/ .git/ 与更新自身） */
function npmUpdate() {
    const tmp = path.join(ROOT, '.update_npm_' + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    try {
        let r = sh('npm pack artplayer-web-api@latest --pack-destination ' + tmp);
        if (!r.ok) throw new Error('npm pack 失败: ' + r.out.slice(-300));
        const tgz = fs.readdirSync(tmp).find(f => f.endsWith('.tgz'));
        if (!tgz) throw new Error('未找到下载的 npm 包');
        const version = tgz.replace(/^artplayer-web-api-/, '').replace(/\.tgz$/, '');
        log('已下载 npm 包 ' + tgz + '（版本 ' + version + '）');
        /* 解压：优先系统 tar（Windows 10+ 自带），回退 7za 两步解压 */
        let exe = '';
        try { exe = require('7zip-bin').path7za; } catch (e) {}
        let pkgDir = path.join(tmp, 'package');
        if (!fs.existsSync(pkgDir)) {
            r = sh('tar -xzf "' + tmp + '/' + tgz + '" -C "' + tmp + '"');
            if (!r.ok) {
                if (exe) {
                    r = sh('"' + exe + '" x "' + tmp + '/' + tgz + '" -o"' + tmp + '" -y');
                    if (!r.ok) throw new Error('解压失败: ' + r.out.slice(-300));
                    const tar = fs.readdirSync(tmp).find(f => f.endsWith('.tar'));
                    if (tar) {
                        r = sh('"' + exe + '" x "' + tmp + '/' + tar + '" -o"' + tmp + '" -y');
                        if (!r.ok) throw new Error('解压失败: ' + r.out.slice(-300));
                    }
                } else {
                    throw new Error('解压失败: ' + r.out.slice(-300));
                }
            }
        }
        if (!fs.existsSync(pkgDir)) throw new Error('npm 包结构异常（无 package/ 目录）');
        /* 覆盖项目文件（先清空会随版本变化的目录，再复制；包中不存在的目录跳过） */
        const dirs = ['lib', 'public', 'theme'];
        for (const d of dirs) {
            const srcDir = path.join(pkgDir, d);
            if (!fs.existsSync(srcDir)) { log('跳过（npm 包中不存在）: ' + d); continue; }
            const dest = path.join(ROOT, d);
            if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
            fs.cpSync(srcDir, dest, { recursive: true });
        }
        const files = ['server.js', 'package.json', 'package-lock.json', 'nginx.conf.example', 'gen_perf_danmu.js', 'README.md', 'README_CN.md', 'README_EN.md', 'DOCKER.md', 'LICENSE'];
        for (const f of files) {
            const src2 = path.join(pkgDir, f);
            if (fs.existsSync(src2)) fs.copyFileSync(src2, path.join(ROOT, f));
        }
        log('文件已覆盖（版本 ' + version + '）');
        /* 安装依赖 */
        r = sh('npm install --production --no-audit --no-fund --package-lock=false');
        if (!r.ok) throw new Error('npm install 失败: ' + r.out.slice(-300));
        return { ok: true, version };
    } catch (e) {
        return { ok: false, reason: e.message };
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    }
}

/* ==================== 主流程 ==================== */
(async () => {
    /* 0. 锁定（防并发更新） */
    if (fs.existsSync(LOCK_FILE)) {
        const t = fs.statSync(LOCK_FILE).mtimeMs;
        if (Date.now() - t < 10 * 60 * 1000) { log('已有更新进程在运行（' + LOCK_FILE + '），退出'); process.exit(1); }
        log('清理过期锁');
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    log('更新进程启动（' + (noRestart ? '不重启' : '自动重启') + '）');

    try {
        /* 1. 备份 data/（数据保护：更新不涉及 data/，备份兜底） */
        const backup = backupData();

        /* 2. 确定更新来源（auto 按部署方式推断） */
        let useSource = source;
        if (useSource === 'auto') useSource = detectDeploy() === 'npm-global' ? 'npm-global' : 'git';
        log('更新来源: ' + useSource + (source === 'auto' ? '（自动）' : ''));

        let manifest = null, newVer = '';
        if (useSource === 'git') {
            /* git 拉取 */
            let r = sh('git fetch origin');
            if (!r.ok) { log('git fetch 失败: ' + r.out.slice(-300)); log('已中止（数据已备份至 ' + path.relative(ROOT, backup) + '）'); process.exit(1); }
            r = sh('git pull --ff-only');
            if (!r.ok) {
                log('git pull 失败（可能有本地未提交改动）: ' + r.out.slice(-300));
                log('可执行 git checkout -- . 放弃本地代码改动后重试；data/ 数据不受影响');
                process.exit(1);
            }
            /* 校验清单 */
            manifest = verifyManifest();
            if (!manifest.ok && !force) { log('清单校验未通过，已中止: ' + manifest.reason); process.exit(1); }
            /* 依赖安装（--package-lock=false 避免改动 lockfile 导致清单失配） */
            r = sh('npm install --production --no-audit --no-fund --package-lock=false');
            if (!r.ok) { log('npm install 失败: ' + r.out.slice(-300)); process.exit(1); }
        } else if (useSource === 'npm') {
            /* npm 包更新：下载解压覆盖 */
            const res = npmUpdate();
            if (!res.ok) { log('npm 更新失败: ' + res.reason); process.exit(1); }
        } else if (useSource === 'npm-global') {
            /* npm 全局安装更新 */
            const r = sh('npm install -g artplayer-web-api@latest --no-audit --no-fund');
            if (!r.ok) { log('npm 全局更新失败: ' + r.out.slice(-300)); process.exit(1); }
        } else {
            log('未知更新来源: ' + useSource);
            process.exit(1);
        }

        /* 版本校验 */
        try { newVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (e) {}
        log('更新完成，当前版本: ' + newVer + (manifest && manifest.xml && manifest.xml.version && manifest.xml.version !== newVer ? '（清单版本 ' + manifest.xml.version + '，可能未同步）' : ''));

        /* 7. 重启（默认） */
        if (noRestart) {
            log('完成（--no-restart，未重启服务）');
            fs.unlinkSync(LOCK_FILE);
            process.exit(0);
        }
        const stopped = stopServer();
        if (!stopped) { log('旧服务停止失败'); }
        /* 等待端口释放 */
        for (let i = 0; i < 20; i++) {
            if (!findServerPid()) break;
            await new Promise(r => setTimeout(r, 500));
        }
        startServer();
        log('全部完成');
        fs.unlinkSync(LOCK_FILE);
        process.exit(0);
    } catch (e) {
        log('更新异常: ' + e.message);
        try { fs.unlinkSync(LOCK_FILE); } catch (x) {}
        process.exit(1);
    }
})();
