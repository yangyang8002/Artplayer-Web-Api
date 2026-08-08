'use strict';
/* ==========================================================================
 * OpenVideoAPI 插件系统（Koishi 风格）
 *
 * 插件 = npm 包（或 plugins/ 下的本地包目录），包内 main 导出 apply(ctx, config)
 * （函数 / 类 / 带 apply 的对象）。包元数据位于 package.json 的 openvideoPlugin 字段：
 *
 *   {
 *     "openvideoPlugin": {
 *       "name": "demo",                          // 显示名（缺省取包名）
 *       "description": "...",                    // 展示用描述
 *       "inject": ["store", "app", "logger"],    // 依赖的服务（自动按依赖排序加载）
 *       "provide": ["stats"],                    // 本插件提供的服务名（ctx.provide 注册）
 *       "schema": [...],                         // 配置表单（同前版 schema 数组）
 *       "client": {
 *         "admin":  { "styles": [...], "scripts": [...], "tabs": [{id,title}] },
 *         "player": { "styles": [...], "scripts": [...], "replaces": false }
 *       }
 *     }
 *   }
 *
 * ctx 能力：
 *   router         Express 路由（热重载后旧实例路由自动失效）
 *   store/model    数据存储 / 动态表（ctx.model.define(name, schema)）
 *   app            服务控制：version / restart / getConfig / saveConfig / uptime
 *   logger         分级日志（debug/info/warn/error + 环形缓冲，供调试工具使用）
 *   http           fetch 封装（get / post / json，带超时）
 *   config         当前插件配置
 *   on/emit        事件总线（danmu:send / ready / before:restart / dispose / 自定义）
 *   provide/service 服务注册与获取（插件间协作）
 *   plugin()       嵌套插件
 *   version        OpenVideoAPI 服务端版本
 *
 * 状态持久化：data/plugins.json；插件目录：plugins/（npm 包在 plugins/node_modules/）
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PLUGIN_DIR = process.env.OPENVIDEO_PLUGIN_DIR ? path.resolve(process.env.OPENVIDEO_PLUGIN_DIR) : path.join(ROOT, 'plugins');
const STATE_FILE = path.join(ROOT, 'data', 'plugins.json');
const PKG_NAME_RE = /^(@[a-zA-Z0-9-]+\/)?[a-zA-Z0-9_-]+$/;
const CLIENT_ASSET_RE = /\.(js|css)$/;

/* 内置服务名（插件不可覆写） */
const BUILTIN_SERVICES = ['store', 'model', 'app', 'logger', 'router', 'http', 'version', 'config', 'name', 'plugin', 'on', 'emit', 'provide', 'service'];

class PluginManager {
    constructor({ app, store, model, readConfig, saveConfig, restartServer, log, version, npmRegistry }) {
        this.app = app;
        this.store = store;
        this.model = model;
        this.readConfig = readConfig || (() => ({}));
        this.saveConfig = saveConfig || (async () => {});
        this.restartServer = restartServer || (async () => { throw new Error('重启服务不可用'); });
        this.npmRegistry = npmRegistry || (() => '');
        this.log = log || ((m) => console.log('[插件] ' + m));
        this.version = version || '';
        this.meta = new Map();      /* name -> {enabled, config, source, installedAt, status, error, info} */
        this.instances = new Map(); /* name -> {ctx, disposeFns} */
        this.loading = new Set();
        this.events = new Map();    /* event -> Set<{name, fn}> */
        this.services = new Map();  /* serviceName -> instance（内置 + 插件提供） */
        /* 内置服务：app/logger 由外部注入（server.js 构建） */
        this.services.set('store', store);
        this.services.set('model', model);
        this.services.set('app', null);   /* 由 server.js 通过 _injectServices 填充 */
        this.services.set('logger', null);
    }

    /* server.js 在创建后注入 app/logger 服务实例 */
    _injectServices(services) {
        for (const [k, v] of Object.entries(services || {})) this.services.set(k, v);
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
                        source: v.source || { type: 'local', name, version: '' },
                        installedAt: v.installedAt || Date.now(),
                        status: 'stopped',
                        error: '',
                        info: v.info || null
                    });
                }
            }
        } catch (e) {}
        if (!fs.existsSync(PLUGIN_DIR)) fs.mkdirSync(PLUGIN_DIR, { recursive: true });
        /* 自动发现本地插件包（plugins/ 下带 openvideoPlugin 或 main 的目录，未注册则加入为停用状态） */
        this.discoverLocal();
    }
    /* 扫描 plugins/ 下的本地插件包并自动注册（开发环境：新建插件目录即可被识别） */
    discoverLocal() {
        let added = 0;
        try {
            for (const d of fs.readdirSync(PLUGIN_DIR, { withFileTypes: true })) {
                if (!d.isDirectory() || d.name === 'node_modules' || d.name.startsWith('.')) continue;
                if (this.meta.has(d.name)) continue;
                const pkgFile = path.join(PLUGIN_DIR, d.name, 'package.json');
                if (!fs.existsSync(pkgFile)) continue;
                try {
                    const pj = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
                    if (!pj.openvideoPlugin && !pj.main) continue;
                    this.meta.set(d.name, {
                        enabled: false,
                        config: {},
                        source: { type: 'local', name: d.name, version: pj.version || '' },
                        installedAt: Date.now(),
                        status: 'stopped',
                        error: '',
                        info: null
                    });
                    added++;
                    this.log('自动发现本地插件: ' + d.name + (pj.version ? '@' + pj.version : ''));
                } catch (e) {}
            }
        } catch (e) {}
        if (added) this.saveState();
        return added;
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

    /* ---------- 包解析 ---------- */
    pkgDirOf(meta) {
        if (meta.source.type === 'npm') return path.join(PLUGIN_DIR, 'node_modules', meta.source.pkg);
        return path.join(PLUGIN_DIR, meta.source.name);
    }
    readPkg(meta) {
        const dir = this.pkgDirOf(meta);
        const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const manifest = (pj && pj.openvideoPlugin && typeof pj.openvideoPlugin === 'object') ? pj.openvideoPlugin : {};
        return {
            dir,
            name: manifest.name || pj.name,
            version: pj.version || '',
            description: manifest.description || pj.description || '',
            author: (typeof pj.author === 'object' ? pj.author.name : pj.author) || '',
            homepage: pj.homepage || '',
            main: pj.main || 'index.js',
            manifest,
            pkg: pj
        };
    }

    /* ---------- 事件总线 ---------- */
    _on(name, event, fn) {
        if (event === 'dispose') return;
        if (!this.events.has(event)) this.events.set(event, new Set());
        const h = { name, fn };
        this.events.get(event).add(h);
        return () => this.events.get(event).delete(h);
    }
    emit(event, ...args) {
        const set = this.events.get(event);
        if (!set) return;
        for (const h of Array.from(set)) {
            try { h.fn.apply(null, args); } catch (e) { this.log('[' + h.name + '] 事件 ' + event + ' 处理异常: ' + (e.message || e)); }
        }
    }
    _clearEvents(name) {
        for (const [ev, set] of this.events) {
            for (const h of set) if (h.name === name) set.delete(h);
        }
    }

    /* ---------- 插件上下文 ---------- */
    makeCtx(name, meta, info, config, instRef) {
        const self = this;
        const disposeFns = [];
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
        const http = {
            async get(url, opts) {
                return fetch(url, { signal: AbortSignal.timeout((opts && opts.timeout) || 15000), ...(opts || {}) });
            },
            async post(url, body, opts) {
                return fetch(url, {
                    method: 'POST',
                    signal: AbortSignal.timeout((opts && opts.timeout) || 15000),
                    headers: { 'Content-Type': 'application/json' },
                    body: typeof body === 'string' ? body : JSON.stringify(body || {}),
                    ...(opts || {})
                });
            },
            async json(url, opts) {
                const r = await this.get(url, opts);
                return r.ok ? r.json() : null;
            }
        };
        const ctx = {
            name,
            config,
            version: self.version,
            router: routerProxy,
            store: self.store,
            model: self.model,
            http,
            log: (msg) => self.log('[' + name + '] ' + msg),
            on(ev, fn) {
                if (ev === 'dispose' && typeof fn === 'function') disposeFns.push(fn);
                else self._on(name, ev, fn);
                return fn;
            },
            emit: (ev, ...args) => self.emit(ev, ...args),
            provide(serviceName, instance) {
                if (BUILTIN_SERVICES.includes(serviceName)) throw new Error('服务名 ' + serviceName + ' 为内置保留');
                self.services.set(serviceName, instance);
            },
            service(serviceName) {
                return self.services.get(serviceName) || null;
            },
            plugin(plugin, pluginConfig) {
                if (typeof plugin === 'function') {
                    if (/^class\s/.test(Function.prototype.toString.call(plugin))) new plugin(ctx, pluginConfig || {});
                    else plugin(ctx, pluginConfig || {});
                } else if (plugin && typeof plugin.apply === 'function') {
                    plugin.apply(ctx, pluginConfig || {});
                }
                return true;
            }
        };
        /* 把声明依赖（inject）的服务直接挂到 ctx 上：ctx.app / ctx.logger / ctx.stats ... */
        const inject = (info.manifest && Array.isArray(info.manifest.inject)) ? info.manifest.inject : [];
        for (const svc of inject) {
            if (svc in ctx) continue;
            if (self.services.has(svc)) ctx[svc] = self.services.get(svc);
        }
        return { ctx, disposeFns, dispose() {
            self._clearEvents(name);
            for (const fn of disposeFns) { try { fn(); } catch (e) {} }
        } };
    }

    /* ---------- 模块解析 ---------- */
    _resolvePlugin(mod) {
        if (!mod) return null;
        if (mod.default && (typeof mod.default === 'function' || (mod.default && typeof mod.default.apply === 'function'))) return mod.default;
        if (typeof mod === 'function' || (mod && typeof mod.apply === 'function')) return mod;
        return null;
    }

    /* ---------- 依赖解析：inject 服务 → 提供者插件，按拓扑序加载 ---------- */
    /* 返回 { order: [names], errors: [msg] } */
    planLoadOrder(names) {
        const providerOf = new Map();  /* serviceName -> pluginName */
        const providedBy = new Map();  /* pluginName -> [serviceName] */
        for (const [pname, pmeta] of this.meta) {
            if (!names.includes(pname)) continue;
            let manifest = (pmeta.info && pmeta.info.manifest) || {};
            if (!manifest.provide) {
                try { manifest = this.readPkg(pmeta).manifest; } catch (e) {}
            }
            const provides = Array.isArray(manifest.provide) ? manifest.provide : [];
            providedBy.set(pname, provides);
            for (const svc of provides) providerOf.set(svc, pname);
        }
        const order = [];
        const visited = new Set();
        const errors = [];
        const visit = (pname, stack) => {
            if (visited.has(pname)) return;
            if (stack.includes(pname)) { errors.push('循环依赖: ' + [...stack, pname].join(' → ')); return; }
            visited.add(pname);
            const m = this.meta.get(pname);
            let manifest = (m.info && m.info.manifest) || {};
            if (!manifest.inject) { try { manifest = this.readPkg(m).manifest; } catch (e) {} }
            const inject = Array.isArray(manifest.inject) ? manifest.inject : [];
            for (const svc of inject) {
                if (['store', 'model', 'app', 'logger', 'http', 'router', 'version'].includes(svc)) continue; /* 内置 */
                const provider = providerOf.get(svc);
                if (!provider) { errors.push('服务 ' + svc + ' 无提供者（' + pname + ' 依赖）'); continue; }
                visit(provider, [...stack, pname]);
            }
            order.push(pname);
        };
        for (const n of names) visit(n, []);
        return { order, errors };
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
            const info = this.readPkg(meta);
            const abs = path.join(info.dir, info.main);
            if (!fs.existsSync(abs)) throw new Error('插件入口不存在: ' + info.main);
            delete require.cache[require.resolve(abs)];
            const mod = require(abs);
            const plugin = this._resolvePlugin(mod);
            if (!plugin) throw new Error('插件导出无效（需要函数/类/带 apply 的对象）');
            /* 依赖检查（内置 ctx 成员与已注册服务均可满足） */
            const ctxBuiltins = ['store', 'model', 'app', 'logger', 'http', 'router', 'version', 'config', 'name', 'on', 'emit', 'provide', 'service', 'plugin'];
            for (const svc of info.manifest.inject || []) {
                if (ctxBuiltins.includes(svc)) continue;
                if (!this.services.has(svc)) throw new Error('依赖服务不可用: ' + svc);
            }
            meta.info = {
                package: { name: info.name, version: info.version, description: info.description, author: info.author, homepage: info.homepage, pkgName: meta.source.pkg || meta.source.name },
                manifest: info.manifest,
                main: info.main
            };
            const { ctx, disposeFns } = this.makeCtx(name, meta, info, meta.config, instRef);
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
            this.log('已加载: ' + name + '@' + info.version);
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
            try { inst.dispose(); } catch (e) {}
            this._clearEvents(name);
            this.instances.delete(name);
        }
        const meta = this.meta.get(name);
        if (meta) { meta.status = 'stopped'; meta.error = ''; }
        this.log('已卸载: ' + name);
    }

    /* ---------- 启动：按依赖拓扑序加载全部已启用插件，随后广播 ready ---------- */
    async loadEnabled() {
        const enabled = Array.from(this.meta.entries()).filter(([, m]) => m.enabled).map(([n]) => n);
        const { order, errors } = this.planLoadOrder(enabled);
        for (const e of errors) this.log('依赖警告: ' + e);
        for (const name of order) await this.load(name);
        /* 未进入拓扑序的（无依赖）直接加载 */
        for (const name of enabled) if (!order.includes(name)) await this.load(name);
        this.emit('ready');
    }

    /* ---------- 安装（仅支持 npm 包） ---------- */
    async install({ pkg, version }) {
        const pkgName = pkg || '';
        if (!PKG_NAME_RE.test(pkgName)) throw new Error('无效的 npm 包名');
        const spec = version ? pkgName + '@' + version : pkgName;
        const baseName = pkgName.replace(/^.*\//, '');
        if (this.meta.has(baseName)) throw new Error('插件已存在: ' + baseName);
        if (!fs.existsSync(PLUGIN_DIR)) fs.mkdirSync(PLUGIN_DIR, { recursive: true });
        const regArg = this.npmRegistry() ? '--registry="' + this.npmRegistry() + '"' : '';
        try {
            execSync('npm install --prefix "' + PLUGIN_DIR + '" "' + spec + '" --no-audit --no-fund ' + regArg, { stdio: 'pipe', timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
        } catch (e) {
            throw new Error('npm 安装失败: ' + String((e && (e.stdout || e.message)) || e).slice(-300));
        }
        /* 校验包结构：main 入口存在 */
        const dir = path.join(PLUGIN_DIR, 'node_modules', pkgName);
        let pj;
        try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { throw new Error('包内缺少 package.json'); }
        const main = pj.main || 'index.js';
        if (!fs.existsSync(path.join(dir, main))) throw new Error('包入口不存在: ' + main);
        this.meta.set(baseName, {
            enabled: false,
            config: {},
            source: { type: 'npm', pkg: pkgName, version: pj.version || version || '' },
            installedAt: Date.now(),
            status: 'stopped',
            error: '',
            info: null
        });
        this.saveState();
        return baseName;
    }

    /* ---------- 卸载 ---------- */
    async uninstall(name) {
        const meta = this.meta.get(name);
        if (!meta) throw new Error('插件不存在: ' + name);
        if (meta.enabled) await this.setEnabled(name, false);
        if (meta.source.type === 'npm') {
            try {
                execSync('npm uninstall --prefix "' + PLUGIN_DIR + '" "' + (meta.source.pkg || name) + '" --no-audit --no-fund ' + (this.npmRegistry() ? '--registry="' + this.npmRegistry() + '"' : ''), { stdio: 'pipe', timeout: 120000 });
            } catch (e) {}
        }
        this.meta.delete(name);
        this.saveState();
        this.log('已卸载: ' + name + (meta.source.type === 'local' ? '（本地包保留在目录，可删除 plugins/' + name + ' 彻底移除）' : ''));
    }

    /* ---------- 更新（保留配置与启用状态） ---------- */
    async update(name) {
        const meta = this.meta.get(name);
        if (!meta) throw new Error('插件不存在: ' + name);
        if (meta.source.type !== 'npm') throw new Error('仅 npm 包支持在线更新');
        const enabled = meta.enabled, config = meta.config;
        if (enabled) await this.unload(name);
        try {
            execSync('npm install --prefix "' + PLUGIN_DIR + '" "' + meta.source.pkg + '@latest" --no-audit --no-fund ' + (this.npmRegistry() ? '--registry="' + this.npmRegistry() + '"' : ''), { stdio: 'pipe', timeout: 300000 });
        } catch (e) {
            throw new Error('npm 更新失败: ' + String((e && (e.stdout || e.message)) || e).slice(-300));
        }
        meta.enabled = enabled;
        meta.config = config;
        meta.info = null;
        if (enabled) await this.load(name);
        this.saveState();
        this.log('已更新: ' + name);
    }

    /* ---------- 启停 / 配置 ---------- */
    async setEnabled(name, enabled) {
        const meta = this.meta.get(name);
        if (!meta) throw new Error('插件不存在: ' + name);
        if (enabled) {
            /* 自动启用依赖提供者（按拓扑序） */
            const { order, errors } = this.planLoadOrder([name]);
            for (const dep of order) {
                if (dep !== name) {
                    const dm = this.meta.get(dep);
                    if (dm && !dm.enabled) { dm.enabled = true; await this.load(dep); }
                }
            }
            for (const e of errors) this.log('依赖警告: ' + e);
        }
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
        if (meta.enabled) await this.load(name);
    }

    /* ---------- 存储切换后重建上下文绑定 ---------- */
    rebindStore(store, model) {
        this.store = store;
        this.model = model;
        this.services.set('store', store);
        this.services.set('model', model);
        for (const inst of this.instances.values()) {
            inst.ctx.store = store;
            inst.ctx.model = model;
        }
        if (model && typeof model.rebind === 'function') model.rebind(store);
    }

    /* ---------- 客户端扩展清单 ---------- */
    /* scope: 'admin' | 'player'；返回插件的前端资源列表（路径已按插件命名空间化） */
    clientManifest(scope) {
        const out = [];
        for (const [name, meta] of this.meta) {
            if (meta.status !== 'running' && !meta.enabled) continue;
            const info = meta.info;
            if (!info || !info.manifest) continue;
            const client = (info.manifest.client && info.manifest.client[scope]) || null;
            if (!client) continue;
            const base = '/api/plugins/client/' + scope + '/' + encodeURIComponent(meta.source.pkg || name);
            const styles = (client.styles || []).map(s => base + '/' + encodeURIComponent(String(s)));
            const scripts = (client.scripts || []).map(s => base + '/' + encodeURIComponent(String(s)));
            const tabs = (scope === 'admin' && Array.isArray(client.tabs)) ? client.tabs.slice(0, 20) : [];
            out.push({
                name,
                version: info.package.version,
                title: info.manifest.name || name,
                styles,
                scripts,
                tabs: tabs.map(t => ({ id: String(t.id).slice(0, 48), title: String(t.title || t.id).slice(0, 60) })),
                replaces: !!client.replaces
            });
        }
        return out;
    }

    /* 解析客户端资源文件路径（防目录穿越） */
    resolveClientAsset(pkgName, relPath) {
        if (!CLIENT_ASSET_RE.test(relPath)) throw new Error('仅允许 js/css 资源');
        const meta = this.meta.get(pkgName.replace(/^.*\//, '')) || this.meta.get(pkgName);
        if (!meta) throw new Error('插件未安装: ' + pkgName);
        const dir = this.pkgDirOf(meta);
        const full = path.resolve(dir, String(relPath).replace(/^\/+/, ''));
        if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error('非法路径');
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error('资源不存在');
        return full;
    }

    /* ---------- 列表 ---------- */
    list() {
        return Array.from(this.meta.entries()).map(([name, m]) => ({
            name,
            enabled: m.enabled,
            status: m.status,
            error: m.error,
            config: m.config,
            source: m.source,
            installedAt: m.installedAt,
            info: m.info
        }));
    }
}

module.exports = { PluginManager, PLUGIN_DIR };
