'use strict';
/* ==========================================================================
 * 插件系统（参考 Koishi 插件模式）
 * 插件 = 函数 / 类 / 带 apply 的对象；加载时调用 apply(ctx, config)
 * ctx 提供：router（Express app，可挂路由/中间件）、store（数据存储）、
 *           getServerConfig、log、on('dispose')、plugin(嵌套)
 * 安装方式：上传 .js 文件 / GitHub 或任意 URL 下载 / npm 包
 * 持久化：data/plugins.json
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'plugins');
const STATE_FILE = path.join(ROOT, 'data', 'plugins.json');
const PLUGIN_NAME_RE = /^[a-zA-Z0-9_\-]{2,64}$/;
const PLUGIN_EXT_RE = /\.js$/;

class PluginManager {
    constructor({ app, store, readConfig, log }) {
        this.app = app;
        this.store = store;
        this.readConfig = readConfig || (() => ({}));
        this.log = log || ((m) => console.log('[插件] ' + m));
        this.meta = new Map();   /* name -> {enabled, config, source, installedAt, status, error} */
        this.instances = new Map(); /* name -> {ctx, disposeFns} */
        this.loading = new Set();
    }

    /* ---------- 状态持久化 ---------- */
    loadState() {
        try {
            const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (d && typeof d === 'object') {
                for (const [name, v] of Object.entries(d)) {
                    this.meta.set(name, {
                        enabled: !!v.enabled,
                        config: v.config || {},
                        source: v.source || { type: 'file', path: 'plugins/' + name + '.js' },
                        installedAt: v.installedAt || Date.now(),
                        status: 'stopped',
                        error: ''
                    });
                }
            }
        } catch (e) {}
        if (!fs.existsSync(PLUGIN_DIR)) fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    }
    saveState() {
        const out = {};
        for (const [name, m] of this.meta) {
            out[name] = { enabled: m.enabled, config: m.config, source: m.source, installedAt: m.installedAt };
        }
        try {
            fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2));
        } catch (e) { this.log('状态保存失败: ' + e.message); }
    }

    /* ---------- 插件上下文 ---------- */
    makeCtx(name, config, instRef) {
        const self = this;
        const disposeFns = [];
        /* 路由代理：包装插件 handler——仅当当前注册实例仍为活动实例时响应（热重载后旧实例路由自动失效） */
        const routerProxy = new Proxy(this.app, {
            get(target, prop) {
                if (['get', 'post', 'put', 'delete', 'patch', 'use'].includes(prop)) {
                    return (...args) => {
                        const last = args.length - 1;
                        const fn = args[last];
                        if (typeof fn === 'function') {
                            args[last] = function (...inner) {
                                if (self.instances.get(name) !== instRef.current) {
                                    const nxt = inner[inner.length - 1];
                                    if (typeof nxt === 'function') return nxt();
                                    return;
                                }
                                return fn.apply(this, inner);
                            };
                        }
                        return target[prop](...args);
                    };
                }
                const v = target[prop];
                return typeof v === 'function' ? v.bind(target) : v;
            }
        });
        const ctx = {
            name,
            config,
            router: routerProxy,
            store: self.store,
            getServerConfig: () => self.readConfig(),
            log: (msg) => self.log('[' + name + '] ' + msg),
            on(ev, fn) {
                if (ev === 'dispose' && typeof fn === 'function') disposeFns.push(fn);
                return fn;
            },
            plugin(plugin, pluginConfig) {
                /* 嵌套插件：同步调用 apply(ctx, cfg) */
                if (typeof plugin === 'function') {
                    if (/^class\s/.test(Function.prototype.toString.call(plugin))) new plugin(ctx, pluginConfig || {});
                    else plugin(ctx, pluginConfig || {});
                } else if (plugin && typeof plugin.apply === 'function') {
                    plugin.apply(ctx, pluginConfig || {});
                }
                return true;
            }
        };
        return { ctx, disposeFns, dispose() {
            for (const fn of disposeFns) { try { fn(); } catch (e) {} }
        } };
    }

    /* ---------- 模块解析：默认导出优先，其次导出整体 ---------- */
    _resolvePlugin(mod) {
        if (!mod) return null;
        if (mod.default && (typeof mod.default === 'function' || (mod.default && typeof mod.default.apply === 'function'))) return mod.default;
        if (typeof mod === 'function' || (mod && typeof mod.apply === 'function')) return mod;
        /* 导出整体 {name, apply, ...} */
        if (mod && typeof mod.apply === 'function') return mod;
        return null;
    }

    _applyModule(name, plugin, config) {
        if (typeof plugin === 'function') {
            /* 类（constructor(ctx, config)）还是函数？类有 prototype 且 new 调用 */
            if (/^class\s/.test(Function.prototype.toString.call(plugin))) {
                new plugin(ctxWrap(), config);
            } else {
                plugin(ctxWrap(), config);
            }
        } else if (plugin && typeof plugin.apply === 'function') {
            plugin.apply(ctxWrap(), config);
        }
        function ctxWrap() {
            /* 嵌套插件复用当前上下文风格 */
            const { ctx, disposeFns } = self._ctxFor(name);
            return ctx;
        }
        return true;
    }

    _ctxFor(name) {
        const inst = this.instances.get(name);
        return inst ? { ctx: inst.ctx, disposeFns: inst.disposeFns } : { ctx: null, disposeFns: [] };
    }

    /* ---------- 加载 / 卸载 ---------- */
    async load(name) {
        const meta = this.meta.get(name);
        if (!meta) throw new Error('插件不存在: ' + name);
        if (this.instances.has(name)) await this.unload(name);
        if (this.loading.has(name)) return;
        this.loading.add(name);
        meta.status = 'loading';
        meta.error = '';
        const instRef = { current: null };
        try {
            const entry = this.resolveEntry(meta.source);
            const abs = path.resolve(ROOT, entry);
            if (!fs.existsSync(abs)) throw new Error('插件文件不存在: ' + entry);
            /* 清除 require 缓存实现热加载 */
            delete require.cache[require.resolve(abs)];
            const mod = require(abs);
            const plugin = this._resolvePlugin(mod);
            if (!plugin) throw new Error('插件导出无效（需要函数/类/带 apply 的对象）');
            const { ctx, disposeFns } = this.makeCtx(name, meta.config, instRef);
            const inst = { ctx, disposeFns };
            instRef.current = inst;
            if (typeof plugin === 'function') {
                if (/^class\s/.test(Function.prototype.toString.call(plugin))) new plugin(ctx, meta.config);
                else plugin(ctx, meta.config);
            } else if (plugin && typeof plugin.apply === 'function') {
                plugin.apply(ctx, meta.config);
            }
            this.instances.set(name, inst);
            meta.status = 'running';
            this.log('已加载: ' + name);
        } catch (e) {
            meta.status = 'error';
            meta.error = String((e && e.message) || e).slice(0, 300);
            this.log('加载失败: ' + name + ' -> ' + meta.error);
        } finally {
            this.loading.delete(name);
        }
        this.saveState();
    }

    async unload(name) {
        const inst = this.instances.get(name);
        if (inst) {
            if (typeof inst.dispose === 'function') {
                try { inst.dispose(); } catch (e) {}
            } else {
                for (const fn of inst.disposeFns || []) { try { fn(); } catch (e) {} }
            }
            this.instances.delete(name);
        }
        const meta = this.meta.get(name);
        if (meta) { meta.status = 'stopped'; meta.error = ''; }
        this.log('已卸载: ' + name);
    }

    /* ---------- 启动时加载已启用插件 ---------- */
    async loadEnabled() {
        for (const [name, meta] of this.meta) {
            if (meta.enabled) await this.load(name);
        }
    }

    /* ---------- 安装 ---------- */
    async install({ source, fileContent, filename, url, pkg }) {
        const name = this.installName(source, filename, url, pkg);
        if (!name || !PLUGIN_NAME_RE.test(name)) throw new Error('无效的插件名称');
        let entry = '';
        if (source === 'file') {
            if (!fileContent) throw new Error('缺少插件文件内容');
            if (!PLUGIN_EXT_RE.test(filename || '')) throw new Error('仅支持 .js 文件');
            entry = 'plugins/' + name + '.js';
            const abs = path.join(ROOT, entry);
            if (fs.existsSync(abs)) throw new Error('插件已存在: ' + name + '（请先卸载）');
            fs.writeFileSync(abs, Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent));
        } else if (source === 'url') {
            if (!/^https?:\/\//i.test(url || '')) throw new Error('无效的下载链接');
            entry = 'plugins/' + name + '.js';
            const abs = path.join(ROOT, entry);
            if (fs.existsSync(abs)) throw new Error('插件已存在: ' + name + '（请先卸载）');
            const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) throw new Error('下载失败: HTTP ' + resp.status);
            fs.writeFileSync(abs, Buffer.from(await resp.arrayBuffer()));
        } else if (source === 'npm') {
            if (!/^[@a-zA-Z0-9_\-./]+$/.test(pkg || '')) throw new Error('无效的 npm 包名');
            if (!fs.existsSync(PLUGIN_DIR)) fs.mkdirSync(PLUGIN_DIR, { recursive: true });
            try {
                execSync('npm install --prefix "' + PLUGIN_DIR + '" "' + pkg + '" --no-audit --no-fund', { stdio: 'pipe', timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
            } catch (e) {
                throw new Error('npm 安装失败: ' + String((e && (e.stdout || e.message)) || e).slice(-200));
            }
            entry = 'plugins/node_modules/' + pkg;
            if (name === pkg.replace(/^.*\//, '')) name = pkg.replace(/^.*\//, '').replace(/[^\w-]/g, '_');
        } else {
            throw new Error('未知安装方式');
        }
        this.meta.set(name, {
            enabled: false, config: {}, source: { type: source, path: entry, url: url || '', pkg: pkg || '' },
            installedAt: Date.now(), status: 'stopped', error: ''
        });
        this.saveState();
        return name;
    }

    installName(source, filename, url, pkg) {
        if (source === 'file') {
            const base = path.basename(filename || '').replace(/\.js$/i, '');
            return base.replace(/[^a-zA-Z0-9_\-]/g, '');
        }
        if (source === 'url') {
            const base = path.basename(new URL(url).pathname).replace(/\.js$/i, '');
            return (base && base !== 'blob' ? base : 'plugin_' + Date.now().toString(36)).replace(/[^a-zA-Z0-9_\-]/g, '');
        }
        if (source === 'npm') return (pkg || '').replace(/^.*\//, '').replace(/[^a-zA-Z0-9_\-]/g, '_');
        return '';
    }

    /* ---------- 卸载（删除文件） ---------- */
    async uninstall(name) {
        const meta = this.meta.get(name);
        if (!meta) throw new Error('插件不存在: ' + name);
        await this.unload(name);
        if (meta.source.type === 'npm') {
            try {
                execSync('npm uninstall --prefix "' + PLUGIN_DIR + '" "' + meta.source.pkg + '"', { stdio: 'pipe', timeout: 120000 });
            } catch (e) {}
        } else {
            const abs = path.join(ROOT, meta.source.path || ('plugins/' + name + '.js'));
            try { if (fs.existsSync(abs)) fs.rmSync(abs); } catch (e) {}
        }
        this.meta.delete(name);
        this.saveState();
        this.log('已卸载: ' + name);
    }

    /* ---------- 启停 / 配置 ---------- */
    async setEnabled(name, enabled) {
        const meta = this.meta.get(name);
        if (!meta) throw new Error('插件不存在: ' + name);
        meta.enabled = !!enabled;
        if (enabled) await this.load(name);
        else await this.unload(name);
        this.saveState();
    }
    async setConfig(name, config) {
        const meta = this.meta.get(name);
        if (!meta) throw new Error('插件不存在: ' + name);
        meta.config = (config && typeof config === 'object') ? config : {};
        this.saveState();
        if (meta.enabled) await this.load(name); /* 配置变更热重载 */
    }

    resolveEntry(source) {
        if (source.type === 'npm') return path.join('plugins', 'node_modules', source.pkg);
        return source.path || 'plugins/' + (source.name || '');
    }

    list() {
        return Array.from(this.meta.entries()).map(([name, m]) => ({
            name,
            enabled: m.enabled,
            status: m.status,
            error: m.error,
            config: m.config,
            source: m.source,
            installedAt: m.installedAt
        }));
    }
}

module.exports = { PluginManager, PLUGIN_DIR };
