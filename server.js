#!/usr/bin/env node
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { exec } = require('child_process');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const multer = require('multer');
const IP2Region = require('ip2region').default;
const ip2rJs = require('ip2region.js');
const { createStore, collectAll, restoreAll, summarizeData } = require('./lib/store');
const { createCloud, TYPES: CLOUD_TYPES } = require('./lib/cloud');
const { PluginManager } = require('./lib/plugin');

/* 当前数据存储（启动时初始化，可在管理后台热切换，切换时自动迁移数据） */
let store = null;
let dbMigrating = false; // 迁移锁：迁移期间暂停数据写入
let pluginManager = null; // 插件管理器（启动后初始化）

/* 未处理的 Promise 拒绝仅记录，不崩溃进程（防个别请求异常导致整体 DoS） */
process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err && err.message ? err.message : err);
});

const app = express();
const PORT = process.env.PORT || 1919;

// ==================== 日志（内存环形缓冲） ====================
const MAX_LOG = 500;
const appLogs = [];

// ==================== API 统计（三层时间桶：1s/60s/3600s + 持久化） ====================
const API_START_TIME = Date.now();
const DEFAULT_API_RULES = {
    '/api/config/public': { enabled: true, rps: 0, bandwidth: 0 },
    '/api/danmu/': { enabled: true, rps: 0, bandwidth: 0 },
    '/api/danmu/v3/': { enabled: true, rps: 0, bandwidth: 0 },
    '/api/video/map': { enabled: true, rps: 0, bandwidth: 0 },
    '/api/video/resolve': { enabled: true, rps: 0, bandwidth: 0 },
    '/api/subtitle/detect': { enabled: true, rps: 0, bandwidth: 0 },
    '/api/pow/verify': { enabled: true, rps: 0, bandwidth: 0 }
};
const API_LAYER_DEFS = [
    { name: 's', unit: 1, keep: 24 * 60 * 60 },      // 1s  桶，保留 1 天
    { name: 'm', unit: 60, keep: 30 * 24 * 60 },     // 60s 桶，保留 30 天
    { name: 'h', unit: 3600, keep: 90 * 24 }         // 1h  桶，保留 90 天（受 retentionDays 限制）
];
const apiLayers = {
    s: { buckets: [], lastTs: -1 },
    m: { buckets: [], lastTs: -1 },
    h: { buckets: [], lastTs: -1 }
};
const apiTotals = { calls: {}, bytes: {} };

// config 读取缓存（3s 过期，避免每个请求读盘）
let apiConfigCache = null;
let apiConfigCacheAt = 0;
function getApiConfig() {
    if (!apiConfigCache || Date.now() - apiConfigCacheAt > 3000) {
        apiConfigCache = readConfig().api || {};
        apiConfigCacheAt = Date.now();
    }
    return apiConfigCache;
}
function invalidateApiConfig() { apiConfigCache = null; }

function getRetentionDays(config) {
    const api = (config && config.api) || {};
    if (api.retentionDays) return Math.max(1, Math.min(90, parseInt(api.retentionDays) || 1));
    if (api.retentionMinutes) return Math.max(1, Math.min(90, Math.ceil((parseInt(api.retentionMinutes) || 60) / 1440)));
    return 1;
}

function apiRuleFor(path) {
    const rules = getApiConfig().apis || DEFAULT_API_RULES;
    // longest-prefix match
    let best = null, bestLen = -1;
    for (const key of Object.keys(rules)) {
        if (path === key || path.startsWith(key) && key.length > bestLen) { best = key; bestLen = key.length; }
    }
    return { rule: rules[best] || { enabled: true, rps: 0, bandwidth: 0 }, key: best };
}

function trackApi(path, bytes) {
    const fullPath = path.startsWith('/api/') ? path : '/api' + path;
    apiTotals.calls[fullPath] = (apiTotals.calls[fullPath] || 0) + 1;
    apiTotals.bytes[fullPath] = (apiTotals.bytes[fullPath] || 0) + (bytes || 0);
    const now = Math.floor(Date.now() / 1000);
    const config = readConfig();
    const retDays = getRetentionDays(config);
    for (const def of API_LAYER_DEFS) {
        const layer = apiLayers[def.name];
        const ts = Math.floor(now / def.unit);
        if (ts !== layer.lastTs) {
            layer.lastTs = ts;
            layer.buckets.push({ ts, t: ts * def.unit * 1000, calls: {}, bytes: {} });
            const maxKeep = def.name === 'h' ? retDays * 24 : def.keep;
            while (layer.buckets.length > maxKeep) layer.buckets.shift();
        }
        const b = layer.buckets[layer.buckets.length - 1];
        b.calls[fullPath] = (b.calls[fullPath] || 0) + 1;
        b.bytes[fullPath] = (b.bytes[fullPath] || 0) + (bytes || 0);
    }
}

// 持久化到磁盘（60s 定时 + 退出时），重启不丢；数据库模式下同步写入 kv 表
function saveApiStats() {
    const payload = {
        savedAt: Date.now(),
        totals: apiTotals,
        layers: Object.fromEntries(Object.entries(apiLayers).map(([k, v]) => [k, { lastTs: v.lastTs, buckets: v.buckets }]))
    };
    const tmp = API_STATS_FILE + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(payload));
        fs.renameSync(tmp, API_STATS_FILE);
    } catch (e) { console.error('[stats] save failed:', e.message); }
    if (store && store.type !== 'json') store.kvSet('api_stats', payload).catch(() => {});
}
function loadApiStats() {
    try {
        const d = JSON.parse(fs.readFileSync(API_STATS_FILE, 'utf8'));
        if (d.totals) Object.assign(apiTotals, d.totals);
        if (d.layers) {
            for (const [name, v] of Object.entries(d.layers)) {
                if (apiLayers[name] && Array.isArray(v.buckets)) {
                    apiLayers[name].buckets = v.buckets;
                    apiLayers[name].lastTs = v.lastTs || -1;
                }
            }
        }
    } catch { /* 无文件或损坏则忽略 */ }
}
// API 控制中间件：开闭 + 限速 + 带宽
const apiWindowCounters = new Map();
function apiControl(req, res, next) {
    const path = req.path;
    const { rule } = apiRuleFor(path);
    if (!rule.enabled) {
        trackApi(path, 0);
        return res.status(403).json({ code: 403, msg: '该 API 已停用' });
    }
    // RPS limit (per-second sliding window, in-memory)
    if (rule.rps > 0) {
        const now = Date.now();
        const key = path;
        let arr = apiWindowCounters.get(key);
        if (!arr) { arr = []; apiWindowCounters.set(key, arr); }
        while (arr.length && arr[0] < now - 1000) arr.shift();
        if (arr.length >= rule.rps) {
            trackApi(path, 0);
            return res.status(429).json({ code: 429, msg: 'API 调用过快' });
        }
        arr.push(now);
    }
    // Bandwidth tracking: wrap res.end
    const origEnd = res.end.bind(res);
    res.end = function (chunk, ...rest) {
        let bytes = 0;
        if (chunk) bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        // bandwidth limit check is post-hoc; simple: track and optionally throttle via delay
        trackApi(path, bytes);
        return origEnd(chunk, ...rest);
    };
    next();
}
app.use('/api/', apiControl);
app.use(logRequest);
function logRequest(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
        const entry = {
            t: new Date().toISOString(),
            m: req.method,
            p: req.originalUrl.split('?')[0],
            s: res.statusCode,
            ip: req.ip || req.socket.remoteAddress || '-',
            ms: Date.now() - start
        };
        appLogs.push(entry);
        if (appLogs.length > MAX_LOG) appLogs.shift();
    });
    next();
}

app.use(express.json());
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    frameguard: false
}));

/* 高级安全头（配置驱动，即时生效） */
app.use((req, res, next) => {
    const a = (readConfig().security || {}).advanced || {};
    if (a.hidePoweredBy === false) res.setHeader('X-Powered-By', 'Express');
    else res.removeHeader('X-Powered-By');
    if (a.noSniff === false) res.removeHeader('X-Content-Type-Options');
    else res.setHeader('X-Content-Type-Options', 'nosniff');
    if (a.hsts === false) res.removeHeader('Strict-Transport-Security');
    else res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (a.referrer) res.setHeader('Referrer-Policy', a.referrer);
    else res.removeHeader('Referrer-Policy');
    next();
});

app.use(securityMiddleware);
app.use(powMiddleware);

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    const a = (readConfig().security || {}).advanced || {};
    if (a.cors === false) return next();
    res.header('Access-Control-Allow-Origin', a.corsOrigin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

/* 首次初始化拦截：未完成「修改密码 + 设置安全入口」前，仅允许登录与初始化接口 */
app.use('/api/admin', (req, res, next) => {
    const sec = readConfig().security || {};
    if (!sec.firstRun) return next();
    if (req.path === '/login' || req.path === '/init') return next();
    return res.status(403).json({ code: 403, msg: '请先完成初始化（修改密码与安全入口）' });
});

// ==================== PoW 工作量证明（Anubis 同款防爬虫） ====================
const POW_SECRET = crypto.randomBytes(32).toString('hex');
const POW_COOKIE = 'dp_pow';

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(';').forEach(c => {
        const idx = c.indexOf('=');
        if (idx > -1) cookies[c.slice(0, idx).trim()] = c.slice(idx + 1).trim();
    });
    return cookies;
}

function signPayload(payload) {
    const hmac = crypto.createHmac('sha256', POW_SECRET).update(payload).digest('hex');
    return payload + '.' + hmac;
}

function verifyPayload(signed) {
    const idx = signed.lastIndexOf('.');
    if (idx === -1) return null;
    const payload = signed.slice(0, idx);
    const sig = signed.slice(idx + 1);
    const expected = crypto.createHmac('sha256', POW_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    return payload;
}

function powMiddleware(req, res, next) {
    const config = readConfig();
    if (!config.pow || !config.pow.enabled) return next();
    if (req.ipWhitelisted) return next();
    const adminPath = (config.security && config.security.adminPath) || '/admin';
    if (req.path.startsWith('/api/') || req.path.startsWith('/admin') || req.path.startsWith(adminPath)) return next();

    const cookies = parseCookies(req.headers.cookie || '');
    const signed = cookies[POW_COOKIE];
    if (signed) {
        const payload = verifyPayload(signed);
        if (payload) {
            try {
                const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
                if (Date.now() - data.t < 3600000) return next();
            } catch (e) {}
        }
    }

    const challenge = crypto.randomBytes(16).toString('hex');
    const difficulty = config.pow.difficulty || 4;
    const en = /^en/i.test(req.headers['accept-language'] || '');
    const t1 = en ? 'Verifying connection security...' : '正在验证连接安全...';
    const t2 = en ? 'Proof-of-work in progress' : '正在进行工作量证明计算';
    const t3 = en ? 'Verifying, entering...' : '验证完成，正在进入...';
    const t4 = en ? 'Computing... (' : '计算中... (';
    const t5 = en ? 'Verification complete, entering...' : '验证完成，正在进入...';
    const t6 = en ? 'Connection Verification' : '连接验证';
    res.type('html').send(`<!DOCTYPE html><html lang="${en ? 'en' : 'zh'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t6}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#07070d;color:#e4e4ed;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif}.card{text-align:center;padding:32px 40px;border:1px solid rgba(255,255,255,.07);border-radius:14px;background:#14141f;max-width:420px}h2{margin-bottom:8px;font-size:20px}#status{color:#9099a3;font-size:13px;margin-top:12px}.bar{margin-top:16px;height:3px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden}.bar-inner{height:100%;width:0;background:linear-gradient(90deg,#00a1d6,#00c3f0);border-radius:3px;transition:width .3s}</style></head><body><div class="card"><h2>${t1}</h2><p id="status" style="font-size:13px;color:#9099a3">${t2}</p><div class="bar"><div class="bar-inner" id="bar"></div></div></div><script>
const challenge='${challenge}', difficulty=${difficulty}, target='0'.repeat(difficulty);
let found=false,nonce=0;
function solve(){
    const start=performance.now(),enc=new TextEncoder(),data=enc.encode(challenge);
    const nonceBuf=new ArrayBuffer(8),dv=new DataView(nonceBuf);
    let best=0;
    async function step(){
        for(let i=0;i<20000&&!found;i++,nonce++){
            dv.setBigUint64(0,BigInt(nonce),true);
            const combined=new Uint8Array(data.length+8);
            combined.set(data);combined.set(new Uint8Array(nonceBuf),data.length);
            const hash=await crypto.subtle.digest('SHA-256',combined);
            const bytes=new Uint8Array(hash);
            let zeros=0;
            for(let j=0;j<bytes.length;j++){
                if(bytes[j]===0)zeros+=2;
                else{if(bytes[j]<16)zeros+=1;break}
            }
            if(zeros>=difficulty){found=true;
                document.getElementById('status').innerHTML='${t3}';
                fetch('/api/pow/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,challenge})}).then(r=>r.json()).then(d=>{if(d.ok)location.reload()});
                return;
            }
            if(zeros>best){best=zeros;document.getElementById('bar').style.width=Math.min(90,Math.round(zeros/difficulty*100))+'%'}
        }
        if(!found){document.getElementById('status').innerHTML='${t4}'+nonce+'${en ? ')' : '次)'}';requestAnimationFrame(step)}
    }
    requestAnimationFrame(step);
}
solve();
</script></body></html>`);
}

app.post('/api/pow/verify', (req, res) => {
    const config = readConfig();
    const { nonce, challenge } = req.body;
    if ((nonce !== 0 && !nonce) || !challenge) return res.json({ ok: false });
    const combined = Buffer.concat([Buffer.from(challenge, 'utf8'), Buffer.from(new BigUint64Array([BigInt(nonce)]).buffer)]);
    const hash = crypto.createHash('sha256').update(combined).digest('hex');
    const target = '0'.repeat(config.pow.difficulty || 4);
    if (!hash.startsWith(target)) return res.json({ ok: false });
    const payload = Buffer.from(JSON.stringify({ t: Date.now() })).toString('base64');
    const signed = signPayload(payload);
    res.setHeader('Set-Cookie', POW_COOKIE + '=' + signed + '; Path=/; Max-Age=3600; SameSite=Lax; HttpOnly');
    res.json({ ok: true });
});

// ==================== 速率限制 ====================
function getApiLimiter() {
    const config = readConfig();
    if (!config.rateLimit || !config.rateLimit.enabled) return (req, res, next) => next();
    return rateLimit({
        windowMs: config.rateLimit.windowMs || 60000,
        max: config.rateLimit.max || 60,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: safeRateKey,
        skip: (req) => req.ipWhitelisted,
        handler: (req, res) => res.status(429).json({ code: 429, msg: '请求过于频繁,请稍后再试' })
    });
}

const DATA_DIR = path.join(__dirname, 'data');
const DANMU_FILE = path.join(DATA_DIR, 'danmu.json');
const BANNED_WORDS_FILE = path.join(DATA_DIR, 'banned_words.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const VIDEOS_FILE = path.join(DATA_DIR, 'videos.json');

function readJsonFile(file, fallback) {
    try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        return d === undefined || d === null ? fallback : d;
    } catch { return fallback; }
}

// API 统计持久化（60s 定时 + 退出时），重启不丢
const API_STATS_FILE = path.join(DATA_DIR, 'api-stats.json');
setInterval(saveApiStats, 60000);
process.on('exit', saveApiStats);
process.on('SIGINT', () => { saveApiStats(); process.exit(0); });
process.on('SIGTERM', () => { saveApiStats(); process.exit(0); });
loadApiStats();

// ==================== 账号密码认证系统 ====================
const TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
let tokenExpiryMs = 2 * 60 * 60 * 1000;

function getTokenExpiry() {
    const config = readConfig();
    return (config.security && config.security.sessionMinutes || 120) * 60 * 1000;
}

/* 密码哈希：scrypt（内存困难算法，防 GPU 爆破）
   兼容旧 sha256 格式：登录时按存储长度区分，成功登录后自动升级为 scrypt */
function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function verifyPassword(password, salt, stored) {
    if (!stored) return false;
    if (stored.length === 128) {
        const h = crypto.scryptSync(String(password), salt, 64);
        const b = Buffer.from(stored, 'hex');
        return b.length === h.length && crypto.timingSafeEqual(h, b);
    }
    return crypto.timingSafeEqual(
        Buffer.from(crypto.createHash('sha256').update(String(password) + salt).digest('hex'), 'utf8'),
        Buffer.from(stored, 'utf8')
    );
}

function initAccounts() {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
        const salt = crypto.randomBytes(16).toString('hex');
        const defaultAccount = {
            admin: { salt, hash: hashPassword('admin123', salt), name: '管理员', created: Date.now() }
        };
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(defaultAccount, null, 2));
        console.log('[认证] 已创建默认账号 admin / admin123（请立即修改密码）');
    }
}

function readAccounts() {
    return store ? Promise.resolve(store.accountsAll()) : Promise.resolve(readJsonFile(ACCOUNTS_FILE, {}));
}

function writeAccounts(accounts) {
    if (!store) { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2)); return Promise.resolve(); }
    return store.accountsWrite(accounts);
}

function generateToken(username) {
    const payload = Buffer.from(JSON.stringify({ u: username, t: Date.now() })).toString('base64');
    const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    return payload + '.' + sig;
}

function verifyToken(token) {
    if (!token) return null;
    const idx = token.lastIndexOf('.');
    if (idx === -1) return null;
    const payload = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    if (crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex') !== sig) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        if (Date.now() - data.t > getTokenExpiry()) return null;
        return data.u;
    } catch { return null; }
}

function checkAdmin(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ((req.body && req.body.token) || req.headers['x-admin-token']);
    const username = verifyToken(token);
    if (!username) {
        return res.status(401).json({ code: 1, msg: '未登录或令牌已过期' });
    }
    req.adminUser = username;
    next();
}

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

initAccounts();

function initDataFile(filePath, defaultData) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
    }
}

initDataFile(DANMU_FILE, []);
initDataFile(BANNED_WORDS_FILE, ['广告', '刷屏', '垃圾']);

// ==================== 服务器配置 ====================
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_CONFIG = {
    pow: { enabled: false, difficulty: 4 },
    rateLimit: { enabled: false, windowMs: 60000, max: 60 },
    danmakuLimit: { enabled: false, maxPerMinute: 10 },
    danmaku: { maxLength: 500, authorMaxLength: 50 },
    upload: { maxMB: 200, previewKB: 200 },
    render: { maxPerSecond: 250, speedJitter: 10 },
    api: { apis: DEFAULT_API_RULES, retentionDays: 1 },
    bannedWords: { subscriptions: [] },
    security: { sessionMinutes: 120, adminPath: '', trustProxy: true, firstRun: false, autoBan: true, anomaly: { reqPerMin: 60, mbPerMin: 20, reqPerHour: 2000, mbPerHour: 1024 }, loginLimit: { maxFail: 5, windowMin: 10, lockMin: 15 }, advanced: { hidePoweredBy: true, hsts: true, noSniff: true, referrer: 'no-referrer', cors: true, corsOrigin: '*', debug: false } },
    theme: 'bilibili',
    adminTheme: 'bilibili',
    cdn: { enabled: false, baseUrl: '' },
    timezone: 'Asia/Shanghai',
    language: 'zh'
};

/* 常用时区白名单（初始化向导可选） */
const TIMEZONES = [
    'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul',
    'Asia/Singapore', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Bangkok', 'Asia/Jakarta',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
    'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Sao_Paulo',
    'Australia/Sydney', 'Pacific/Auckland', 'UTC'
];

/* 按配置时区格式化服务器时间（备份文件名等） */
function fmtServerTime(d) {
    const tz = TIMEZONES.includes((readConfig().timezone || 'Asia/Shanghai')) ? readConfig().timezone : 'Asia/Shanghai';
    try {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);
        const get = (t) => (parts.find(p => p.type === t) || {}).value || '00';
        return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
    } catch { 
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }
}

if (!fs.existsSync(CONFIG_FILE)) {
    /* 全新安装：标记未初始化，首次登录强制修改密码与安全入口 */
    const fresh = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    fresh.security = { ...DEFAULT_CONFIG.security, firstRun: true };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(fresh, null, 2));
}

function readConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const merged = { ...DEFAULT_CONFIG, ...raw };
        merged.security = { ...DEFAULT_CONFIG.security, ...(raw.security || {}) };
        merged.security.loginLimit = { ...DEFAULT_CONFIG.security.loginLimit, ...((raw.security && raw.security.loginLimit) || {}) };
        merged.security.anomaly = { ...DEFAULT_CONFIG.security.anomaly, ...((raw.security && raw.security.anomaly) || {}) };
        merged.security.advanced = { ...DEFAULT_CONFIG.security.advanced, ...((raw.security && raw.security.advanced) || {}) };
        merged.security.autoBan = (raw.security && raw.security.autoBan !== false);
        return merged;
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

function writeConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/* 弹幕参数（可配置） */
function getDanmakuLimits() {
    const c = readConfig().danmaku || {};
    return {
        maxLength: Math.max(1, Math.min(2000, parseInt(c.maxLength) || 500)),
        authorMaxLength: Math.max(1, Math.min(200, parseInt(c.authorMaxLength) || 50))
    };
}
/* 上传/预览限制（可配置） */
function getUploadLimits() {
    const c = readConfig().upload || {};
    return {
        maxMB: Math.max(1, Math.min(2048, parseInt(c.maxMB) || 200)),
        previewKB: Math.max(1, Math.min(10240, parseInt(c.previewKB) || 200))
    };
}

/* 信任反向代理头（X-Forwarded-For 等），默认开启；
   安全加固：仅信任回环来源（本机 nginx），局域网/公网直连一律忽略 XFF，
   防止任意来源伪造 X-Forwarded-For 绕过限流/锁定/封禁/白名单。
   Docker + nginx 场景请将 trustProxy 关闭或确保反代与应用同主机回环。 */
function applyTrustProxy(config) {
    const trust = !(config.security && config.security.trustProxy === false);
    app.set('trust proxy', trust ? 'loopback' : false);
}
applyTrustProxy(readConfig());

function readData(filePath) {
    return readJsonFile(filePath, []);
}

async function containsBannedWord(text) {
    const bannedWords = await store.bannedAll();
    const lowerText = text.toLowerCase();
    return bannedWords.some(word => lowerText.includes(word.toLowerCase()));
}

// ==================== 安全中心：IP 统计 / 归属地 / 封禁 / 白名单 / 异常检测 ====================

const SECURITY_FILE = path.join(DATA_DIR, 'security.json');
initDataFile(SECURITY_FILE, { banned: {}, whitelist: {} });

function readSecurity() {
    return store ? Promise.resolve(store.securityGet()) : Promise.resolve((() => {
        const d = readJsonFile(SECURITY_FILE, {});
        return {
            banned: (d && d.banned && typeof d.banned === 'object') ? d.banned : {},
            whitelist: (d && d.whitelist && typeof d.whitelist === 'object') ? d.whitelist : {}
        };
    })());
}
function writeSecurity(s) {
    if (!store) { fs.writeFileSync(SECURITY_FILE, JSON.stringify(s, null, 2)); return Promise.resolve(); }
    return store.securityWrite(s);
}

// --- 登录记录与失败锁定（持久化，重启恢复） ---
const LOGIN_LOG_FILE = path.join(DATA_DIR, 'login-logs.json');
const LOGIN_FAIL_FILE = path.join(DATA_DIR, 'login-fails.json');
initDataFile(LOGIN_LOG_FILE, []);
initDataFile(LOGIN_FAIL_FILE, {});

function readLoginLogs() {
    if (store) return store.loginLogs();
    const d = readJsonFile(LOGIN_LOG_FILE, []);
    return Promise.resolve(Array.isArray(d) ? d : []);
}
function writeLoginLogs(list) {
    if (!store) {
        try {
            if (list.length > 500) list = list.slice(-500);
            fs.writeFileSync(LOGIN_LOG_FILE, JSON.stringify(list));
        } catch (e) { console.error('[login-log] save failed:', e.message); }
        return Promise.resolve();
    }
    if (list.length > 500) list = list.slice(-500);
    return store.loginLogsWrite(list);
}
function readLoginFails() {
    if (store) return store.loginFails();
    const d = readJsonFile(LOGIN_FAIL_FILE, {});
    return Promise.resolve((d && typeof d === 'object' && !Array.isArray(d)) ? d : {});
}
function writeLoginFails(d) {
    if (!store) {
        try { fs.writeFileSync(LOGIN_FAIL_FILE, JSON.stringify(d)); } catch (e) { console.error('[login-fail] save failed:', e.message); }
        return Promise.resolve();
    }
    return store.loginFailsWrite(d);
}
async function logLogin(ip, username, ok, reason) {
    const list = await readLoginLogs();
    list.push({ ip: String(ip || ''), u: String(username || '').slice(0, 50), ok: !!ok, t: Date.now(), r: String(reason || '') });
    await writeLoginLogs(list);
}

// --- 每 IP 请求/流量统计（60s 与 3600s 时间桶，模式同 api-stats） ---
const IP_LAYER_DEFS = [
    { name: 'm', unit: 60, keep: 30 * 24 * 60 },
    { name: 'h', unit: 3600, keep: 90 * 24 }
];
const ipLayers = {
    m: { buckets: [], lastTs: -1 },
    h: { buckets: [], lastTs: -1 }
};
const ipTotals = { calls: {}, bytes: {}, last: {} };
const IP_STATS_FILE = path.join(DATA_DIR, 'ip-stats.json');

function trackIp(ip, bytes) {
    ipTotals.calls[ip] = (ipTotals.calls[ip] || 0) + 1;
    ipTotals.bytes[ip] = (ipTotals.bytes[ip] || 0) + (bytes || 0);
    ipTotals.last[ip] = Date.now();
    const now = Math.floor(Date.now() / 1000);
    for (const def of IP_LAYER_DEFS) {
        const layer = ipLayers[def.name];
        const ts = Math.floor(now / def.unit);
        if (ts !== layer.lastTs) {
            layer.lastTs = ts;
            layer.buckets.push({ ts, ips: {} });
            while (layer.buckets.length > def.keep) layer.buckets.shift();
        }
        const b = layer.buckets[layer.buckets.length - 1];
        const e = b.ips[ip] || (b.ips[ip] = { c: 0, b: 0 });
        e.c++; e.b += (bytes || 0);
    }
}

/* 汇总最近 maxBuckets 个桶的每 IP 统计 */
function ipWindowCounts(unitSec, maxBuckets) {
    const name = unitSec === 3600 ? 'h' : 'm';
    const layer = ipLayers[name];
    const out = {};
    const now = Math.floor(Date.now() / 1000);
    for (const b of layer.buckets) {
        if (now - b.ts * unitSec > maxBuckets * unitSec) continue;
        for (const [ip, e] of Object.entries(b.ips)) {
            const o = out[ip] || (out[ip] = { c: 0, b: 0 });
            o.c += e.c; o.b += e.b;
        }
    }
    return out;
}

function saveIpStats() {
    try {
        const payload = {
            savedAt: Date.now(),
            totals: ipTotals,
            layers: Object.fromEntries(Object.entries(ipLayers).map(([k, v]) => [k, { lastTs: v.lastTs, buckets: v.buckets }]))
        };
        const tmp = IP_STATS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(payload));
        fs.renameSync(tmp, IP_STATS_FILE);
    } catch (e) { console.error('[ip-stats] save failed:', e.message); }
    if (store && store.type !== 'json') store.kvSet('ip_stats', payload).catch(() => {});
}
function loadIpStats() {
    try {
        const d = JSON.parse(fs.readFileSync(IP_STATS_FILE, 'utf8'));
        if (d.totals) Object.assign(ipTotals, d.totals);
        if (d.layers) {
            for (const [name, v] of Object.entries(d.layers)) {
                if (ipLayers[name] && Array.isArray(v.buckets)) {
                    ipLayers[name].buckets = v.buckets;
                    ipLayers[name].lastTs = v.lastTs || -1;
                }
            }
        }
    } catch { /* 忽略 */ }
}
loadIpStats();
setInterval(saveIpStats, 60000);
process.on('exit', saveIpStats);
process.on('SIGINT', () => { saveIpStats(); process.exit(0); });
process.on('SIGTERM', () => { saveIpStats(); process.exit(0); });

// --- 归属地：ip2region 官方最新 xdb（自动更新）+ 内置旧库兜底 ---
const GEO_V4_FILE = path.join(DATA_DIR, 'ip2region_v4.xdb');
const GEO_V6_FILE = path.join(DATA_DIR, 'ip2region_v6.xdb');
const GEO_SOURCE_BASE = 'https://github.com/lionsoul2014/ip2region/raw/master/data/';
let ipSearcher4 = null, ipSearcher6 = null;
let ipGeo = null; // 旧 .db 格式兜底
try { ipGeo = new IP2Region(); } catch (e) { console.error('[geo] 内置地址库初始化失败:', e.message); }

function geoDbInfo(file) {
    try {
        const st = fs.statSync(file);
        return { file: path.basename(file), size: st.size, mtime: st.mtimeMs };
    } catch { return null; }
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return downloadFile(new URL(res.headers.location, url).toString(), dest).then(resolve, reject);
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const tmp = dest + '.tmp';
            const out = fs.createWriteStream(tmp);
            res.pipe(out);
            out.on('finish', () => {
                out.close(() => {
                    try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); }
                });
            });
            out.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (x) {} reject(e); });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(new Error('timeout')); });
    });
}

async function reloadSearchers() {
    if (fs.existsSync(GEO_V4_FILE)) {
        try { ipSearcher4 = ip2rJs.newWithFileOnly(ip2rJs.IPv4, GEO_V4_FILE); } catch (e) { console.error('[geo] v4 xdb 加载失败:', e.message); ipSearcher4 = null; }
    }
    if (fs.existsSync(GEO_V6_FILE)) {
        try { ipSearcher6 = ip2rJs.newWithFileOnly(ip2rJs.IPv6, GEO_V6_FILE); } catch (e) { console.error('[geo] v6 xdb 加载失败:', e.message); ipSearcher6 = null; }
    }
}

/* 下载/更新地址库：缺失或超过 7 天则重新下载（动态更新） */
async function ensureGeoDb(force) {
    const week = 7 * 86400000;
    for (const name of ['ip2region_v4.xdb', 'ip2region_v6.xdb']) {
        const file = path.join(DATA_DIR, name);
        const info = geoDbInfo(file);
        if (!force && info && Date.now() - info.mtime < week) continue;
        try {
            console.log('[geo] 下载地址库 ' + name + ' ...');
            await downloadFile(GEO_SOURCE_BASE + name, file);
            console.log('[geo] ' + name + ' 更新完成');
        } catch (e) {
            console.error('[geo] ' + name + ' 下载失败（使用兜底库）:', e.message);
        }
    }
    await reloadSearchers();
}
ensureGeoDb(false);
setInterval(() => ensureGeoDb(false), 3600000); // 每小时检查一次是否需要更新

const geoCache = new Map();
function parseRegion(str) {
    const p = String(str || '').split('|');
    if (p.length >= 5 && p[0]) return { country: p[0], province: p[1] || '', city: p[2] === '0' ? '' : (p[2] || ''), isp: p[3] || '', code: p[4] || '' };
    if (p.length === 1 && p[0]) return { country: p[0], province: '', city: '', isp: '', code: '' };
    return null;
}
async function geoLookup(ip) {
    const clean = String(ip || '').replace(/^::ffff:/, '');
    if (!clean) return null;
    if (geoCache.has(clean)) return geoCache.get(clean);
    let res = null;
    try {
        if (clean.includes(':') && ipSearcher6) {
            const region = await ipSearcher6.search(clean);
            if (region) res = parseRegion(region);
        } else if (ipSearcher4) {
            const region = await ipSearcher4.search(clean);
            if (region) res = parseRegion(region);
        }
    } catch (e) { /* 单次失败忽略 */ }
    if (!res && ipGeo) {
        try {
            const r = ipGeo.search(clean);
            if (r && (r.country || r.province || r.city)) res = { country: r.country, province: r.province, city: r.city, isp: r.isp, code: '' };
        } catch (e) { /* 忽略 */ }
    }
    geoCache.set(clean, res);
    if (geoCache.size > 5000) {
        const first = geoCache.keys().next().value;
        if (first !== undefined) geoCache.delete(first);
    }
    return res;
}

/* 中国省份 / 国家（中英文名 + ISO 国家码）→ 经纬度（地图标记用） */
const PROVINCE_COORDS = {
    '北京': [116.40, 39.90], '天津': [117.20, 39.13], '上海': [121.47, 31.23], '重庆': [106.55, 29.56],
    '河北': [114.50, 38.04], '山西': [112.55, 37.87], '辽宁': [123.43, 41.80], '吉林': [125.32, 43.90],
    '黑龙江': [126.63, 45.75], '江苏': [118.78, 32.04], '浙江': [120.15, 30.28], '安徽': [117.28, 31.86],
    '福建': [119.30, 26.08], '江西': [115.89, 28.68], '山东': [117.00, 36.65], '河南': [113.65, 34.76],
    '湖北': [114.30, 30.59], '湖南': [112.98, 28.19], '广东': [113.28, 23.13], '海南': [110.35, 20.02],
    '四川': [104.07, 30.67], '贵州': [106.71, 26.57], '云南': [102.71, 25.04], '陕西': [108.95, 34.27],
    '甘肃': [103.82, 36.06], '青海': [101.78, 36.62], '台湾': [121.50, 25.03], '内蒙古': [111.75, 40.84],
    '广西': [108.32, 22.82], '西藏': [91.13, 29.65], '宁夏': [106.28, 38.47], '新疆': [87.62, 43.83],
    '香港': [114.17, 22.28], '澳门': [113.55, 22.20]
};
const COUNTRY_COORDS = {
    '美国': [-98.58, 39.83], 'United States': [-98.58, 39.83], 'US': [-98.58, 39.83],
    '日本': [138.25, 36.20], 'Japan': [138.25, 36.20], 'JP': [138.25, 36.20],
    '韩国': [127.77, 35.90], 'South Korea': [127.77, 35.90], 'KR': [127.77, 35.90],
    '英国': [-0.13, 51.50], 'United Kingdom': [-0.13, 51.50], 'GB': [-0.13, 51.50],
    '德国': [10.45, 51.17], 'Germany': [10.45, 51.17], 'DE': [10.45, 51.17],
    '法国': [2.35, 48.86], 'France': [2.35, 48.86], 'FR': [2.35, 48.86],
    '俄罗斯': [37.62, 55.75], 'Russia': [37.62, 55.75], 'RU': [37.62, 55.75],
    '加拿大': [-106.35, 56.13], 'Canada': [-106.35, 56.13], 'CA': [-106.35, 56.13],
    '澳大利亚': [133.78, -25.27], 'Australia': [133.78, -25.27], 'AU': [133.78, -25.27],
    '印度': [78.96, 20.59], 'India': [78.96, 20.59], 'IN': [78.96, 20.59],
    '新加坡': [103.82, 1.35], 'Singapore': [103.82, 1.35], 'SG': [103.82, 1.35],
    '马来西亚': [101.98, 3.14], 'Malaysia': [101.98, 3.14], 'MY': [101.98, 3.14],
    '泰国': [100.50, 13.75], 'Thailand': [100.50, 13.75], 'TH': [100.50, 13.75],
    '越南': [105.85, 21.03], 'Vietnam': [105.85, 21.03], 'VN': [105.85, 21.03],
    '印度尼西亚': [106.85, -6.21], 'Indonesia': [106.85, -6.21], 'ID': [106.85, -6.21],
    '菲律宾': [121.00, 14.60], 'Philippines': [121.00, 14.60], 'PH': [121.00, 14.60],
    '荷兰': [4.90, 52.37], 'Netherlands': [4.90, 52.37], 'NL': [4.90, 52.37],
    '瑞士': [7.45, 46.95], 'Switzerland': [7.45, 46.95], 'CH': [7.45, 46.95],
    '瑞典': [18.07, 59.33], 'Sweden': [18.07, 59.33], 'SE': [18.07, 59.33],
    '意大利': [12.50, 41.90], 'Italy': [12.50, 41.90], 'IT': [12.50, 41.90],
    '西班牙': [-3.70, 40.42], 'Spain': [-3.70, 40.42], 'ES': [-3.70, 40.42],
    '波兰': [21.01, 52.23], 'Poland': [21.01, 52.23], 'PL': [21.01, 52.23],
    '土耳其': [32.85, 39.93], 'Turkey': [32.85, 39.93], 'TR': [32.85, 39.93],
    '以色列': [35.21, 31.78], 'Israel': [35.21, 31.78], 'IL': [35.21, 31.78],
    '阿联酋': [54.37, 24.45], 'United Arab Emirates': [54.37, 24.45], 'AE': [54.37, 24.45],
    '沙特阿拉伯': [46.68, 24.69], 'Saudi Arabia': [46.68, 24.69], 'SA': [46.68, 24.69],
    '巴基斯坦': [73.05, 33.68], 'Pakistan': [73.05, 33.68], 'PK': [73.05, 33.68],
    '哈萨克斯坦': [71.47, 51.17], 'Kazakhstan': [71.47, 51.17], 'KZ': [71.47, 51.17],
    '蒙古': [106.92, 47.91], 'Mongolia': [106.92, 47.91], 'MN': [106.92, 47.91],
    '缅甸': [96.16, 16.87], 'Myanmar': [96.16, 16.87], 'MM': [96.16, 16.87],
    '巴西': [-47.93, -15.79], 'Brazil': [-47.93, -15.79], 'BR': [-47.93, -15.79],
    '阿根廷': [-58.38, -34.60], 'Argentina': [-58.38, -34.60], 'AR': [-58.38, -34.60],
    '智利': [-70.65, -33.45], 'Chile': [-70.65, -33.45], 'CL': [-70.65, -33.45],
    '墨西哥': [-99.13, 19.43], 'Mexico': [-99.13, 19.43], 'MX': [-99.13, 19.43],
    '南非': [28.05, -26.20], 'South Africa': [28.05, -26.20], 'ZA': [28.05, -26.20],
    '埃及': [31.24, 30.04], 'Egypt': [31.24, 30.04], 'EG': [31.24, 30.04],
    '新西兰': [174.78, -41.29], 'New Zealand': [174.78, -41.29], 'NZ': [174.78, -41.29],
    '中国': [104.20, 35.90], 'China': [104.20, 35.90], 'CN': [104.20, 35.90],
    '香港': [114.17, 22.28], 'Hong Kong': [114.17, 22.28], 'HK': [114.17, 22.28],
    '台湾': [121.50, 25.03], 'Taiwan': [121.50, 25.03], 'TW': [121.50, 25.03],
    '澳门': [113.55, 22.20], 'Macau': [113.55, 22.20], 'MO': [113.55, 22.20]
};

async function geoRegionText(ip) {
    const g = await geoLookup(ip);
    if (!g) return '未知';
    return [g.country, g.province, g.city].filter(Boolean).join('·') || '未知';
}
function normProvince(p) {
    return String(p || '').replace(/壮族自治区$|回族自治区$|维吾尔自治区$|自治区$|特别行政区$|省$|市$/, '');
}
async function geoCoords(ip) {
    const g = await geoLookup(ip);
    if (!g) return null;
    const prov = normProvince(g.province);
    if (g.country === '中国' || g.country === 'China' || g.code === 'CN' || PROVINCE_COORDS[prov]) {
        if (PROVINCE_COORDS[prov]) return PROVINCE_COORDS[prov];
        if (g.city) {
            for (const [k, v] of Object.entries(PROVINCE_COORDS)) if (g.city.includes(k)) return v;
        }
    }
    if (g.code && COUNTRY_COORDS[g.code]) return COUNTRY_COORDS[g.code];
    if (g.country && COUNTRY_COORDS[g.country]) return COUNTRY_COORDS[g.country];
    if (prov && COUNTRY_COORDS[prov]) return COUNTRY_COORDS[prov];
    return null;
}

// --- 安全中间件：封禁拦截 + 每 IP 统计 + 白名单标记 ---
async function securityMiddleware(req, res, next) {
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    req.clientIp = ip;
    const sec = await readSecurity();
    if (sec.banned[ip]) {
        return res.status(403).json({ code: 403, msg: 'IP 已被封禁' });
    }
    req.ipWhitelisted = !!sec.whitelist[ip];
    let n = 0;
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    res.write = function (chunk, ...rest) {
        if (chunk) n += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        return origWrite(chunk, ...rest);
    };
    res.end = function (chunk, ...rest) {
        if (chunk) n += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        trackIp(ip, n);
        return origEnd(chunk, ...rest);
    };
    next();
}

// --- 异常检测（白名单跳过，阈值可配置） ---
function getAnomalyThresholds() {
    const a = (readConfig().security || {}).anomaly || {};
    return {
        reqPerMin: a.reqPerMin || 60,
        mbPerMin: a.mbPerMin || 20,
        reqPerHour: a.reqPerHour || 2000,
        mbPerHour: a.mbPerHour || 1024
    };
}
async function computeAnomalies() {
    const t = getAnomalyThresholds();
    const sec = await readSecurity();
    const m5 = ipWindowCounts(60, 5);   // 最近 5 分钟
    const h6 = ipWindowCounts(3600, 6); // 最近 6 小时
    const ips = new Set([...Object.keys(m5), ...Object.keys(h6)]);
    const out = [];
    for (const ip of ips) {
        if (sec.whitelist[ip]) continue;
        const reasons = [];
        const mc = m5[ip] || { c: 0, b: 0 };
        const hc = h6[ip] || { c: 0, b: 0 };
        const rpm = mc.c / 5, mbpm = mc.b / 1024 / 1024 / 5;
        const rph = hc.c / 6, mbph = hc.b / 1024 / 1024 / 6;
        if (rpm > t.reqPerMin) reasons.push(`请求频率 ${rpm.toFixed(1)} 次/分 > ${t.reqPerMin}`);
        if (mbpm > t.mbPerMin) reasons.push(`流量 ${mbpm.toFixed(1)} MB/分 > ${t.mbPerMin}`);
        if (rph > t.reqPerHour) reasons.push(`请求 ${rph.toFixed(1)} 次/时 > ${t.reqPerHour}`);
        if (mbph > t.mbPerHour) reasons.push(`流量 ${mbph.toFixed(1)} MB/时 > ${t.mbPerHour}`);
        if (reasons.length) out.push({ ip, reasons, m5: mc, h6: hc, region: await geoRegionText(ip), isp: (await geoLookup(ip) || {}).isp || '' });
    }
    out.sort((a, b) => (b.m5.c + b.h6.c) - (a.m5.c + a.h6.c));
    return out;
}

/* 自动封禁：持续异常（6 小时窗口超阈值）的 IP 自动加入封禁列表，白名单除外 */
async function autoBanAnomalies() {
    try {
        const config = readConfig();
        if (!(config.security && config.security.autoBan !== false)) return;
        const t = getAnomalyThresholds();
        const sec = await readSecurity();
        const list = await computeAnomalies();
        let changed = false;
        for (const a of list) {
            const rph = a.h6.c / 6, mbph = a.h6.b / 1024 / 1024 / 6;
            if (rph > t.reqPerHour || mbph > t.mbPerHour) {
                if (!sec.banned[a.ip]) {
                    sec.banned[a.ip] = { reason: '自动封禁（持续异常请求/流量）', at: Date.now() };
                    changed = true;
                }
            }
        }
        if (changed) await writeSecurity(sec);
    } catch (e) { console.error('[auto-ban] failed:', e.message); }
}
setInterval(() => { autoBanAnomalies(); }, 60000);
autoBanAnomalies();

// ==================== 弹幕API ====================

const danmakuCounters = new Map();

function checkDanmakuLimit(req, res) {
    const config = readConfig();
    if (!config.danmakuLimit || !config.danmakuLimit.enabled) return true;
    if (req.ipWhitelisted) return true;
    const max = config.danmakuLimit.maxPerMinute || 10;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = 'dm_' + ip;
    const now = Date.now();
    let entry = danmakuCounters.get(key);
    if (!entry || now > entry.resetAt) {
        danmakuCounters.set(key, { count: 1, resetAt: now + 60000 });
        return true;
    }
    if (entry.count >= max) {
        res.status(429).json({ code: 3, msg: `发送过快，每分钟最多 ${max} 条弹幕` });
        return false;
    }
    entry.count++;
    return true;
}

app.use('/api/', getApiLimiter());

app.get('/api/danmu/v3/', async (req, res) => {
    const id = req.query.id;
    console.log(`[弹幕API] GET 请求(query) - 视频ID: ${id}`);
    
    let danmuList = await store.danmuAll();
    console.log(`[弹幕API] 数据库中共有 ${danmuList.length} 条弹幕`);
    
    if (id) {
        danmuList = danmuList.filter(d => d.vid === id);
        console.log(`[弹幕API] 过滤后剩余 ${danmuList.length} 条弹幕`);
    }
    
    const bannedWords = await store.bannedAll();
    danmuList = danmuList.filter(d => {
        const text = d.text.toLowerCase();
        return !bannedWords.some(word => text.includes(word.toLowerCase()));
    });
    
    const danmakuData = danmuList.map(d => [
        d.time,
        d.type === 'right' ? 0 : (d.type === 'top' ? 1 : 2),
        parseInt(d.color.replace('#', ''), 16),
        d.author || 'anonymous',
        d.text
    ]);
    
    console.log(`[弹幕API] 返回 ${danmakuData.length} 条弹幕`);
    res.json({ code: 0, data: danmakuData });
});

app.get('/api/danmu/v3/:id', async (req, res) => {
    const id = req.params.id;
    console.log(`[弹幕API] GET 请求(path) - 视频ID: ${id}`);
    
    let danmuList = await store.danmuAll();
    
    if (id) {
        danmuList = danmuList.filter(d => d.vid === id);
    }
    
    const bannedWords = await store.bannedAll();
    danmuList = danmuList.filter(d => {
        const text = d.text.toLowerCase();
        return !bannedWords.some(word => text.includes(word.toLowerCase()));
    });
    
    const danmakuData = danmuList.map(d => [
        d.time,
        d.type === 'right' ? 0 : (d.type === 'top' ? 1 : 2),
        parseInt(d.color.replace('#', ''), 16),
        d.author || 'anonymous',
        d.text
    ]);
    
    res.json({ code: 0, data: danmakuData });
});

app.get('/api/danmu/', async (req, res) => {
    const id = req.query.id;
    console.log(`[弹幕API] GET 请求(query) - 视频ID: ${id}`);
    
    let danmuList = await store.danmuAll();
    console.log(`[弹幕API] 数据库中共有 ${danmuList.length} 条弹幕`);
    
    if (id) {
        danmuList = danmuList.filter(d => d.vid === id);
        console.log(`[弹幕API] 过滤后剩余 ${danmuList.length} 条弹幕`);
    }
    
    const bannedWords = await store.bannedAll();
    danmuList = danmuList.filter(d => {
        const text = d.text.toLowerCase();
        return !bannedWords.some(word => text.includes(word.toLowerCase()));
    });
    
    const danmakuData = danmuList.map(d => [
        d.time,
        d.type === 'right' ? 0 : (d.type === 'top' ? 1 : 2),
        parseInt(d.color.replace('#', ''), 16),
        d.author || 'anonymous',
        d.text
    ]);
    
    console.log(`[弹幕API] 返回 ${danmakuData.length} 条弹幕`);
    res.json({ code: 0, data: danmakuData });
});

app.post('/api/danmu/', writeRateLimit(60, 60000), async (req, res) => {
    if (dbMigrating) return res.status(503).json({ code: 1, msg: '数据迁移中，请稍后重试' });
    const { id, player, text, color, type, time, author } = req.body || {};
    const vid = id || player;
    console.log(`[弹幕API] POST 请求 - 视频ID: ${vid}, 内容: ${text}`);

    if (!vid || !text) {
        console.log(`[弹幕API] 参数不完整 - id/player: ${vid}, text: ${text}`);
        return res.status(400).json({ code: 1, msg: '参数不完整' });
    }
    if (typeof text !== 'string' || text.length > getDanmakuLimits().maxLength) {
        return res.status(400).json({ code: 1, msg: '弹幕内容过长（最长 ' + getDanmakuLimits().maxLength + ' 字符）' });
    }

    if (!checkDanmakuLimit(req, res)) return;

    if (await containsBannedWord(text)) {
        console.log(`[弹幕API] 弹幕包含屏蔽词: ${text}`);
        return res.status(403).json({ code: 2, msg: '弹幕包含屏蔽词' });
    }

    const danmuList = await store.danmuAll();

    let danmuType = 'right';
    if (type === 1) danmuType = 'top';
    else if (type === 2) danmuType = 'bottom';

    let colorHex = '#ffffff';
    if (color !== undefined) {
        colorHex = '#' + parseInt(color).toString(16).padStart(6, '0');
    }

    const newDanmu = {
        id: Date.now().toString(),
        vid: vid,
        text,
        color: colorHex,
        type: danmuType,
        time: parseFloat(time) || 0,
        author: String(author || 'anonymous').slice(0, getDanmakuLimits().authorMaxLength),
        date: new Date().toISOString()
    };

    danmuList.push(newDanmu);
    if (store.type === 'json' && fileSizeExceeds(DANMU_FILE, 200 * 1024 * 1024)) {
        return res.status(507).json({ code: 1, msg: '弹幕存储已满' });
    }
    await store.danmuAdd(newDanmu);

    console.log(`[弹幕API] 弹幕保存成功: ${text}`);
    res.json({ code: 0, data: newDanmu });
});

app.post('/api/danmu/v3/', writeRateLimit(60, 60000), async (req, res) => {
    if (dbMigrating) return res.status(503).json({ code: 1, msg: '数据迁移中，请稍后重试' });
    const { id, player, text, color, type, time, author } = req.body || {};
    const vid = id || player;
    console.log(`[弹幕API] POST 请求 - 视频ID: ${vid}, 内容: ${text}`);

    if (!vid || !text) {
        console.log(`[弹幕API] 参数不完整 - id/player: ${vid}, text: ${text}`);
        return res.status(400).json({ code: 1, msg: '参数不完整' });
    }
    if (typeof text !== 'string' || text.length > getDanmakuLimits().maxLength) {
        return res.status(400).json({ code: 1, msg: '弹幕内容过长（最长 ' + getDanmakuLimits().maxLength + ' 字符）' });
    }

    if (!checkDanmakuLimit(req, res)) return;

    if (await containsBannedWord(text)) {
        console.log(`[弹幕API] 弹幕包含屏蔽词: ${text}`);
        return res.status(403).json({ code: 2, msg: '弹幕包含屏蔽词' });
    }

    const danmuList = await store.danmuAll();

    let danmuType = 'right';
    if (type === 1) danmuType = 'top';
    else if (type === 2) danmuType = 'bottom';

    let colorHex = '#ffffff';
    if (color !== undefined) {
        colorHex = '#' + parseInt(color).toString(16).padStart(6, '0');
    }

    const newDanmu = {
        id: Date.now().toString(),
        vid: vid,
        text,
        color: colorHex,
        type: danmuType,
        time: parseFloat(time) || 0,
        author: String(author || 'anonymous').slice(0, getDanmakuLimits().authorMaxLength),
        date: new Date().toISOString()
    };

    danmuList.push(newDanmu);
    if (store.type === 'json' && fileSizeExceeds(DANMU_FILE, 200 * 1024 * 1024)) {
        return res.status(507).json({ code: 1, msg: '弹幕存储已满' });
    }
    await store.danmuAdd(newDanmu);

    console.log(`[弹幕API] 弹幕保存成功: ${text}`);
    res.json({ code: 0, data: newDanmu });
});

// ==================== 视频映射 ====================

initDataFile(VIDEOS_FILE, {});

/* 写放大防护：数据文件体积上限 */
function fileSizeExceeds(filePath, maxBytes) {
    try { return fs.statSync(filePath).size > maxBytes; } catch { return false; }
}
/* 未授权写接口的每 IP 限速（防刷盘/刷映射） */
const writeLimiterBuckets = new Map();
function writeRateLimit(max, windowMs) {
    return (req, res, next) => {
        const ip = req.clientIp || req.ip || 'unknown';
        const now = Date.now();
        let arr = writeLimiterBuckets.get(ip);
        if (!arr) { arr = []; writeLimiterBuckets.set(ip, arr); }
        while (arr.length && arr[0] < now - windowMs) arr.shift();
        if (arr.length >= max) return res.status(429).json({ code: 429, msg: '操作过于频繁，请稍后再试' });
        arr.push(now);
        next();
    };
}
function isValidVideoUrl(url) {
    if (typeof url !== 'string' || url.length > 2048) return false;
    if (/^https?:\/\//i.test(url)) return true;
    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return true;
    return false;
}
function isValidVid(vid) {
    return typeof vid === 'string' && vid.length >= 4 && vid.length <= 32 && /^[a-zA-Z0-9]+$/.test(vid);
}

app.post('/api/video/map', writeRateLimit(30, 60000), async (req, res) => {
    if (dbMigrating) return res.status(503).json({ code: 1, msg: '数据迁移中，请稍后重试' });
    const { vid, url } = req.body || {};
    if (!isValidVid(vid) || !isValidVideoUrl(url)) return res.status(400).json({ code: 1, msg: '参数不合法' });
    try {
        await store.videoSet(vid, url);
        res.json({ code: 0, msg: '已记录' });
    } catch (e) {
        res.status(e.code || 500).json({ code: 1, msg: e.code === 507 ? '映射表已满' : '保存失败' });
    }
});

// ==================== 视频 ID 解析（服务端分配 8 位唯一 ID） ====================
const VID_CHARS = '23456789abcdefghijkmnpqrstuvwxyz'; // 去除易混淆字符 0/1/l/o/i
function legacyVideoId(url) {
    let v = url;
    try { const u = new URL(url); v = u.pathname + u.search; } catch (e) {}
    let hash = 0;
    for (let i = 0; i < v.length; i++) { hash = ((hash << 5) - hash) + v.charCodeAt(i); hash |= 0; }
    return Math.abs(hash).toString(36);
}
async function hasDanmuForVid(vid) {
    return store.danmuHasVid(vid);
}
async function genVideoId() {
    const videos = await store.videosAll();
    const used = new Set(Object.keys(videos));
    (await store.danmuAllVids()).forEach(v => used.add(v));
    for (let i = 0; i < 200; i++) {
        let s = '';
        for (let j = 0; j < 8; j++) s += VID_CHARS[Math.floor(Math.random() * VID_CHARS.length)];
        if (!used.has(s)) return s;
    }
    return 'v' + Date.now().toString(36);
}
app.get('/api/video/resolve', writeRateLimit(60, 60000), async (req, res) => {
    const url = (req.query.url || '').trim();
    if (!url || !isValidVideoUrl(url)) return res.status(400).json({ code: 1, msg: '缺少或非法的 url 参数' });
    const videos = await store.videosAll();
    let existing = null;
    for (const [vid, u] of Object.entries(videos)) {
        if (u === url) { existing = vid; break; }
    }
    if (existing) return res.json({ code: 0, data: { vid: existing, source: 'map' } });
    // 旧散列算法兼容：该 URL 已有历史弹幕 → 继承旧 ID，弹幕不丢
    const legacyId = legacyVideoId(url);
    if (await hasDanmuForVid(legacyId)) {
        try {
            await store.videoSet(legacyId, url);
            return res.json({ code: 0, data: { vid: legacyId, source: 'legacy' } });
        } catch (e) { return res.status(507).json({ code: 1, msg: '映射表已满' }); }
    }
    const vid = await genVideoId();
    try {
        await store.videoSet(vid, url);
        res.json({ code: 0, data: { vid, source: 'new' } });
    } catch (e) {
        res.status(507).json({ code: 1, msg: '映射表已满' });
    }
});

app.get('/api/admin/videos', checkAdmin, async (req, res) => {
    const videos = await store.videosAll();
    const list = Object.entries(videos).map(([vid, url]) => ({ vid, url }));
    res.json({ code: 0, data: list });
});

app.post('/api/admin/videos', checkAdmin, async (req, res) => {
    const { vid, url } = req.body;
    if (!vid || !url) return res.status(400).json({ code: 1, msg: '参数不完整' });
    await store.videoSet(vid, url);
    res.json({ code: 0, msg: '已保存', data: { vid, url } });
});

app.post('/api/admin/videos/delete', checkAdmin, async (req, res) => {
    const { vid } = req.body;
    const ok = await store.videoDelete(vid);
    if (!ok) return res.status(404).json({ code: 1, msg: '不存在' });
    res.json({ code: 0, msg: '已删除' });
});

// ==================== 管理员API ====================

/* 限流 key 兜底：req.ip 为 undefined 时 express-rate-limit 会抛
   ERR_ERL_UNDEFINED_IP_ADDRESS 导致进程崩溃（Node>=15 默认崩溃）；
   ipKeyGenerator 处理 IPv6 子网聚合（防 IPv6 地址轮换绕过限流） */
const { ipKeyGenerator } = require('express-rate-limit');
function safeRateKey(req) {
    const ip = req.ip || req.clientIp || req.socket.remoteAddress || 'unknown';
    try { return ipKeyGenerator(ip, 56); } catch (e) { return String(ip); }
}

const loginLimiter = rateLimit({
    windowMs: 60000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: safeRateKey,
    skip: (req) => req.ipWhitelisted,
    handler: (req, res) => res.status(429).json({ code: 429, msg: '登录尝试过于频繁，请1分钟后再试' })
});

/* 登录失败锁定：每 IP 计数，超过阈值锁定（配置可调，持久化） */
async function loginGuard(req, res, next) {
    const ip = req.clientIp || req.ip || 'unknown';
    const L = (readConfig().security || {}).loginLimit || {};
    const maxFail = L.maxFail || 5, windowMin = L.windowMin || 10, lockMin = L.lockMin || 15;
    const fails = await readLoginFails();
    const f = fails[ip];
    if (f && f.lockedUntil && f.lockedUntil > Date.now()) {
        await logLogin(ip, req.body && req.body.username, false, 'locked');
        const mins = Math.ceil((f.lockedUntil - Date.now()) / 60000);
        return res.status(429).json({ code: 429, msg: '登录已锁定，请' + mins + '分钟后再试' });
    }
    req.loginGuard = { maxFail, windowMin, lockMin, fails };
    next();
}

app.post('/api/admin/login', loginLimiter, loginGuard, async (req, res) => {
    const ip = req.clientIp || req.ip || 'unknown';
    const { username, password } = req.body;
    const g = req.loginGuard;
    if (!username || !password) {
        await logLogin(ip, username, false, 'params');
        return res.status(400).json({ code: 1, msg: '请输入账号和密码' });
    }
    const accounts = await readAccounts();
    const account = accounts[username];
    const ok = !!account && verifyPassword(password, account.salt, account.hash);
    if (!ok) {
        const fails = g.fails;
        const now = Date.now();
        let f = fails[ip];
        if (!f) { f = { count: 0, firstAt: now, lockedUntil: 0 }; fails[ip] = f; }
        if (now - f.firstAt > g.windowMin * 60000) { f.count = 0; f.firstAt = now; }
        f.count++;
        if (f.count >= g.maxFail) {
            f.lockedUntil = now + g.lockMin * 60000;
            f.count = 0;
            await writeLoginFails(fails);
            await logLogin(ip, username, false, 'lock:' + g.lockMin);
            return res.status(429).json({ code: 429, msg: '登录失败次数过多，已锁定' + g.lockMin + '分钟' });
        }
        await writeLoginFails(fails);
        await logLogin(ip, username, false, 'fail');
        return res.status(401).json({ code: 2, msg: '账号或密码错误' });
    }
    /* 旧 sha256 哈希自动升级为 scrypt */
    if (account.hash.length !== 128) {
        account.hash = hashPassword(password, account.salt);
        await writeAccounts(accounts);
    }
    delete g.fails[ip];
    await writeLoginFails(g.fails);
    await logLogin(ip, username, true, 'ok');
    const token = generateToken(username);
    res.json({ code: 0, msg: '登录成功', data: { token, username, name: account.name || username, firstRun: !!(readConfig().security || {}).firstRun } });
});

/* 首次初始化向导：语言 / 时区 / 数据库 / 修改管理员密码 + 设置安全入口（完成后 firstRun=false） */
app.post('/api/admin/init', checkAdmin, async (req, res) => {
    const config = readConfig();
    if (!(config.security && config.security.firstRun)) return res.status(400).json({ code: 1, msg: '系统已完成初始化' });
    const { newPassword, adminPath, timezone, language, db } = req.body || {};
    if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ code: 2, msg: '新密码至少4位' });
    const ap = String(adminPath || '').replace(/^\/+|\/+$/g, '');
    if (ap && !/^[a-zA-Z0-9_\-]+$/.test(ap)) return res.status(400).json({ code: 3, msg: '入口路径仅允许字母、数字、下划线和中划线' });
    const tz = TIMEZONES.includes(timezone) ? timezone : 'Asia/Shanghai';
    const lang = ['zh', 'zhHant', 'wyw', 'en', 'ja', 'fr'].includes(language) ? language : 'zh';

    /* 数据库配置（可选）：校验类型与连接，必要时热切换存储 */
    let dbApplied = false;
    if (db && db.type) {
        if (!DB_TYPES.includes(db.type)) return res.status(400).json({ code: 4, msg: '无效的存储类型' });
        const dbCfg = buildDbCfg(db.type, db.sqlite || {}, db.mysql || {}, db.postgres || {}, db.mongodb || {}, config.db || {});
        const hostErr = dbHostError(dbCfg, db.type);
        if (hostErr) return res.status(400).json({ code: 5, msg: hostErr });
        if (db.type !== store.type) {
            let next = null;
            try {
                next = await createStore(db.type, dbCfg);
                const data = await collectAll(store);
                await restoreAll(next, data);
                const old = store;
                store = next; next = null;
                try { await old.close(); } catch (e) {}
                dbApplied = true;
            } catch (e) {
                if (next) { try { await next.close(); } catch (x) {} }
                return res.status(500).json({ code: 6, msg: '数据库切换失败: ' + safeErrMsg(e) });
            }
        }
        config.db = { type: db.type, ...dbCfg };
    }

    /* 修改密码 */
    const accounts = await readAccounts();
    const account = accounts[req.adminUser];
    if (!account) return res.status(401).json({ code: 1, msg: '账号不存在，请重新登录' });
    const newSalt = crypto.randomBytes(16).toString('hex');
    account.salt = newSalt;
    account.hash = hashPassword(newPassword, newSalt);
    accounts[req.adminUser] = account;
    await writeAccounts(accounts);

    /* 保存配置 */
    config.security = { ...config.security, adminPath: ap, firstRun: false };
    config.timezone = tz;
    config.language = lang;
    writeConfig(config);
    applyTrustProxy(config);
    res.json({ code: 0, msg: '初始化完成，请使用新密码重新登录', data: { adminPath: ap, timezone: tz, language: lang, dbApplied } });
});

app.post('/api/admin/change-password', checkAdmin, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ code: 1, msg: '参数不完整' });
    if (newPassword.length < 4) return res.status(400).json({ code: 2, msg: '新密码至少4位' });
    const accounts = await readAccounts();
    const account = accounts[req.adminUser];
    if (!verifyPassword(oldPassword, account.salt, account.hash)) {
        return res.status(403).json({ code: 3, msg: '原密码错误' });
    }
    const newSalt = crypto.randomBytes(16).toString('hex');
    account.salt = newSalt;
    account.hash = hashPassword(newPassword, newSalt);
    accounts[req.adminUser] = account;
    await writeAccounts(accounts);
    res.json({ code: 0, msg: '密码已更新，请重新登录' });
});

app.post('/api/admin/change-username', checkAdmin, async (req, res) => {
    const { password, newUsername } = req.body;
    if (!password || !newUsername) return res.status(400).json({ code: 1, msg: '参数不完整' });
    if (newUsername.length < 2) return res.status(400).json({ code: 2, msg: '用户名至少2位' });
    if (!/^[a-zA-Z0-9_]+$/.test(newUsername)) return res.status(400).json({ code: 3, msg: '用户名只能包含字母数字和下划线' });
    const accounts = await readAccounts();
    if (accounts[newUsername]) return res.status(400).json({ code: 4, msg: '该用户名已存在' });
    const account = accounts[req.adminUser];
    if (!verifyPassword(password, account.salt, account.hash)) {
        return res.status(403).json({ code: 5, msg: '密码错误' });
    }
    accounts[newUsername] = account;
    delete accounts[req.adminUser];
    await writeAccounts(accounts);
    const token = generateToken(newUsername);
    res.json({ code: 0, msg: '用户名已更换，请使用新用户名重新登录', data: { token, username: newUsername } });
});

app.get('/api/admin/config', checkAdmin, (req, res) => {
    const config = readConfig();
    res.json({ code: 0, data: config });
});

// ==================== API 管理 ====================
app.get('/api/admin/api/stats', checkAdmin, (req, res) => {
    const config = readConfig();
    const rules = (config.api && config.api.apis) || DEFAULT_API_RULES;
    const spanSec = Math.max(30, Math.min(90 * 86400, parseInt(req.query.span) || 3600));
    // 按跨度选择层：≤1天 → 秒桶；≤30天 → 分钟桶；其余 → 小时桶
    let layer = apiLayers.h, unit = 3600;
    if (spanSec <= 24 * 3600) { layer = apiLayers.s; unit = 1; }
    else if (spanSec <= 30 * 86400) { layer = apiLayers.m; unit = 60; }
    const cutoff = Math.floor(Date.now() / 1000) - spanSec;
    const buckets = layer.buckets.filter(b => b.ts >= cutoff).map(b => ({
        t: b.t,
        calls: { ...b.calls },
        bytes: { ...b.bytes }
    }));
    const uptimeSec = Math.floor((Date.now() - API_START_TIME) / 1000);
    const totalCalls = Object.values(apiTotals.calls).reduce((a, b) => a + b, 0);
    res.json({ code: 0, data: { rules, retentionDays: getRetentionDays(config), bucketUnit: unit, buckets, totals: apiTotals, uptimeSec, totalCalls, spanSec } });
});

app.post('/api/admin/api', checkAdmin, (req, res) => {
    const { apis, retentionDays } = req.body || {};
    const config = readConfig();
    if (!config.api) config.api = {};
    if (apis && typeof apis === 'object') {
        config.api.apis = { ...DEFAULT_API_RULES, ...config.api.apis, ...apis };
    }
    if (retentionDays) config.api.retentionDays = Math.max(1, Math.min(90, parseInt(retentionDays) || 1));
    writeConfig(config);
    invalidateApiConfig();
    res.json({ code: 0, msg: 'API 配置已保存' });
});

// ==================== 日志查看 ====================
app.get('/api/admin/logs', checkAdmin, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json({ code: 0, data: appLogs.slice(-limit).reverse() });
});

// ==================== 文件查看器 ====================
const ROOT_DIR = __dirname;
function safeResolve(rel) {
    if (rel == null) return ROOT_DIR;
    if (typeof rel !== 'string') return null;
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const p = path.resolve(ROOT_DIR, clean || '.');
    if (p !== ROOT_DIR && !p.startsWith(ROOT_DIR + path.sep)) return null;
    return p;
}

app.get('/api/admin/files', checkAdmin, (req, res) => {
    const target = safeResolve(req.query.path || '');
    if (!target) return res.status(400).json({ code: 1, msg: '非法路径' });
    let stat;
    try { stat = fs.statSync(target); } catch (e) { return res.status(404).json({ code: 1, msg: '路径不存在' }); }

    if (stat.isFile()) {
        const size = stat.size;
        const previewKB = getUploadLimits().previewKB;
        if (size > previewKB * 1024) return res.json({ code: 0, data: { type: 'file', name: path.basename(target), size, tooLarge: true } });
        let content;
        try { content = fs.readFileSync(target, 'utf8'); } catch (e) { content = '[二进制文件无法预览]'; }
        return res.json({ code: 0, data: { type: 'file', name: path.basename(target), size, content } });
    }

    const entries = fs.readdirSync(target, { withFileTypes: true }).map(d => {
        const full = path.join(target, d.name);
        let size = 0;
        try { if (d.isFile()) size = fs.statSync(full).size; } catch (e) {}
        return { name: d.name, dir: d.isDirectory(), size };
    }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));

    const rel = path.relative(ROOT_DIR, target).replace(/\\/g, '/');
    res.json({ code: 0, data: { type: 'dir', path: rel || '/', entries } });
});

// 批量删除
app.post('/api/admin/files/delete', checkAdmin, (req, res) => {
    const { paths } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ code: 1, msg: '未选择文件' });
    let deleted = 0, failed = 0;
    for (const p of paths) {
        const target = safeResolve(p);
        if (!target || !fs.existsSync(target)) { failed++; continue; }
        try { fs.rmSync(target, { recursive: true, force: true }); deleted++; } catch (e) { failed++; }
    }
    res.json({ code: 0, msg: `删除 ${deleted} 项${failed ? '，失败 ' + failed + ' 项' : ''}` });
});

// 复制（同目录加 _copy 后缀）
app.post('/api/admin/files/copy', checkAdmin, (req, res) => {
    const { paths } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ code: 1, msg: '未选择文件' });
    let copied = 0, failed = 0;
    for (const p of paths) {
        const target = safeResolve(p);
        if (!target || !fs.existsSync(target)) { failed++; continue; }
        const base = path.basename(target);
        const dir = path.dirname(target);
        const ext = path.extname(base);
        const stem = base.slice(0, -ext.length);
        let outName = stem + '_copy' + ext;
        let out = path.join(dir, outName);
        let i = 2;
        while (fs.existsSync(out)) { out = path.join(dir, `${stem}_copy${i}${ext}`); i++; }
        try {
            if (fs.statSync(target).isDirectory()) fs.cpSync(target, out, { recursive: true });
            else fs.copyFileSync(target, out);
            copied++;
        } catch (e) { failed++; }
    }
    res.json({ code: 0, msg: `复制 ${copied} 项${failed ? '，失败 ' + failed + ' 项' : ''}` });
});

// 压缩（支持 zip/7z/tar/tar.gz，通过 7za）
app.post('/api/admin/files/zip', checkAdmin, (req, res) => {
    const { paths, format } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ code: 1, msg: '未选择文件' });
    const fmt = (format || 'zip').toLowerCase();
    const validFmts = { zip: '.zip', '7z': '.7z', tar: '.tar', 'tar.gz': '.tar.gz', tgz: '.tgz', gz: '.gz' };
    const ext = validFmts[fmt];
    if (!ext) return res.status(400).json({ code: 1, msg: '不支持的格式: ' + fmt });

    const first = safeResolve(paths[0]);
    if (!first) return res.status(400).json({ code: 1, msg: '非法路径' });
    const dir = path.dirname(first);
    const baseName = paths.length === 1 ? path.basename(first, path.extname(first)) : 'archive';
    let outPath = path.join(dir, baseName + ext);
    let i = 2;
    while (fs.existsSync(outPath)) { outPath = path.join(dir, `${baseName}(${i})${ext}`); i++; }

    // 准备临时目录，复制选中项以保持相对结构，再整体压缩
    const tmpDir = path.join(dir, '.zip_tmp_' + Date.now());
    const exe = SEVEN_ZIP || '7za';
    const isTarGz = fmt === 'tar.gz' || fmt === 'tgz';

    const finish = (ok, msg, pathOut) => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (!ok) { try { fs.unlinkSync(outPath); } catch (_) {} }
        res.json(ok ? { code: 0, msg, data: { path: pathOut } } : { code: 1, msg });
    };

    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        let added = 0;
        for (const p of paths) {
            const target = safeResolve(p);
            if (!target || !fs.existsSync(target)) continue;
            const rel = path.relative(dir, target);
            const dest = path.join(tmpDir, rel);
            if (fs.statSync(target).isDirectory()) fs.cpSync(target, dest, { recursive: true });
            else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(target, dest); }
            added++;
        }
        if (!added) return finish(false, '没有可压缩的文件');

        if (isTarGz) {
            // 两阶段：先 7za 打 tar，再用 zlib gzip
            const tarFile = path.join(tmpDir, 'bundle.tar');
            const r = require('child_process').spawnSync(exe, ['a', '-ttar', 'bundle.tar', '*', '-y'], { cwd: tmpDir });
            if (r.status !== 0 || !fs.existsSync(tarFile)) return finish(false, 'tar 打包失败');
            const zlib = require('zlib');
            fs.writeFileSync(outPath, zlib.gzipSync(fs.readFileSync(tarFile)));
            const relOut = path.relative(ROOT_DIR, outPath).replace(/\\/g, '/');
            return finish(true, '已压缩为 ' + fmt, relOut);
        }

        // 其他格式直接用 7za
        const args = ['a', path.basename(outPath), tmpDir.replace(/\\/g, '/') + '/*', '-y'];
        const child = require('child_process').spawn(exe, args, { cwd: dir });
        let errOut = '';
        child.stderr.on('data', d => errOut += d);
        child.on('error', (e) => finish(false, '压缩失败: ' + e.message));
        child.on('close', (code) => {
            if (code !== 0) return finish(false, '压缩失败: ' + (errOut || ('exit ' + code)).split('\n')[0]);
            finish(true, '已压缩为 ' + fmt, path.relative(ROOT_DIR, outPath).replace(/\\/g, '/'));
        });
    } catch (e) {
        finish(false, '压缩失败: ' + e.message);
    }
});

// 解压（支持 zip/7z/rar/gz/tar/tar.gz/xz/iso/img 等，通过 7za）
const SEVEN_ZIP = require('7zip-bin').path7za;
const SUPPORTED_EXT = ['.zip', '.7z', '.rar', '.gz', '.tgz', '.tar', '.xz', '.tar.gz', '.bz2', '.tbz2', '.iso', '.img', '.lzh', '.cab', '.arj', '.z'];

app.post('/api/admin/files/unzip', checkAdmin, (req, res) => {
    const { path: p } = req.body || {};
    const target = safeResolve(p);
    if (!target || !fs.existsSync(target)) return res.status(400).json({ code: 1, msg: '文件不存在' });
    const lower = target.toLowerCase();
    if (!SUPPORTED_EXT.some(ext => lower.endsWith(ext))) {
        return res.status(400).json({ code: 1, msg: '不支持的格式，支持: ' + SUPPORTED_EXT.join(' ') });
    }
    const outDir = path.dirname(target);
    const exe = SEVEN_ZIP || '7za';
    exec(`"${exe}" x "${target}" -o"${outDir.replace(/\\/g, '/')}" -y`, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
            console.error('[解压] 失败:', error.message, stderr);
            return res.status(500).json({ code: 1, msg: '解压失败: ' + (stderr || error.message).split('\n')[0] });
        }
        res.json({ code: 0, msg: '解压完成' });
    });
});

// 上传（multer 上限取最大允许值，运行时按配置动态校验）
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2048 * 1024 * 1024 }
});
app.post('/api/admin/files/upload', checkAdmin, upload.array('files'), (req, res) => {
    const dir = safeResolve(req.body.dir || '');
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(400).json({ code: 1, msg: '目标目录无效' });
    if (!req.files || !req.files.length) return res.status(400).json({ code: 1, msg: '未选择文件' });
    const maxMB = getUploadLimits().maxMB;
    const tooBig = req.files.find(f => f.size > maxMB * 1024 * 1024);
    if (tooBig) return res.status(413).json({ code: 1, msg: '文件超过上传上限 ' + maxMB + 'MB: ' + path.basename(tooBig.originalname) });
    let saved = 0;
    for (const f of req.files) {
        const name = path.basename(f.originalname);
        let out = path.join(dir, name);
        let i = 2;
        while (fs.existsSync(out)) { out = path.join(dir, `${path.basename(name, path.extname(name))}(${i})${path.extname(name)}`); i++; }
        try { fs.writeFileSync(out, f.buffer); saved++; } catch (e) {}
    }
    res.json({ code: 0, msg: `上传 ${saved} 个文件` });
});

// ==================== 自定义屏蔽词订阅 ====================

app.get('/api/admin/banned-words/subscriptions', checkAdmin, (req, res) => {
    const config = readConfig();
    const subs = (config.bannedWords && config.bannedWords.subscriptions) || [];
    res.json({ code: 0, data: subs });
});

app.post('/api/admin/banned-words/subscriptions', checkAdmin, (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
        return res.status(400).json({ code: 1, msg: '请提供有效的 HTTP(s) 链接' });
    }
    const config = readConfig();
    if (!config.bannedWords) config.bannedWords = {};
    if (!config.bannedWords.subscriptions) config.bannedWords.subscriptions = [];
    if (config.bannedWords.subscriptions.includes(url.trim())) {
        return res.status(400).json({ code: 2, msg: '该订阅已存在' });
    }
    config.bannedWords.subscriptions.push(url.trim());
    writeConfig(config);
    res.json({ code: 0, msg: '已添加', data: config.bannedWords.subscriptions });
});

app.delete('/api/admin/banned-words/subscriptions', checkAdmin, (req, res) => {
    const { url } = req.body;
    const config = readConfig();
    const subs = (config.bannedWords && config.bannedWords.subscriptions) || [];
    const idx = subs.indexOf(url);
    if (idx === -1) return res.status(404).json({ code: 1, msg: '订阅不存在' });
    subs.splice(idx, 1);
    writeConfig(config);
    res.json({ code: 0, msg: '已删除', data: subs });
});

app.post('/api/admin/banned-words/refresh', checkAdmin, async (req, res) => {
    try {
        const count = await refreshBannedWords();
        res.json({ code: 0, msg: `已刷新，共 ${count} 个屏蔽词` });
    } catch (e) {
        res.status(500).json({ code: 1, msg: '刷新失败: ' + e.message });
    }
});

app.post('/api/admin/config', checkAdmin, (req, res) => {
    const config = readConfig();
    const { pow, rateLimit: rl, danmakuLimit: dl, danmaku, upload: up, render, bannedWords, api, security: sec, theme, adminTheme, cdn } = req.body;
    if (pow) config.pow = { ...config.pow, ...pow };
    if (rl) config.rateLimit = { ...config.rateLimit, ...rl };
    if (dl) config.danmakuLimit = { ...config.danmakuLimit, ...dl };
    if (danmaku) config.danmaku = { ...config.danmaku, ...danmaku };
    if (up) config.upload = { ...config.upload, ...up };
    if (render) config.render = { ...config.render, ...render };
    if (bannedWords) config.bannedWords = { ...config.bannedWords, ...bannedWords };
    if (api) config.api = { ...config.api, ...api };
    if (sec) config.security = { ...config.security, ...sec };
    if (theme) config.theme = theme;
    if (adminTheme) config.adminTheme = adminTheme;
    if (cdn) config.cdn = { ...config.cdn, ...cdn };
    writeConfig(config);
    applyTrustProxy(config);
    res.json({ code: 0, msg: '配置已更新', data: config });
});

app.get('/api/config/public', (req, res) => {
    const config = readConfig();
    res.json({ code: 0, data: { cdn: config.cdn, theme: config.theme || 'bilibili', render: config.render, timezone: config.timezone || 'Asia/Shanghai', language: config.language || 'zh' } });
});

app.get('/api/admin/banned-words', checkAdmin, async (req, res) => {
    let words = await store.bannedAll(true);
    const search = (req.query.search || '').toLowerCase();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;

    if (search) {
        words = words.filter(w => w.toLowerCase().includes(search));
    }

    const total = words.length;
    const start = (page - 1) * limit;
    const paged = words.slice(start, start + limit);

    res.json({ code: 0, data: { words: paged, total, page, limit } });
});

app.post('/api/admin/banned-words', checkAdmin, async (req, res) => {
    const { word } = req.body;
    if (!word || !word.trim()) {
        return res.status(400).json({ code: 1, msg: '关键词不能为空' });
    }
    
    const ok = await store.bannedAdd(word.trim());
    if (!ok) {
        return res.status(400).json({ code: 2, msg: '该关键词已存在' });
    }
    res.json({ code: 0, msg: '添加成功' });
});

app.delete('/api/admin/banned-words', checkAdmin, async (req, res) => {
    const { word } = req.body;
    if (!word) return res.status(400).json({ code: 1, msg: '参数不完整' });
    const ok = await store.bannedDelete(word);
    if (!ok) {
        return res.status(404).json({ code: 1, msg: '关键词不存在' });
    }
    res.json({ code: 0, msg: '删除成功' });
});

app.get('/api/admin/danmu', checkAdmin, async (req, res) => {
    const vid = req.query.vid || '';
    const search = (req.query.search || '').toLowerCase();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const d = await store.danmuPage({ page, limit, vid, search });
    res.json({ code: 0, data: { list: d.list, total: d.total, page, limit } });
});

app.get('/api/admin/danmu/vids', checkAdmin, async (req, res) => {
    const vids = await store.danmuVids();
    res.json({ code: 0, data: vids });
});

app.delete('/api/admin/danmu', checkAdmin, async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ code: 1, msg: '参数不完整' });
    const ok = await store.danmuDelete(id);
    if (!ok) {
        return res.status(404).json({ code: 1, msg: '弹幕不存在' });
    }
    res.json({ code: 0, msg: '删除成功' });
});

// ==================== 安全中心 API ====================

function isValidIp(ip) {
    return typeof ip === 'string' && /^[\d.]+$/.test(ip) && ip.split('.').length === 4;
}

app.get('/api/admin/security/overview', checkAdmin, async (req, res) => {
    const sec = await readSecurity();
    const dayAgo = Date.now() - 86400000;
    let active = 0;
    for (const t of Object.values(ipTotals.last)) if (t > dayAgo) active++;
    res.json({
        code: 0, data: {
            totalCalls: Object.values(ipTotals.calls).reduce((a, b) => a + b, 0),
            totalBytes: Object.values(ipTotals.bytes).reduce((a, b) => a + b, 0),
            activeIps: active,
            allIps: Object.keys(ipTotals.calls).length,
            banned: Object.keys(sec.banned).length,
            whitelist: Object.keys(sec.whitelist).length,
            anomalies: (await computeAnomalies()).length
        }
    });
});

app.get('/api/admin/security/ips', checkAdmin, async (req, res) => {
    const sec = await readSecurity();
    const window = req.query.window || 'm';
    const sort = req.query.sort || 'calls';
    const search = (req.query.search || '').toLowerCase();
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const win = ipWindowCounts(window === 'h' ? 3600 : 60, window === 'h' ? 6 : 5);
    const rows = [];
    for (const ip of Object.keys(ipTotals.calls)) {
        const w = win[ip] || { c: 0, b: 0 };
        const g = await geoLookup(ip);
        const region = g ? [g.country, g.province, g.city].filter(Boolean).join('·') || '未知' : '未知';
        rows.push({
            ip,
            region,
            isp: (g && g.isp) || '',
            coords: await geoCoords(ip),
            winCalls: w.c, winBytes: w.b,
            totalCalls: ipTotals.calls[ip] || 0,
            totalBytes: ipTotals.bytes[ip] || 0,
            last: ipTotals.last[ip] || 0,
            status: sec.banned[ip] ? 'banned' : (sec.whitelist[ip] ? 'whitelist' : 'normal'),
            bannedReason: (sec.banned[ip] && sec.banned[ip].reason) || ''
        });
    }
    if (search) {
        const f = rows.filter(r => r.ip.includes(search) || r.region.toLowerCase().includes(search));
        rows.length = 0; rows.push(...f);
    }
    rows.sort((a, b) => {
        if (sort === 'bytes') return b.totalBytes - a.totalBytes;
        if (sort === 'last') return b.last - a.last;
        if (sort === 'winBytes') return b.winBytes - a.winBytes;
        if (sort === 'winCalls') return b.winCalls - a.winCalls;
        return b.totalCalls - a.totalCalls;
    });
    const total = rows.length;
    const start = (page - 1) * limit;
    res.json({ code: 0, data: { list: rows.slice(start, start + limit), total, page, limit } });
});

app.get('/api/admin/security/anomalies', checkAdmin, async (req, res) => {
    res.json({ code: 0, data: await computeAnomalies() });
});

app.get('/api/admin/security/lists', checkAdmin, async (req, res) => {
    const sec = await readSecurity();
    res.json({
        code: 0,
        data: {
            banned: Object.entries(sec.banned).map(([ip, v]) => ({ ip, reason: (v && v.reason) || '', at: (v && v.at) || 0 })),
            whitelist: Object.entries(sec.whitelist).map(([ip, v]) => ({ ip, at: (v && v.at) || 0 }))
        }
    });
});

app.post('/api/admin/security/ban', checkAdmin, async (req, res) => {
    const { ip, reason } = req.body;
    if (!isValidIp(ip)) return res.status(400).json({ code: 1, msg: '无效 IP' });
    const sec = await readSecurity();
    sec.banned[ip] = { reason: String(reason || '').slice(0, 200), at: Date.now() };
    delete sec.whitelist[ip];
    await writeSecurity(sec);
    res.json({ code: 0, msg: '已封禁 ' + ip });
});

app.post('/api/admin/security/unban', checkAdmin, async (req, res) => {
    const { ip } = req.body;
    if (!isValidIp(ip)) return res.status(400).json({ code: 1, msg: '无效 IP' });
    const sec = await readSecurity();
    delete sec.banned[ip];
    await writeSecurity(sec);
    res.json({ code: 0, msg: '已解除封禁 ' + ip });
});

app.post('/api/admin/security/whitelist', checkAdmin, async (req, res) => {
    const { ip } = req.body;
    if (!isValidIp(ip)) return res.status(400).json({ code: 1, msg: '无效 IP' });
    const sec = await readSecurity();
    if (!sec.whitelist[ip]) sec.whitelist[ip] = { at: Date.now() };
    delete sec.banned[ip];
    await writeSecurity(sec);
    res.json({ code: 0, msg: '已加入白名单 ' + ip });
});

app.post('/api/admin/security/unwhitelist', checkAdmin, async (req, res) => {
    const { ip } = req.body;
    if (!isValidIp(ip)) return res.status(400).json({ code: 1, msg: '无效 IP' });
    const sec = await readSecurity();
    delete sec.whitelist[ip];
    await writeSecurity(sec);
    res.json({ code: 0, msg: '已移出白名单 ' + ip });
});

app.post('/api/admin/security/config', checkAdmin, (req, res) => {
    const { reqPerMin, mbPerMin, reqPerHour, mbPerHour, autoBan } = req.body;
    const config = readConfig();
    config.security = {
        ...config.security,
        anomaly: {
            reqPerMin: Math.max(1, parseInt(reqPerMin) || 60),
            mbPerMin: Math.max(1, parseInt(mbPerMin) || 20),
            reqPerHour: Math.max(1, parseInt(reqPerHour) || 2000),
            mbPerHour: Math.max(1, parseInt(mbPerHour) || 1024)
        }
    };
    if (autoBan !== undefined) config.security.autoBan = !!autoBan;
    writeConfig(config);
    res.json({ code: 0, msg: '阈值已保存' });
});

app.get('/api/admin/security/logins', checkAdmin, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const search = (req.query.search || '').toLowerCase();
    let list = (await readLoginLogs()).slice().reverse();
    if (search) {
        list = list.filter(x => x.ip.includes(search) || String(x.u || '').toLowerCase().includes(search));
    }
    const total = list.length;
    const rows = await Promise.all(list.slice((page - 1) * limit, page * limit).map(async x => ({
        ...x,
        region: await geoRegionText(x.ip)
    })));
    const fails = await readLoginFails();
    const now = Date.now();
    const locked = Object.entries(fails)
        .filter(([, v]) => v.lockedUntil > now)
        .map(([ip, v]) => ({ ip, until: v.lockedUntil }));
    res.json({ code: 0, data: { list: rows, total, page, limit, locked } });
});

app.post('/api/admin/security/login-limit', checkAdmin, (req, res) => {
    const { maxFail, windowMin, lockMin } = req.body;
    const config = readConfig();
    config.security = {
        ...config.security,
        loginLimit: {
            maxFail: Math.max(1, parseInt(maxFail) || 5),
            windowMin: Math.max(1, parseInt(windowMin) || 10),
            lockMin: Math.max(1, parseInt(lockMin) || 15)
        }
    };
    writeConfig(config);
    res.json({ code: 0, msg: '登录防护设置已保存' });
});

// ==================== 数据库管理 ====================

const DB_TYPES = ['json', 'sqlite', 'mysql', 'mariadb', 'postgres', 'mongodb'];
/* 数据浏览白名单（表名仅允许内部已知集合，防注入/越权读取） */
const DB_BROWSE_TABLES = ['danmu', 'videos', 'banned_words', 'accounts', 'security', 'login_logs', 'login_fails', 'subtitles', 'kv'];

/* 错误消息脱敏：截断并去除换行，避免泄露内部细节 */
function safeErrMsg(e) {
    return String((e && e.message) || e || '未知错误').replace(/[\r\n]+/g, ' ').slice(0, 150);
}

/* 数据库主机名校验：仅允许域名 / IPv4 / IPv6 / 主机名，防止 URI 选项注入与异常字符 */
function isValidDbHost(host) {
    return typeof host === 'string' && host.length <= 255 && /^[a-zA-Z0-9.\-:\][%]+$/.test(host) && !host.includes('..');
}

function maskSecret(o) {
    if (!o) return null;
    return { host: o.host, port: o.port, user: o.user, database: o.database, password: o.password ? '******' : '' };
}

app.get('/api/admin/db/info', checkAdmin, async (req, res) => {
    try {
        const cfg = readConfig().db || {};
        const tables = await store.tables();
        res.json({
            code: 0,
            data: {
                type: store.type,
                label: store.label,
                migrating: dbMigrating,
                config: {
                    type: cfg.type || 'json',
                    sqlite: cfg.sqlite || { file: 'data/app.db' },
                    mysql: maskSecret(cfg.mysql),
                    postgres: maskSecret(cfg.postgres),
                    mongodb: maskSecret(cfg.mongodb)
                },
                tables
            }
        });
    } catch (e) {
        res.status(500).json({ code: 1, msg: safeErrMsg(e) });
    }
});

/* 测试目标连接（不写入配置） */
app.post('/api/admin/db/test', checkAdmin, async (req, res) => {
    const { type, sqlite, mysql, postgres, mongodb } = req.body || {};
    if (!DB_TYPES.includes(type)) return res.status(400).json({ code: 1, msg: '无效的存储类型' });
    if (type === 'json') return res.json({ code: 0, msg: 'JSON 文件存储无需连接测试' });
    const cfg = buildDbCfg(type, sqlite || {}, mysql || {}, postgres || {}, mongodb || {}, readConfig().db || {});
    const hostErr = dbHostError(cfg, type);
    if (hostErr) return res.status(400).json({ code: 1, msg: hostErr });
    let s = null;
    try {
        const t0 = Date.now();
        s = await createStore(type, cfg);
        const tables = await s.tables();
        await s.close(); s = null;
        res.json({ code: 0, msg: '连接成功（' + (Date.now() - t0) + 'ms）', data: { tables } });
    } catch (e) {
        if (s) { try { await s.close(); } catch (x) {} }
        res.json({ code: 1, msg: '连接失败: ' + safeErrMsg(e) });
    }
});

/* 切换存储并自动迁移全部数据（弹幕/视频/屏蔽词/账号/IP 封禁白名单/登录记录/统计），无需重启 */
app.post('/api/admin/db/switch', checkAdmin, async (req, res) => {
    const { type, sqlite, mysql, postgres, mongodb } = req.body || {};
    if (!DB_TYPES.includes(type)) return res.status(400).json({ code: 1, msg: '无效的存储类型' });
    if (type === store.type) return res.status(400).json({ code: 1, msg: '当前已是该存储，无需切换' });
    const cfg = buildDbCfg(type, sqlite || {}, mysql || {}, postgres || {}, mongodb || {}, readConfig().db || {});
    const hostErr = dbHostError(cfg, type);
    if (hostErr) return res.status(400).json({ code: 1, msg: hostErr });
    let next = null;
    dbMigrating = true;
    try {
        next = await createStore(type, cfg);
        const data = await collectAll(store);
        const summary = summarizeData(data);
        await restoreAll(next, data);
        const old = store;
        store = next; next = null;
        const config = readConfig();
        config.db = { type, ...cfg };
        writeConfig(config);
        try { await old.close(); } catch (e) { console.error('[数据库] 关闭旧存储失败:', e.message); }
        console.log('[数据库] 已切换 ' + old.label + ' → ' + store.label + '，迁移数据: ' + JSON.stringify(summary));
        res.json({ code: 0, msg: '已切换 ' + old.label + ' → ' + store.label + '，数据迁移完成', data: summary });
    } catch (e) {
        if (next) { try { await next.close(); } catch (x) {} }
        res.status(500).json({ code: 1, msg: '切换失败: ' + safeErrMsg(e) });
    } finally {
        dbMigrating = false;
    }
});

/* 表数据浏览（表名显式白名单，防注入与越权读取） */
app.get('/api/admin/db/data', checkAdmin, async (req, res) => {
    const table = String(req.query.table || '');
    if (!DB_BROWSE_TABLES.includes(table)) return res.status(400).json({ code: 1, msg: '无效的数据表' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const search = String(req.query.search || '').slice(0, 200);
    try {
        const d = await store.browse(table, { page, limit, search });
        res.json({ code: 0, data: { list: d.list, total: d.total, page, limit } });
    } catch (e) {
        res.status(500).json({ code: 1, msg: safeErrMsg(e) });
    }
});

/* 导出全部数据备份（JSON） */
app.get('/api/admin/db/export', checkAdmin, async (req, res) => {
    try {
        const data = await collectAll(store);
        data.exportedAt = Date.now();
        data.storage = { type: store.type, label: store.label };
        res.setHeader('Content-Disposition', 'attachment; filename="artplayer-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
        res.json(data);
    } catch (e) {
        res.status(500).json({ code: 1, msg: safeErrMsg(e) });
    }
});

/* 校验构建出的连接配置中的主机名，非法返回错误消息（null 表示合法） */
function dbHostError(cfg, type) {
    const c = (type === 'mongodb') ? cfg.mongodb : (type === 'postgres' ? cfg.postgres : (type === 'mysql' || type === 'mariadb' ? cfg.mysql : null));
    if (c && c.host && !isValidDbHost(c.host)) return '非法的主机名（仅允许域名/IP/主机名）';
    return null;
}

// ==================== 定时备份 ====================

const APP_VERSION = require('./package.json').version;
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_NAME_RE = /^backup-\d{8}-\d{6}(?:-\d+)?\.json$/;

function getBackupCfg() {
    const c = readConfig().backup || {};
    return {
        enabled: !!c.enabled,
        intervalHours: Math.max(1, Math.min(720, parseInt(c.intervalHours) || 24)),
        maxKeep: Math.max(1, Math.min(100, parseInt(c.maxKeep) || 10)),
        contents: Array.isArray(c.contents) ? c.contents.filter(x => x === 'data' || x === 'config') : ['data', 'config'],
        lastRunAt: c.lastRunAt || 0,
        nextRunAt: c.nextRunAt || 0
    };
}
function saveBackupCfg(c) {
    const config = readConfig();
    config.backup = c;
    writeConfig(config);
}
function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
        .filter(n => BACKUP_NAME_RE.test(n))
        .map(n => {
            const st = fs.statSync(path.join(BACKUP_DIR, n));
            return { name: n, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime);
}
function backupTsName(d) {
    return fmtServerTime(d);
}

/* 执行一次备份：内容可选（data=数据库数据 / config=服务器配置），数量超限自动清理最旧；
   opts.autoSync 控制是否触发云端自动同步（添加备份流程手动管理同步） */
async function runBackup(contentsOverride, opts) {
    const cfg = getBackupCfg();
    const contents = (Array.isArray(contentsOverride) && contentsOverride.length)
        ? contentsOverride.filter(x => x === 'data' || x === 'config')
        : cfg.contents;
    if (!contents.length) throw new Error('备份内容不能为空');
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const payload = {
        backup: {
            createdAt: Date.now(),
            version: APP_VERSION,
            storage: { type: store.type, label: store.label },
            contents
        }
    };
    if (contents.includes('data')) payload.data = await collectAll(store);
    if (contents.includes('config')) payload.config = readConfig();

    let name = 'backup-' + backupTsName(new Date()) + '.json';
    let i = 2;
    while (fs.existsSync(path.join(BACKUP_DIR, name))) name = 'backup-' + backupTsName(new Date()) + '-' + (i++) + '.json';
    fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(payload, null, 2));

    /* 保留份数清理 */
    const files = listBackups();
    while (files.length > cfg.maxKeep) {
        try { fs.rmSync(path.join(BACKUP_DIR, files[0].name)); } catch (e) {}
        files.shift();
    }

    cfg.lastRunAt = Date.now();
    cfg.nextRunAt = Date.now() + cfg.intervalHours * 3600000;
    saveBackupCfg(cfg);
    console.log(`[备份] 完成: ${name}（内容: ${contents.join('/')}，保留 ${cfg.maxKeep} 份）`);
    if (!opts || opts.autoSync !== false) syncAfterBackup(name); /* 云端自动同步（异步，失败仅记录） */
    return { name, createdAt: Date.now(), size: fs.statSync(path.join(BACKUP_DIR, name)).size, contents };
}

/* 定时检查：每分钟一次，到点即备份；失败也顺延到下个周期，避免反复重试 */
function checkBackupSchedule() {
    const cfg = getBackupCfg();
    if (!cfg.enabled) return;
    if (cfg.nextRunAt && Date.now() < cfg.nextRunAt) return;
    runBackup().catch(e => {
        console.error('[备份] 失败:', e.message);
        const c = getBackupCfg();
        c.lastRunAt = Date.now();
        c.nextRunAt = Date.now() + c.intervalHours * 3600000;
        saveBackupCfg(c);
    });
}
setInterval(checkBackupSchedule, 60000);
checkBackupSchedule();

// ==================== 云端备份同步（FTP/SFTP/WebDAV/OpenList） ====================

function cloudDefaultSecure(type) { return type === 'ftp' ? false : true; }

function normalizeCloudItem(c, i) {
    const type = CLOUD_TYPES.includes(c.type) ? c.type : 'webdav';
    return {
        id: c.id || 'c' + i,
        enabled: !!c.enabled,
        type: type,
        host: c.host || '',
        port: parseInt(c.port) || 0,
        user: c.user || '',
        password: c.password || '',
        path: c.path || '/backups',
        baseUrl: c.baseUrl || '',
        secure: c.secure === undefined ? cloudDefaultSecure(type) : !!c.secure,
        lastSyncAt: c.lastSyncAt || 0,
        lastSyncOk: c.lastSyncOk === undefined ? null : !!c.lastSyncOk,
        lastSyncMsg: c.lastSyncMsg || ''
    };
}

function getAllCloudCfgs() {
    const config = readConfig();
    const arr = Array.isArray(config.clouds) ? config.clouds : [];
    if (arr.length === 0) {
        /* 兼容旧版单 cloud 字段 */
        const legacy = config.cloud;
        if (legacy && legacy.type && (legacy.host || legacy.baseUrl)) {
            arr.push({ ...legacy, id: 'default' });
        }
    }
    return arr.map((c, i) => normalizeCloudItem(c, i));
}

function saveAllCloudCfgs(arr) {
    const config = readConfig();
    config.clouds = arr.map(c => ({ ...c, password: c.password || '' }));
    delete config.cloud;
    writeConfig(config);
}

/* 辅助：body 构造单条云端配置 */
function cloudCfgFromBody(type, body) {
    let secure;
    if (body.secure !== undefined) secure = !!body.secure;
    else secure = cloudDefaultSecure(type);
    return {
        enabled: !!body.enabled,
        type: type,
        host: body.host || '',
        port: parseInt(body.port) || 0,
        user: body.user || '',
        password: body.password || '',
        path: body.path || '/backups',
        baseUrl: body.baseUrl || '',
        secure: secure
    };
}

/* 上传单个本地备份到云端（幂等：同名覆盖） */
async function cloudUploadFile(cfg, name) {
    const cloud = createCloud(cfg);
    const local = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(local)) throw new Error('本地备份不存在: ' + name);
    await cloud.upload(local, name);
}

/* 把全部本地备份同步到指定云端配置 */
async function cloudSyncOne(cfg) {
    const cloud = createCloud(cfg);
    await cloud.test();
    const files = listBackups();
    for (const f of files) {
        try { await cloud.upload(path.join(BACKUP_DIR, f.name), f.name); } catch (e) {}
    }
}

/* 本地备份完成后自动同步到所有启用的云端（异步，失败仅记录） */
async function syncAfterBackup(name) {
    const cfgs = getAllCloudCfgs();
    for (const cfg of cfgs) {
        if (!cfg.enabled) continue;
        try {
            await cloudUploadFile(cfg, name);
            cfg.lastSyncAt = Date.now();
            cfg.lastSyncOk = true;
            cfg.lastSyncMsg = '已同步 ' + name;
            console.log('[云端] 已同步备份到 ' + cfg.type + ': ' + name);
        } catch (e) {
            cfg.lastSyncOk = false;
            cfg.lastSyncMsg = safeErrMsg(e);
            console.error('[云端] 同步失败 (' + cfg.type + '): ' + safeErrMsg(e));
        }
    }
    saveAllCloudCfgs(cfgs);
}

app.get('/api/admin/cloud/config', checkAdmin, (req, res) => {
    const cfgs = getAllCloudCfgs();
    res.json({ code: 0, data: cfgs.map(c => ({ ...c, password: c.password ? '******' : '' })) });
});

app.post('/api/admin/cloud/config', checkAdmin, (req, res) => {
    const body = req.body || {};
    if (!body.type || !CLOUD_TYPES.includes(body.type)) return res.status(400).json({ code: 1, msg: '无效的同步类型' });
    const cfgs = getAllCloudCfgs();
    if (body.id) {
        /* 更新已有配置 */
        const idx = cfgs.findIndex(c => c.id === body.id);
        if (idx === -1) return res.status(404).json({ code: 1, msg: '云端配置不存在' });
        const updated = { ...cloudCfgFromBody(body.type, body), id: body.id, lastSyncAt: cfgs[idx].lastSyncAt, lastSyncOk: cfgs[idx].lastSyncOk, lastSyncMsg: cfgs[idx].lastSyncMsg };
        cfgs[idx] = updated;
    } else {
        /* 新增配置 */
        const c = cloudCfgFromBody(body.type, body);
        c.id = 'c' + Date.now().toString(36);
        cfgs.push(c);
    }
    saveAllCloudCfgs(cfgs);
    res.json({ code: 0, msg: '云端配置已保存' });
});

app.post('/api/admin/cloud/delete', checkAdmin, (req, res) => {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ code: 1, msg: '缺少配置 ID' });
    const cfgs = getAllCloudCfgs().filter(c => c.id !== id);
    if (cfgs.length === getAllCloudCfgs().length) return res.status(404).json({ code: 1, msg: '配置不存在' });
    saveAllCloudCfgs(cfgs);
    res.json({ code: 0, msg: '已删除云端配置' });
});

app.post('/api/admin/cloud/test', checkAdmin, async (req, res) => {
    const body = req.body || {};
    if (!CLOUD_TYPES.includes(body.type)) return res.status(400).json({ code: 1, msg: '无效的同步类型' });
    const c = cloudCfgFromBody(body.type, body);
    try {
        const t0 = Date.now();
        const cloud = createCloud(c);
        await cloud.test();
        res.json({ code: 0, msg: '连接成功（' + (Date.now() - t0) + 'ms）' });
    } catch (e) {
        res.json({ code: 1, msg: '连接失败: ' + safeErrMsg(e) });
    }
});

app.post('/api/admin/cloud/sync', checkAdmin, async (req, res) => {
    try {
        const { id } = req.body || {};
        const cfgs = getAllCloudCfgs();
        const targets = id ? cfgs.filter(c => c.id === id) : cfgs.filter(c => c.enabled && c.type);
        if (!targets.length) return res.status(400).json({ code: 1, msg: '没有可同步的云端配置' });
        let total = 0;
        for (const cfg of targets) {
            await cloudSyncOne(cfg);
            total++;
            cfg.lastSyncAt = Date.now();
            cfg.lastSyncOk = true;
            cfg.lastSyncMsg = '已同步';
        }
        saveAllCloudCfgs(cfgs);
        res.json({ code: 0, msg: '同步完成，共 ' + total + ' 个云端目标', data: { count: total } });
    } catch (e) {
        res.status(500).json({ code: 1, msg: '同步失败: ' + safeErrMsg(e) });
    }
});

app.get('/api/admin/cloud/list', checkAdmin, async (req, res) => {
    try {
        const { id } = req.query || {};
        const cfgs = getAllCloudCfgs();
        const target = id ? cfgs.find(c => c.id === id) : cfgs.find(c => c.enabled && c.type);
        if (!target) {
            res.json({ code: 0, data: [] });
            return;
        }
        const cloud = createCloud(target);
        const rows = await cloud.list();
        rows.sort((a, b) => (b.modified || 0) - (a.modified || 0));
        res.json({ code: 0, data: rows.filter(r => BACKUP_NAME_RE.test(r.name)), targetId: target.id });
    } catch (e) {
        res.status(500).json({ code: 1, msg: '获取云端列表失败: ' + safeErrMsg(e) });
    }
});

/* 云端备份 → 本地，下载/删除 需传 cloudId 指定云端配置 */
app.post('/api/admin/cloud/download', checkAdmin, async (req, res) => {
    const { id: cloudId, name } = req.body || {};
    if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ code: 1, msg: '无效的备份文件名' });
    try {
        const cfgs = getAllCloudCfgs();
        const target = cfgs.find(c => c.id === cloudId) || cfgs.find(c => c.enabled && c.type);
        if (!target) return res.status(400).json({ code: 1, msg: '云端未配置' });
        const cloud = createCloud(target);
        const dest = path.join(BACKUP_DIR, name);
        await cloud.download(name, dest);
        res.json({ code: 0, msg: '已下载到本地: ' + name });
    } catch (e) {
        res.status(500).json({ code: 1, msg: '下载失败: ' + safeErrMsg(e) });
    }
});

app.post('/api/admin/cloud/delete', checkAdmin, async (req, res) => {
    const { id: cloudId, name } = req.body || {};
    if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ code: 1, msg: '无效的备份文件名' });
    try {
        const cfgs = getAllCloudCfgs();
        const target = cfgs.find(c => c.id === cloudId) || cfgs.find(c => c.enabled && c.type);
        if (!target) return res.status(400).json({ code: 1, msg: '云端未配置' });
        const cloud = createCloud(target);
        await cloud.remove(name);
        res.json({ code: 0, msg: '已删除云端备份 ' + name });
    } catch (e) {
        res.status(500).json({ code: 1, msg: '删除失败: ' + safeErrMsg(e) });
    }
});

app.get('/api/admin/backup/list', checkAdmin, (req, res) => {
    res.json({ code: 0, data: { config: getBackupCfg(), backups: listBackups().reverse() } });
});

app.post('/api/admin/backup/config', checkAdmin, (req, res) => {
    const { enabled, intervalHours, maxKeep, contents } = req.body || {};
    const cfg = getBackupCfg();
    if (enabled !== undefined) cfg.enabled = !!enabled;
    if (intervalHours) cfg.intervalHours = Math.max(1, Math.min(720, parseInt(intervalHours) || 24));
    if (maxKeep) cfg.maxKeep = Math.max(1, Math.min(100, parseInt(maxKeep) || 10));
    if (contents) cfg.contents = Array.isArray(contents) ? contents.filter(x => x === 'data' || x === 'config') : cfg.contents;
    /* 保存配置即重置计时：立即开始按新间隔运行（首次启用时 nextRunAt=0 → 立即备份一次） */
    cfg.nextRunAt = 0;
    saveBackupCfg(cfg);
    if (cfg.enabled) checkBackupSchedule();
    res.json({ code: 0, msg: '备份配置已保存', data: cfg });
});

app.post('/api/admin/backup/run', checkAdmin, async (req, res) => {
    try {
        const r = await runBackup();
        res.json({ code: 0, msg: '备份完成: ' + r.name, data: r });
    } catch (e) {
        res.status(500).json({ code: 1, msg: '备份失败: ' + safeErrMsg(e) });
    }
});

/* 添加备份流程：选择备份内容 + 目标（local=本地 / cloud=云端 / 二者都要），可一次生成多份备份 */
app.post('/api/admin/backup/create', checkAdmin, async (req, res) => {
    const { contents, targets } = req.body || {};
    const t = Array.isArray(targets) ? targets.filter(x => x === 'local' || x === 'cloud') : ['local'];
    if (!t.length) return res.status(400).json({ code: 1, msg: '请选择备份目标' });
    try {
        const r = await runBackup(contents, { autoSync: false });
        const result = { name: r.name, size: r.size, contents: r.contents, targets: t, local: t.includes('local'), cloud: false };
        if (t.includes('cloud')) {
            const cfgs = getAllCloudCfgs();
            const enabled = cfgs.filter(c => c.enabled && c.type);
            if (!enabled.length) return res.status(400).json({ code: 1, msg: '云端未配置，请先在「管理配置 → 云端同步」中保存连接配置' });
            for (const cfg of enabled) {
                try { await cloudUploadFile(cfg, r.name); } catch (e) { console.error('[云端] 创建备份同步失败:', safeErrMsg(e)); }
            }
            result.cloud = true;
            if (!t.includes('local')) {
                try { fs.rmSync(path.join(BACKUP_DIR, r.name)); result.localRemoved = true; } catch (e) {}
            }
            /* 更新所有使用过的云端配置的同步状态 */
            const allCfgs = getAllCloudCfgs();
            for (const c of allCfgs) {
                if (enabled.some(e => e.id === c.id)) {
                    c.lastSyncAt = Date.now();
                    c.lastSyncOk = true;
                    c.lastSyncMsg = '已同步 ' + r.name;
                }
            }
            saveAllCloudCfgs(allCfgs);
        }
        const parts = [];
        if (result.local) parts.push('本地');
        if (result.cloud) parts.push('云端');
        res.json({ code: 0, msg: '备份完成（' + parts.join(' + ') + '）', data: result });
    } catch (e) {
        res.status(500).json({ code: 1, msg: '备份失败: ' + safeErrMsg(e) });
    }
});

app.get('/api/admin/backup/download', checkAdmin, (req, res) => {
    const name = String(req.query.name || '');
    if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ code: 1, msg: '无效的备份文件名' });
    const file = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(file)) return res.status(404).json({ code: 1, msg: '备份不存在' });
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.sendFile(file);
});

app.post('/api/admin/backup/delete', checkAdmin, (req, res) => {
    const { name } = req.body || {};
    if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ code: 1, msg: '无效的备份文件名' });
    const file = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(file)) return res.status(404).json({ code: 1, msg: '备份不存在' });
    fs.rmSync(file);
    res.json({ code: 0, msg: '已删除备份 ' + name });
});

/* 从备份恢复：数据覆盖当前存储；配置合并恢复但保留当前数据库连接，避免恢复后连错库 */
app.post('/api/admin/backup/restore', checkAdmin, async (req, res) => {
    const { name } = req.body || {};
    if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ code: 1, msg: '无效的备份文件名' });
    const file = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(file)) return res.status(404).json({ code: 1, msg: '备份不存在' });
    dbMigrating = true;
    try {
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!payload || !payload.backup) return res.status(400).json({ code: 1, msg: '备份文件损坏' });
        if (payload.data) await restoreAll(store, payload.data);
        if (payload.config) {
            const config = readConfig();
            const merged = { ...DEFAULT_CONFIG, ...payload.config };
            merged.security = { ...DEFAULT_CONFIG.security, ...(payload.config.security || {}) };
            merged.db = config.db; /* 保留当前数据库连接配置 */
            merged.backup = config.backup; /* 保留当前备份配置 */
            writeConfig(merged);
            applyTrustProxy(merged);
        }
        res.json({ code: 0, msg: '已从备份恢复' + (payload.data ? '（数据）' : '') + (payload.config ? '（配置）' : '') });
    } catch (e) {
        res.status(500).json({ code: 1, msg: '恢复失败: ' + safeErrMsg(e) });
    } finally {
        dbMigrating = false;
    }
});

/* 批量恢复：按时间从旧到新依次恢复所选备份（数据/配置同步协调，全程暂停写入） */
app.post('/api/admin/backup/restore-batch', checkAdmin, async (req, res) => {
    const { names } = req.body || {};
    if (!Array.isArray(names) || !names.length) return res.status(400).json({ code: 1, msg: '未选择备份' });
    if (names.length > 20) return res.status(400).json({ code: 1, msg: '单次最多恢复 20 个备份' });
    const all = listBackups();
    const byName = {};
    for (const b of all) byName[b.name] = b;
    const ordered = [];
    for (const n of names) {
        if (!BACKUP_NAME_RE.test(n) || !byName[n]) return res.status(400).json({ code: 1, msg: '无效的备份: ' + n });
        ordered.push(byName[n]);
    }
    ordered.sort((a, b) => a.mtime - b.mtime); /* 旧 → 新 */
    dbMigrating = true;
    let restored = 0;
    try {
        for (const b of ordered) {
            const payload = JSON.parse(fs.readFileSync(b.path ? b.path : path.join(BACKUP_DIR, b.name), 'utf8'));
            if (!payload || !payload.backup) continue;
            if (payload.data) await restoreAll(store, payload.data);
            if (payload.config) {
                const config = readConfig();
                const merged = { ...DEFAULT_CONFIG, ...payload.config };
                merged.security = { ...DEFAULT_CONFIG.security, ...(payload.config.security || {}) };
                merged.db = config.db;
                merged.backup = config.backup;
                writeConfig(merged);
                applyTrustProxy(merged);
            }
            restored++;
        }
        res.json({ code: 0, msg: '已依次恢复 ' + restored + ' 个备份' });
    } catch (e) {
        res.status(500).json({ code: 1, msg: '恢复失败（已恢复 ' + restored + ' 个）: ' + safeErrMsg(e) });
    } finally {
        dbMigrating = false;
    }
});

/* 构建某存储类型的连接配置（未填字段继承现有配置） */
function buildDbCfg(type, sqlite, mysql, postgres, mongodb, old) {
    const cfg = { sqlite: {}, mysql: {}, postgres: {}, mongodb: {} };
    if (type === 'sqlite') {
        cfg.sqlite = { file: sqlite.file || (old.sqlite && old.sqlite.file) || 'data/app.db' };
    } else if (type === 'mysql' || type === 'mariadb') {
        cfg.mysql = {
            host: mysql.host || (old.mysql && old.mysql.host) || '127.0.0.1',
            port: parseInt(mysql.port) || (old.mysql && old.mysql.port) || 3306,
            user: mysql.user || (old.mysql && old.mysql.user) || 'root',
            password: (mysql.password !== undefined && mysql.password !== '') ? mysql.password : ((old.mysql && old.mysql.password) || ''),
            database: mysql.database || (old.mysql && old.mysql.database) || ''
        };
    } else if (type === 'postgres') {
        cfg.postgres = {
            host: postgres.host || (old.postgres && old.postgres.host) || '127.0.0.1',
            port: parseInt(postgres.port) || (old.postgres && old.postgres.port) || 5432,
            user: postgres.user || (old.postgres && old.postgres.user) || 'postgres',
            password: (postgres.password !== undefined && postgres.password !== '') ? postgres.password : ((old.postgres && old.postgres.password) || ''),
            database: postgres.database || (old.postgres && old.postgres.database) || ''
        };
    } else if (type === 'mongodb') {
        cfg.mongodb = {
            host: mongodb.host || (old.mongodb && old.mongodb.host) || '127.0.0.1',
            port: parseInt(mongodb.port) || (old.mongodb && old.mongodb.port) || 27017,
            user: mongodb.user || (old.mongodb && old.mongodb.user) || '',
            password: (mongodb.password !== undefined && mongodb.password !== '') ? mongodb.password : ((old.mongodb && old.mongodb.password) || ''),
            database: mongodb.database || (old.mongodb && old.mongodb.database) || 'artplayer'
        };
    }
    return cfg;
}

app.get('/api/admin/security/geo/info', checkAdmin, (req, res) => {
    res.json({ code: 0, data: { v4: geoDbInfo(GEO_V4_FILE), v6: geoDbInfo(GEO_V6_FILE), inUse: !!(ipSearcher4 || ipSearcher6) } });
});

/* 地图区域聚合：world = 按国家（名称对齐 echarts world.json），china = 按省份（短名） */
const WORLD_CODE_NAMES = {
    'CN': 'China', 'US': 'United States', 'JP': 'Japan', 'KR': 'Korea',
    'GB': 'United Kingdom', 'DE': 'Germany', 'FR': 'France', 'RU': 'Russia', 'CA': 'Canada',
    'AU': 'Australia', 'IN': 'India', 'SG': 'Singapore', 'MY': 'Malaysia', 'TH': 'Thailand',
    'VN': 'Vietnam', 'ID': 'Indonesia', 'PH': 'Philippines', 'NL': 'Netherlands',
    'CH': 'Switzerland', 'SE': 'Sweden', 'IT': 'Italy', 'ES': 'Spain', 'PL': 'Poland',
    'TR': 'Turkey', 'IL': 'Israel', 'AE': 'United Arab Emirates', 'SA': 'Saudi Arabia',
    'PK': 'Pakistan', 'KZ': 'Kazakhstan', 'MN': 'Mongolia', 'MM': 'Myanmar', 'BR': 'Brazil',
    'AR': 'Argentina', 'CL': 'Chile', 'MX': 'Mexico', 'ZA': 'South Africa', 'EG': 'Egypt',
    'NZ': 'New Zealand'
};
app.get('/api/admin/security/geo/regions', checkAdmin, async (req, res) => {
    const scope = req.query.scope === 'china' ? 'china' : 'world';
    const agg = {};
    for (const ip of Object.keys(ipTotals.calls)) {
        const g = await geoLookup(ip);
        if (!g) continue;
        const v = ipTotals.calls[ip], b = ipTotals.bytes[ip] || 0;
        if (scope === 'china') {
            const isCN = g.code === 'CN' || g.country === '中国' || g.country === 'China' || PROVINCE_COORDS[normProvince(g.province)];
            const name = isCN ? (normProvince(g.province) || '中国') : '海外';
            const e = agg[name] || (agg[name] = { code: '', calls: 0, bytes: 0, ips: 0 });
            e.calls += v; e.bytes += b; e.ips++;
        } else {
            if (!g.country || g.country === '0' || g.country === 'Reserved' || g.country === '保留' || g.country === '内网IP' || g.country === '保留地址' || g.country === '本机地址' || g.country === '局域网' || g.country === '未知' || g.country === 'Unknown') continue;
            const name = WORLD_CODE_NAMES[g.code] || (g.country === '中国' ? 'China' : g.country) || g.country;
            const e = agg[name] || (agg[name] = { code: g.code || '', calls: 0, bytes: 0, ips: 0 });
            e.calls += v; e.bytes += b; e.ips++;
        }
    }
    const list = Object.entries(agg).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.calls - a.calls);
    res.json({ code: 0, data: list });
});

app.post('/api/admin/security/geo/update', checkAdmin, async (req, res) => {
    try {
        await ensureGeoDb(true);
        res.json({ code: 0, msg: '地址库已更新', data: { v4: geoDbInfo(GEO_V4_FILE), v6: geoDbInfo(GEO_V6_FILE) } });
    } catch (e) {
        res.json({ code: 1, msg: '更新失败: ' + e.message });
    }
});

// ==================== 字幕检测 ====================

// 接受外部字幕 url
app.post('/api/subtitle/external', (req, res) => {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.json({ code: 1, msg: '无效链接' });
    res.json({ code: 0, data: { url } });
});

// ==================== 字幕库（字幕管理） ====================

const SUB_CHARS = '23456789abcdefghijkmnpqrstuvwxyz'; // 与视频 ID 同字符集
const SUB_DIR = path.join(DATA_DIR, 'subtitles'); /* 本地化/上传字幕文件存储 */

/* 内网/保留/元数据 IP 段（防 SSRF：字幕 URL 不允许指向这些地址） */
function isPrivateIp(ip) {
    const s = String(ip || '');
    if (s.includes(':')) {
        const lower = s.toLowerCase();
        if (lower === '::1' || lower === '::' || lower === '[::1]' || lower === '[::]') return true;
        if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff') || lower.startsWith('fe')) return true;
        return false; /* 其余 IPv6 视为公网 */
    }
    const parts = s.split('.');
    if (parts.length !== 4) return true;
    const n = parts.map(Number);
    if (n.some(x => isNaN(x) || x < 0 || x > 255)) return true;
    const a = n[0], b = n[1];
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 192 && b === 168 ||
        a === 172 && b >= 16 && b <= 31 || a >= 224; /* 组播/保留 */
}

/* 字幕 URL 安全校验：拒绝内网/保留/元数据地址（DNS 解析后再次校验，防 DNS rebinding） */
async function isSafeSubtitleUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    if (/^\[|:/ .test(host)) { /* IPv6：拒绝回环/链路本地/未指定 */ if (host === '[::1]' || host === '::1' || host === '[::]' || host === '::') return false; return true; }
    const looksIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (looksIp) return !isPrivateIp(host);
    if (host === 'localhost') return false;
    /* 域名：DNS 解析校验 */
    try {
        const dns = require('dns');
        const addrs = await new Promise((resolve) => dns.lookup(host, { all: true }, (err, a) => err ? resolve([]) : resolve(a || [])));
        if (!addrs.length) return true; /* 解析失败放行，fetch 阶段会失败 */
        return addrs.every(a => !isPrivateIp(a.address.replace(/^::ffff:/, '')));
    } catch { return true; }
}

async function genSubId() {
    const existing = new Set((await store.subtitleAll()).map(s => s.id));
    for (let i = 0; i < 100; i++) {
        let s = 's';
        for (let j = 0; j < 7; j++) s += SUB_CHARS[Math.floor(Math.random() * SUB_CHARS.length)];
        if (!existing.has(s)) return s;
    }
    return 's' + Date.now().toString(36);
}
const SUB_EXT_RE = /\.(srt|vtt|ass|ssa|webvtt)$/i;
const SUB_FETCH_LIMIT = 5 * 1024 * 1024; /* 远程字幕内容上限 5MB */

function subLangName(lang) {
    const map = {
        'sc': '简体中文', 'chs': '简体中文', 'zh-cn': '简体中文', 'zh-hans': '简体中文', 'zh': '简体中文',
        'tc': '繁體中文', 'cht': '繁體中文', 'zh-tw': '繁體中文', 'zh-hk': '繁體中文', 'zh-hant': '繁體中文',
        'en': 'English', 'eng': 'English',
        'ja': '日本語', 'jpn': '日本語',
        'ko': '한국어', 'kor': '한국어',
        'fr': 'Français', 'de': 'Deutsch', 'es': 'Español', 'pt': 'Português',
        'it': 'Italiano', 'ru': 'Русский', 'ar': 'العربية', 'th': 'ไทย', 'vi': 'Tiếng Việt'
    };
    return map[String(lang || '').toLowerCase()] || String(lang || '');
}

/* 字幕内容获取：url 类型可远程拉取（限 5MB + 内网防护），file 类型读本地，text 类型直接返回 */
async function subtitleContent(sub) {
    if (!sub) return null;
    if (sub.type === 'text') return sub.content || null;
    if (sub.type === 'local' || sub.file) {
        const file = path.isAbsolute(sub.file) ? sub.file : path.join(SUB_DIR, sub.file);
        if (fs.existsSync(file)) {
            const st = fs.statSync(file);
            if (st.size > SUB_FETCH_LIMIT) return null;
            return fs.readFileSync(file, 'utf8');
        }
        return null;
    }
    if (sub.type === 'url' && sub.url) {
        if (!(await isSafeSubtitleUrl(sub.url))) return null;
        try {
            const resp = await fetch(sub.url, { signal: AbortSignal.timeout(20000) });
            if (!resp.ok) return null;
            const reader = resp.body.getReader();
            let chunks = [], total = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.length;
                if (total > SUB_FETCH_LIMIT) { await reader.cancel(); return null; }
                chunks.push(value);
            }
            return Buffer.concat(chunks).toString('utf8');
        } catch { return null; }
    }
    return null;
}

/* OpenList/AList 同目录字幕检测：仅对已启用且同源的 openlist 云端配置生效，避免凭据被外部触发利用 */
async function detectOpenlistSubs(videoUrl) {
    const url = String(videoUrl || '');
    if (!url) return [];
    const cfgs = getAllCloudCfgs();
    for (const cfg of cfgs) {
        if (!cfg.enabled || cfg.type !== 'openlist' || !cfg.baseUrl || !cfg.user) continue;
        const base = String(cfg.baseUrl).replace(/\/+$/, '');
        if (!url.startsWith(base)) continue;
        /* /d/xxx/yyy.mp4 → path /xxx/yyy.mp4；再取目录 */
        const m = url.match(/\/d\/(.+)$/);
        if (!m) continue;
        const rel = decodeURIComponent(m[1]);
        const dirPath = '/' + rel.split('/').slice(0, -1).join('/');
        const baseName = rel.split('/').pop().replace(/\.[^.]+$/, '');
        try {
            const cfg2 = { ...cfg, path: dirPath };
            const cloud2 = createCloud(cfg2);
            const items = await cloud2.list();
            const subs = items.filter(it => SUB_EXT_RE.test(it.name) && (it.name === baseName + '.srt' || it.name.startsWith(baseName + '.')));
            return subs.map(it => {
                const langPart = it.name.slice(baseName.length + 1).replace(/\.[^.]+$/, '');
                return { title: subLangName(langPart), lang: langPart.toLowerCase(), url: base + '/d/' + encodeURIComponent((dirPath + '/' + it.name).replace(/^\//, '')) };
            });
        } catch (e) { /* 检测失败忽略 */ }
    }
    return [];
}

app.get('/api/admin/subtitles', checkAdmin, async (req, res) => {
    const search = (req.query.search || '').toLowerCase();
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    let list = await store.subtitleAll();
    if (search) list = list.filter(s => String(s.name || '').toLowerCase().includes(search) || String(s.id || '').includes(search) || String(s.lang || '').includes(search));
    list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const start = (page - 1) * limit;
    res.json({ code: 0, data: { list: list.slice(start, start + limit), total, page, limit } });
});

app.post('/api/admin/subtitles', checkAdmin, async (req, res) => {
    const { name, lang, type, url, content, localize } = req.body || {};
    if (type !== 'url' && type !== 'text') return res.status(400).json({ code: 1, msg: '字幕类型仅支持链接或文本' });
    if (!name || !String(name).trim()) return res.status(400).json({ code: 1, msg: '字幕名称不能为空' });
    if (type === 'url' && !/^https?:\/\//i.test(url)) return res.status(400).json({ code: 1, msg: '无效的字幕链接' });
    if (type === 'url' && !(await isSafeSubtitleUrl(url))) return res.status(400).json({ code: 1, msg: '字幕链接指向内网/保留地址，已拒绝' });
    if (type === 'text' && (!content || content.length > 1024 * 1024)) return res.status(400).json({ code: 1, msg: '字幕内容为空或过大' });
    const sub = {
        id: await genSubId(),
        name: String(name).trim().slice(0, 100),
        lang: String(lang || '').toLowerCase().slice(0, 20),
        langName: subLangName(lang),
        type,
        url: type === 'url' ? String(url).slice(0, 2048) : '',
        content: type === 'text' ? content : '',
        file: '',
        localized: false,
        createdAt: Date.now()
    };
    /* 链接类型可选「立即本地化」：创建时直接下载到服务器存储 */
    let localizeWarn = '';
    if (type === 'url' && localize) {
        try {
            const resp = await fetch(sub.url, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const reader = resp.body.getReader();
            let chunks = [], total = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.length;
                if (total > SUB_FETCH_LIMIT) { await reader.cancel(); throw new Error('内容超过 5MB 上限'); }
                chunks.push(value);
            }
            if (!fs.existsSync(SUB_DIR)) fs.mkdirSync(SUB_DIR, { recursive: true });
            const saveName = sub.id + '-' + Date.now().toString(36) + '.vtt';
            fs.writeFileSync(path.join(SUB_DIR, saveName), Buffer.concat(chunks));
            sub.type = 'local';
            sub.file = saveName;
            sub.localized = true;
        } catch (e) {
            localizeWarn = '链接已保存，但本地化失败: ' + safeErrMsg(e);
        }
    }
    await store.subtitleAdd(sub);
    res.json({ code: 0, msg: localizeWarn ? '字幕已添加（' + localizeWarn + '）' : '字幕已添加', data: sub, warning: localizeWarn || null });
});

/* 上传字幕文件（存入 data/subtitles/，动态按配置校验大小） */
app.post('/api/admin/subtitles/upload', checkAdmin, upload.array('files'), async (req, res) => {
    if (!req.files || !req.files.length) return res.status(400).json({ code: 1, msg: '未选择文件' });
    const maxMB = getUploadLimits().maxMB;
    const tooBig = req.files.find(f => f.size > maxMB * 1024 * 1024);
    if (tooBig) return res.status(413).json({ code: 1, msg: '文件超过上传上限 ' + maxMB + 'MB: ' + path.basename(tooBig.originalname) });
    if (!fs.existsSync(SUB_DIR)) fs.mkdirSync(SUB_DIR, { recursive: true });
    const subs = [];
    for (const f of req.files) {
        const name = path.basename(f.originalname);
        if (!SUB_EXT_RE.test(name)) continue;
        const saveName = Date.now().toString(36) + '-' + name;
        const savePath = path.join(SUB_DIR, saveName);
        fs.writeFileSync(savePath, f.buffer);
        const langPart = name.replace(/\.[^.]+$/, '').split('.').pop();
        subs.push({
            id: await genSubId(),
            name: name,
            lang: SUB_EXT_RE.test(langPart) ? '' : langPart.toLowerCase(),
            langName: subLangName(langPart),
            type: 'local',
            url: '',
            content: '',
            file: saveName,
            localized: true,
            createdAt: Date.now()
        });
    }
    if (!subs.length) return res.status(400).json({ code: 1, msg: '没有有效的字幕文件（支持 srt/vtt/ass/ssa/webvtt）' });
    for (const s of subs) await store.subtitleAdd(s);
    res.json({ code: 0, msg: '已上传 ' + subs.length + ' 个字幕', data: subs });
});

/* 本地化：把 url 类型字幕下载到本地存储（限 5MB + 内网防护） */
app.post('/api/admin/subtitles/localize', checkAdmin, async (req, res) => {
    const { id } = req.body || {};
    const list = await store.subtitleAll();
    const sub = list.find(s => s.id === id);
    if (!sub) return res.status(404).json({ code: 1, msg: '字幕不存在' });
    if (sub.type !== 'url') return res.json({ code: 0, msg: '该字幕无需本地化' });
    if (!(await isSafeSubtitleUrl(sub.url))) return res.status(400).json({ code: 1, msg: '字幕链接指向内网/保留地址，已拒绝' });
    try {
        const resp = await fetch(sub.url, { signal: AbortSignal.timeout(30000) });
        if (!resp.ok) return res.status(502).json({ code: 1, msg: '拉取失败: HTTP ' + resp.status });
        const reader = resp.body.getReader();
        let chunks = [], total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > SUB_FETCH_LIMIT) { await reader.cancel(); return res.status(413).json({ code: 1, msg: '字幕内容超过 5MB 上限' }); }
            chunks.push(value);
        }
        const buf = Buffer.concat(chunks);
        if (!fs.existsSync(SUB_DIR)) fs.mkdirSync(SUB_DIR, { recursive: true });
        const saveName = sub.id + '-' + Date.now().toString(36) + '.vtt';
        fs.writeFileSync(path.join(SUB_DIR, saveName), buf);
        await store.subtitleUpdate(id, { type: 'local', file: saveName, localized: true });
        res.json({ code: 0, msg: '已本地化' });
    } catch (e) {
        res.status(502).json({ code: 1, msg: '本地化失败: ' + safeErrMsg(e) });
    }
});

app.delete('/api/admin/subtitles', checkAdmin, async (req, res) => {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ code: 1, msg: '参数不完整' });
    const ok = await store.subtitleDelete(id);
    if (!ok) return res.status(404).json({ code: 1, msg: '字幕不存在' });
    /* 清理视频映射中的关联 */
    const subs = await store.videoSubsAll();
    let changed = false;
    for (const [vid, ids] of Object.entries(subs)) {
        if (Array.isArray(ids) && ids.includes(id)) {
            subs[vid] = ids.filter(x => x !== id);
            changed = true;
        }
    }
    if (changed) await store.videoSubsWrite(subs);
    res.json({ code: 0, msg: '已删除' });
});

/* 应用字幕到视频（一个视频可应用多个字幕） */
app.post('/api/admin/subtitles/apply', checkAdmin, async (req, res) => {
    const { vid, ids } = req.body || {};
    if (!vid || !Array.isArray(ids)) return res.status(400).json({ code: 1, msg: '参数不完整' });
    const subs = await store.videoSubsAll();
    subs[vid] = Array.from(new Set(ids.filter(Boolean)));
    await store.videoSubsWrite(subs);
    res.json({ code: 0, msg: '已应用 ' + subs[vid].length + ' 个字幕' });
});

app.post('/api/admin/subtitles/unapply', checkAdmin, async (req, res) => {
    const { vid, id } = req.body || {};
    if (!vid || !id) return res.status(400).json({ code: 1, msg: '参数不完整' });
    const subs = await store.videoSubsAll();
    if (Array.isArray(subs[vid])) subs[vid] = subs[vid].filter(x => x !== id);
    await store.videoSubsWrite(subs);
    res.json({ code: 0, msg: '已取消应用' });
});

/* 视频可用的字幕：已应用的字幕 + 本地目录扫描 + OpenList 同目录 */
app.get('/api/subtitle/detect', async (req, res) => {
    const url = decodeURIComponent(req.query.url || '');
    if (!url) return res.json({ code: 1, msg: '缺少 url 参数' });

    /* 1. 本地目录扫描（原有逻辑） */
    let local = [];
    if (!/^https?:\/\//i.test(url)) {
        const clean = url.split('?')[0].split('#')[0].replace(/^\//, '');
        if (!clean.includes('..') && !path.isAbsolute(clean)) {
            const dir = path.dirname(clean);
            const base = path.basename(clean, path.extname(clean));
            const subExts = ['.srt', '.vtt', '.ass', '.ssa', '.webvtt'];
            const searchDir = path.join(__dirname, 'public', dir);
            const publicRoot = path.join(__dirname, 'public');
            if ((searchDir.startsWith(publicRoot + path.sep) || searchDir === publicRoot) && fs.existsSync(searchDir)) {
                for (const f of fs.readdirSync(searchDir)) {
                    const fullExt = path.extname(f).toLowerCase();
                    if (!subExts.includes(fullExt)) continue;
                    const nameNoExt = f.slice(0, -fullExt.length);
                    if (nameNoExt === base) local.push({ title: '默认', lang: '', url: '/' + path.join(dir, f).replace(/\\/g, '/') });
                    else if (nameNoExt.startsWith(base + '.')) {
                        const langPart = nameNoExt.slice(base.length + 1);
                        local.push({ title: subLangName(langPart), lang: langPart.toLowerCase(), url: '/' + path.join(dir, f).replace(/\\/g, '/') });
                    }
                }
                local.sort((a, b) => (a.title === '默认' ? -1 : b.title === '默认' ? 1 : a.title.localeCompare(b.title, 'zh')));
            }
        }
    }

    /* 2. OpenList 同目录检测（远程视频且匹配已配置的 openlist 实例） */
    let remote = [];
    if (/^https?:\/\//i.test(url)) remote = await detectOpenlistSubs(url);

    /* 3. 已应用的字幕库字幕（按 URL 匹配所有 vid，合并去重） */
    let applied = [];
    try {
        const videos = await store.videosAll();
        const subsMap = await store.videoSubsAll();
        const vids = [];
        for (const [v, u] of Object.entries(videos)) { if (u === url) vids.push(v); }
        if (vids.length) {
            const all = await store.subtitleAll();
            const seen = new Set();
            for (const vid of vids) {
                const ids = Array.isArray(subsMap[vid]) ? subsMap[vid] : [];
                for (const id of ids) {
                    if (seen.has(id)) continue;
                    seen.add(id);
                    const s = all.find(x => x.id === id);
                    if (s) applied.push({ id: s.id, title: s.langName || s.name, lang: s.lang, url: 'subtitle:' + s.id, library: true });
                }
            }
        }
    } catch { /* 忽略 */ }

    res.json({ code: 0, data: { subtitles: [...local, ...applied, ...remote] } });
});

/* 播放器按 ID 加载字幕内容 */
app.get('/api/subtitle/by-id', async (req, res) => {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ code: 1, msg: '缺少 id' });
    const all = await store.subtitleAll();
    const sub = all.find(s => s.id === id);
    if (!sub) return res.status(404).json({ code: 1, msg: '字幕不存在' });
    const content = await subtitleContent(sub);
    if (content == null) return res.status(502).json({ code: 1, msg: '字幕内容获取失败' });
    res.type('text/plain; charset=utf-8');
    res.send(content);
});

// ==================== 控制台（统计与性能监控） ====================

let perfHistory = []; /* 性能采样：{t, mem, cpu, req} */
let lastCpuUsage = process.cpuUsage();
let lastCpuAt = Date.now();
let lastReqCount = 0;
function samplePerf() {
    const now = Date.now();
    const cpu = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    const cpuPct = Math.max(0, Math.min(100, (cpu.user + cpu.system) / 1000 / Math.max(1, now - lastCpuAt) * 100));
    lastCpuAt = now;
    const mem = process.memoryUsage();
    const totalCalls = Object.values(apiTotals.calls).reduce((a, b) => a + b, 0);
    perfHistory.push({ t: now, mem: Math.round(mem.rss / 1048576 * 10) / 10, cpu: Math.round(cpuPct * 10) / 10, req: totalCalls });
    if (perfHistory.length > 120) perfHistory.shift();
}
setInterval(samplePerf, 10000);

app.get('/api/admin/dashboard', checkAdmin, async (req, res) => {
    try {
        const danmuCount = (await store.danmuAll()).length;
        const videoCount = Object.keys(await store.videosAll()).length;
        const subtitleCount = (await store.subtitleAll()).length;
        const bannedCount = (await store.bannedAll(true)).length;
        const ipCount = Object.keys(ipTotals.calls).length;
        const totalCalls = Object.values(apiTotals.calls).reduce((a, b) => a + b, 0);
        const totalBytes = Object.values(apiTotals.bytes).reduce((a, b) => a + b, 0);
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();
        const loginLogCount = (await store.loginLogs()).length;
        const backupCount = listBackups().length;
        /* 最近 1 分钟请求（秒桶累计） */
        const now = Math.floor(Date.now() / 1000);
        const lastMin = apiLayers.s.buckets.filter(b => now - b.ts < 60).reduce((a, b) => a + Object.values(b.calls).reduce((x, y) => x + y, 0), 0);
        res.json({
            code: 0,
            data: {
                totals: { calls: totalCalls, bytes: totalBytes, ips: ipCount, lastMinuteCalls: lastMin },
                counts: { danmu: danmuCount, videos: videoCount, subtitles: subtitleCount, bannedWords: bannedCount, logins: loginLogCount, backups: backupCount },
                perf: {
                    memRss: Math.round(mem.rss / 1048576), memHeap: Math.round(mem.heapUsed / 1048576),
                    cpuMs: cpu.user + cpu.system,
                    uptimeSec: Math.floor((Date.now() - API_START_TIME) / 1000),
                    pid: process.pid,
                    node: process.version,
                    version: APP_VERSION
                },
                history: perfHistory
            }
        });
    } catch (e) {
        res.status(500).json({ code: 1, msg: safeErrMsg(e) });
    }
});

// ==================== 依赖管理 ====================

let depsCache = null;
async function getDeps(force) {
    const now = Date.now();
    if (!force && depsCache && now - depsCache.at < 1800000) return depsCache.data;
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const deps = Object.entries(pkg.dependencies || {}).map(([name, cur]) => ({ name, current: cur.replace(/^[\^~]/, ''), type: 'dependency' }));
    /* 查询最新版本 */
    const latest = {};
    await Promise.all(deps.slice(0, 30).map(async (d) => {
        try {
            const r = await fetch('https://registry.npmjs.org/' + encodeURIComponent(d.name) + '/latest', { signal: AbortSignal.timeout(8000) });
            if (r.ok) { const j = await r.json(); latest[d.name] = j.version || ''; }
        } catch (e) {}
    }));
    const list = deps.map(d => ({ ...d, latest: latest[d.name] || '' }));
    const result = { list, checkedAt: now };
    depsCache = { at: now, data: result };
    return result;
}

app.get('/api/admin/deps', checkAdmin, async (req, res) => {
    try {
        const data = await getDeps(req.query.force === '1');
        res.json({ code: 0, data });
    } catch (e) {
        res.status(500).json({ code: 1, msg: safeErrMsg(e) });
    }
});

/* 更新依赖（独立进程执行 npm install，避免占用服务） */
app.post('/api/admin/deps/update', checkAdmin, (req, res) => {
    const { names } = req.body || {};
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const deps = names && names.length ? names : Object.keys(pkg.dependencies || {});
    const args = deps.map(n => (n.startsWith('@') ? n : n) + '@latest').join(' ');
    const child = require('child_process').spawn('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false', ...deps.map(n => n + '@latest')], {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    console.log('[依赖] 更新进程已启动: ' + deps.join(', '));
    res.json({ code: 0, msg: '依赖更新已在后台执行（' + deps.length + ' 个），完成后需重启服务生效' });
});

// ==================== 插件管理 ====================

app.get('/api/admin/plugins', checkAdmin, (req, res) => {
    res.json({ code: 0, data: { list: pluginManager.list(), dir: pluginManager.meta.size ? 'plugins/' : 'plugins/' } });
});

/* 安装插件：source = file（上传 js）/ url（GitHub 等下载）/ npm（npm 包） */
app.post('/api/admin/plugins/install', checkAdmin, upload.array('files'), async (req, res) => {
    try {
        const { source, url, pkg } = req.body || {};
        let name;
        if (source === 'file') {
            if (!req.files || !req.files.length) return res.status(400).json({ code: 1, msg: '未选择插件文件' });
            const f = req.files[0];
            if (f.size > 1024 * 1024) return res.status(413).json({ code: 1, msg: '插件文件超过 1MB 上限' });
            name = await pluginManager.install({ source: 'file', fileContent: f.buffer, filename: f.originalname });
        } else if (source === 'url') {
            name = await pluginManager.install({ source: 'url', url });
        } else if (source === 'npm') {
            name = await pluginManager.install({ source: 'npm', pkg });
        } else {
            return res.status(400).json({ code: 1, msg: '安装方式无效' });
        }
        res.json({ code: 0, msg: '已安装插件 ' + name + '，可在列表中启用', data: { name } });
    } catch (e) {
        res.status(400).json({ code: 1, msg: '安装失败: ' + safeErrMsg(e) });
    }
});

app.post('/api/admin/plugins/toggle', checkAdmin, async (req, res) => {
    try {
        const { name, enabled } = req.body || {};
        await pluginManager.setEnabled(name, !!enabled);
        const meta = pluginManager.list().find(p => p.name === name);
        res.json({ code: 0, msg: enabled ? '已启用' : '已禁用', data: meta });
    } catch (e) {
        res.status(400).json({ code: 1, msg: safeErrMsg(e) });
    }
});

app.post('/api/admin/plugins/config', checkAdmin, async (req, res) => {
    try {
        const { name, config } = req.body || {};
        await pluginManager.setConfig(name, config);
        res.json({ code: 0, msg: '配置已保存并热重载' });
    } catch (e) {
        res.status(400).json({ code: 1, msg: safeErrMsg(e) });
    }
});

app.post('/api/admin/plugins/uninstall', checkAdmin, async (req, res) => {
    try {
        const { name } = req.body || {};
        await pluginManager.uninstall(name);
        res.json({ code: 0, msg: '已卸载插件 ' + name });
    } catch (e) {
        res.status(400).json({ code: 1, msg: safeErrMsg(e) });
    }
});

// ==================== 版本检测与更新 ====================

let updateCheckCache = null;
function cmpVer(a, b) {
    const pa = String(a || '').replace(/^v/i, '').split('.').map(n => parseInt(n) || 0);
    const pb = String(b || '').replace(/^v/i, '').split('.').map(n => parseInt(n) || 0);
    for (let i = 0; i < 3; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
}

/* 检测部署方式：docker / npm 全局 / git 源码 / 普通源码 */
function detectDeploy() {
    if (fs.existsSync('/.dockerenv')) return 'docker';
    try {
        const globalRoot = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
        if (globalRoot && __dirname.startsWith(globalRoot)) return 'npm-global';
    } catch (e) {}
    if (fs.existsSync(path.join(__dirname, '.git'))) return 'git-source';
    return 'source';
}

async function checkVersionUpdate(force) {
    const now = Date.now();
    if (!force && updateCheckCache && now - updateCheckCache.at < 3600000) return updateCheckCache.data;
    const result = {
        checkedAt: now,
        current: APP_VERSION,
        deploy: detectDeploy(),
        sources: {},
        hasUpdate: false,
        latest: null,
        releaseNotes: ''
    };
    /* GitHub 最新 Release */
    try {
        const r = await fetch('https://api.github.com/repos/yangyang8002/Artplayer-Web-Api/releases/latest', { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'ArtPlayer-Web-Api' } });
        if (r.ok) {
            const d = await r.json();
            result.sources.github = { tag: d.tag_name || '', published: d.published_at || '', url: d.html_url || '', body: (d.body || '').slice(0, 2000) };
        }
    } catch (e) {}
    /* npm 最新版本 */
    try {
        const r2 = await fetch('https://registry.npmjs.org/artplayer-web-api/latest', { signal: AbortSignal.timeout(12000) });
        if (r2.ok) {
            const d2 = await r2.json();
            result.sources.npm = { version: d2.version || '' };
        }
    } catch (e) {}
    /* 远程 update.xml：版本清单 + 变更文件列表 */
    try {
        const r3 = await fetch('https://raw.githubusercontent.com/yangyang8002/Artplayer-Web-Api/master/update.xml', { signal: AbortSignal.timeout(12000) });
        if (r3.ok) {
            const txt = await r3.text();
            const ver = (txt.match(/<version>([^<]+)<\/version>/) || [])[1] || '';
            const msg = (txt.match(/<message>([\s\S]*?)<\/message>/) || [])[1] || '';
            const re = /<file\s+path="([^"]+)"\s+sha256="[^"]+"(?:\s+size="\d+")?\/>/g;
            let m, files = [];
            while ((m = re.exec(txt))) files.push(m[1]);
            result.sources.manifest = { version: ver, message: msg.trim(), files };
        }
    } catch (e) {}
    /* 取最高版本作为最新（manifest 优先于 github/npm 作为发布源） */
    let latest = null, srcName = '';
    const cands = [];
    if (result.sources.manifest && result.sources.manifest.version) cands.push(['manifest', result.sources.manifest.version.replace(/^v/i, '')]);
    if (result.sources.github && result.sources.github.tag) cands.push(['github', result.sources.github.tag.replace(/^v/i, '')]);
    if (result.sources.npm && result.sources.npm.version) cands.push(['npm', result.sources.npm.version]);
    for (const [name, ver] of cands) {
        if (!latest || cmpVer(ver, latest) > 0) { latest = ver; srcName = name; }
    }
    if (latest && cmpVer(latest, APP_VERSION) > 0) {
        result.hasUpdate = true;
        result.latest = latest;
        result.latestSource = srcName;
        result.releaseNotes = (result.sources.manifest && result.sources.manifest.message) || (result.sources.github ? result.sources.github.body || '' : '');
        result.releaseUrl = result.sources.github ? result.sources.github.url : 'https://github.com/yangyang8002/Artplayer-Web-Api/releases';
        result.changedFiles = (result.sources.manifest && result.sources.manifest.files) || [];
    }
    updateCheckCache = { at: now, data: result };
    return result;
}

app.get('/api/admin/update/check', checkAdmin, async (req, res) => {
    try {
        const force = req.query.force === '1';
        const data = await checkVersionUpdate(force);
        res.json({ code: 0, data });
    } catch (e) {
        res.status(500).json({ code: 1, msg: '检查更新失败: ' + safeErrMsg(e) });
    }
});

/* 执行更新：交由独立进程 update.js（备份 data/ → 更新代码 → 校验 → 依赖安装 → 重启）
   来源可选：git（git pull）/ npm（下载 npm 包覆盖）/ auto（按部署方式自动） */
app.post('/api/admin/update/run', checkAdmin, async (req, res) => {
    const { restart, source } = req.body || {};
    const deploy = detectDeploy();
    const info = await checkVersionUpdate(true).catch(() => null);
    if (info && !info.hasUpdate) return res.json({ code: 1, msg: '当前已是最新版本', data: { current: APP_VERSION, latest: info.latest } });
    if (deploy === 'docker') {
        return res.json({ code: 1, msg: 'Docker 部署请在宿主机执行: docker pull yangyang8002/artplayer-web-api:latest && docker compose up -d' });
    }
    if (!fs.existsSync(path.join(__dirname, 'update.js'))) {
        return res.json({ code: 1, msg: '未找到 update.js（独立更新进程），请检查安装完整性' });
    }
    if (deploy === 'source' && source !== 'npm') {
        return res.json({ code: 1, msg: '无法识别部署方式，请选择从 npm 更新或手动更新' });
    }
    /* 启动独立更新进程（不占用当前进程执行更新，避免文件句柄/状态问题） */
    const args = [path.join(__dirname, 'update.js'), '--source=' + (source === 'npm' || source === 'git' ? source : 'auto')];
    if (restart === false) args.push('--no-restart');
    const child = require('child_process').spawn(process.execPath, args, {
        cwd: __dirname,
        env: { ...process.env, PORT: String(PORT) },
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    console.log('[更新] 已启动独立更新进程 PID=' + child.pid + ' source=' + source);
    res.json({ code: 0, msg: '更新进程已启动（来源: ' + (source === 'git' ? 'Git' : source === 'npm' ? 'npm' : '自动') + '；后台执行：备份数据 → 更新代码 → 安装依赖 → ' + (restart === false ? '等待手动重启' : '自动重启') + '），日志见 data/update.log', data: { pid: child.pid, deploy, source } });
});

// 主题 API
// ==================== 页面路由 ====================

const THEME_DIR = path.join(__dirname, 'theme');
app.get('/api/theme/:type/list', (req, res) => {
    const type = req.params.type === 'player' || req.params.type === 'admin' ? req.params.type : null;
    if (!type) return res.status(400).json({ code: 1, msg: '类型错误' });
    const dir = path.join(THEME_DIR, type);
    if (!fs.existsSync(dir)) return res.json({ code: 0, data: [] });
    const list = fs.readdirSync(dir).filter(n => fs.existsSync(path.join(dir, n, 'theme.json'))).map(n => {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, n, 'theme.json'), 'utf8'));
            return { id: j.id || n, name: j.displayName || n };
        } catch (e) { return { id: n, name: n }; }
    });
    res.json({ code: 0, data: list });
});
app.get('/api/theme/:type.css', (req, res) => {
    const type = req.params.type === 'player' || req.params.type === 'admin' ? req.params.type : null;
    if (!type) return res.status(400).json({ code: 1, msg: '类型错误' });
    const file = path.join(THEME_DIR, type + '.css');
    if (!fs.existsSync(file)) return res.status(404).json({ code: 1, msg: 'CSS 未构建' });
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.sendFile(file);
});

app.get('/favicon.ico', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

app.get('/player/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

/* 管理后台入口（自定义 adminPath 即时生效）：
   设置入口路径后自动替换默认 /admin/，无需重启 */
function adminBasePath() {
    const config = readConfig();
    const ap = (config.security && config.security.adminPath) ? String(config.security.adminPath).replace(/^\/+|\/+$/g, '') : '';
    return ap ? '/' + ap : '/admin';
}
const adminStatic = express.static(path.join(__dirname, 'public'));
app.use((req, res, next) => {
    const base = adminBasePath();
    if (req.path === base || (base !== '/' && req.path.startsWith(base + '/'))) {
        res.setHeader('X-Frame-Options', 'DENY');
        if (req.path === base || req.path === base + '/') {
            return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
        }
        req.url = req.url.slice(base.length) || '/';
        return adminStatic(req, res, next);
    }
    next();
});

// ==================== 敏感词库自动更新 ====================

async function refreshBannedWords() {
    const config = readConfig();
    const words = new Set(readData(BANNED_WORDS_FILE));

    // 1. GitHub Sensitive-lexicon (built-in)
    try {
        const GITHUB_REPO = 'https://github.com/konsheng/Sensitive-lexicon.git';
        const TEMP_DIR = path.join(__dirname, 'temp_lexicon_update');
        if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        await new Promise((resolve, reject) => {
            exec(`git clone --depth 1 "${GITHUB_REPO}" "${TEMP_DIR}"`, (error) => {
                if (error) return reject(error);
                try {
                    const VOCAB_DIR = path.join(TEMP_DIR, 'Vocabulary');
                    if (fs.existsSync(VOCAB_DIR)) {
                        const files = fs.readdirSync(VOCAB_DIR);
                        for (const file of files) {
                            if (!file.endsWith('.txt')) continue;
                            const content = fs.readFileSync(path.join(VOCAB_DIR, file), 'utf-8');
                            content.split('\n').forEach(line => { const w = line.trim(); if (w) words.add(w); });
                        }
                    }
                    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
                    resolve();
                } catch (err) { reject(err); }
            });
        });
        console.log('[敏感词库] 内置词库已更新');
    } catch (e) { console.error('[敏感词库] 内置词库拉取失败:', e.message); }

    // 2. Custom subscriptions
    const subs = (config.bannedWords && config.bannedWords.subscriptions) || [];
    for (const url of subs) {
        try {
            const resp = await fetch(url);
            const text = await resp.text();
            text.split(/\r?\n/).forEach(line => { const w = line.trim(); if (w && w.length < 50) words.add(w); });
            console.log('[敏感词库] 自定义订阅已拉取:', url);
        } catch (e) { console.error('[敏感词库] 自定义订阅拉取失败:', url, e.message); }
    }

    const wordList = Array.from(words).sort();
    await store.bannedReplaceAll(wordList);
    console.log(`[敏感词库] 更新完成，共 ${wordList.length} 个词`);
    return wordList.length;
}

const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;function scheduleUpdate() {
    setInterval(async () => {
        try {
            await refreshBannedWords();
        } catch (err) {
            console.error('[敏感词库] 定时更新失败:', err.message);
        }
    }, UPDATE_INTERVAL);
    console.log('[敏感词库] 已设置定时更新，每24小时自动更新一次');
}

/* 全局错误处理：屏蔽堆栈/路径泄露；透传客户端错误状态（如 body-parser 400）；
   高级设置开启调试模式时返回错误详情 */
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
        console.error('[error]', req.method, req.path, '-', err.message);
        const a = (readConfig().security || {}).advanced || {};
        if (a.debug) return res.status(500).json({ code: 1, msg: '服务器内部错误', detail: String(err.message).slice(0, 300) });
        return res.status(500).json({ code: 1, msg: '服务器内部错误' });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ code: 1, msg: '请求体格式错误（无效 JSON）' });
    res.status(status).json({ code: 1, msg: '请求错误' });
});

/* ==================== 存储初始化（可热切换，见数据库管理） ==================== */
async function initStore() {
    const config = readConfig();
    const dbCfg = config.db || {};
    const type = DB_TYPES.includes(dbCfg.type) ? dbCfg.type : 'json';
    store = await createStore(type, dbCfg);
    console.log(`[数据库] 当前存储: ${store.label} (${store.type})`);

    // 目标库为空且 JSON 有数据 → 自动迁移（老用户升级零操作）
    if (type !== 'json') {
        try {
            const tables = await store.tables();
            const danmuRows = (tables.find(t => t.name === 'danmu') || {}).count || 0;
            const kvRows = (tables.find(t => t.name === 'kv') || {}).count || 0;
            if (danmuRows === 0 && kvRows === 0) {
                const src = await createStore('json', {});
                const data = await collectAll(src);
                const summary = summarizeData(data);
                if (summary.danmu || summary.videos || summary.banned_words || summary.accounts || summary.banned || summary.whitelist || summary.login_logs || summary.login_fails || summary.api_stats || summary.ip_stats) {
                    console.log(`[数据库] 检测到 JSON 数据，自动迁移到 ${store.label} ...`);
                    await restoreAll(store, data);
                    console.log('[数据库] 自动迁移完成: ' + JSON.stringify(summary));
                }
            }
        } catch (e) {
            console.error('[数据库] 自动迁移失败（可稍后在管理后台手动切换）:', e.message);
        }
    }

    // 全新环境兜底：确保存在默认账号
    try {
        const accounts = await store.accountsAll();
        if (!Object.keys(accounts).length) {
            const salt = crypto.randomBytes(16).toString('hex');
            await store.accountsWrite({ admin: { salt, hash: hashPassword('admin123', salt), name: '管理员', created: Date.now() } });
            console.log('[认证] 已在 ' + store.label + ' 创建默认账号 admin / admin123（请立即修改密码）');
        }
    } catch (e) {
        console.error('[数据库] 默认账号检查失败:', e.message);
    }

    /* 插件系统初始化（加载已启用插件） */
    try {
        pluginManager = new PluginManager({ app, store, readConfig, log: (m) => console.log('[插件] ' + m) });
        pluginManager.loadState();
        await pluginManager.loadEnabled();
    } catch (e) {
        console.error('[插件] 初始化失败:', e.message);
    }
}

initStore().then(() => {
    app.listen(PORT, () => {
        const config = readConfig();
        console.log(`ArtPlayer服务已启动: http://localhost:${PORT}`);
        console.log(`播放器地址: http://localhost:${PORT}/player/?url=视频地址`);
        console.log(`管理后台: http://localhost:${PORT}/admin/`);
        console.log(`默认登录账号: admin / admin123`);
        if (config.pow && config.pow.enabled) console.log(`[防火墙] PoW 工作量证明已启用 (难度: ${config.pow.difficulty})`);
        if (config.rateLimit && config.rateLimit.enabled) console.log(`[防火墙] 速率限制已启用 (${config.rateLimit.max}次/${config.rateLimit.windowMs / 1000}s)`);
        console.log('[安全] Helmet 安全头已启用');
        scheduleUpdate();
    });
}).catch(e => {
    console.error('[数据库] 存储初始化失败，服务启动中止:', e.message);
    process.exit(1);
});
