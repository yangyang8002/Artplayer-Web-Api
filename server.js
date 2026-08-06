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

// 持久化到磁盘（60s 定时 + 退出时），重启不丢
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

app.use(securityMiddleware);
app.use(powMiddleware);

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
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
        skip: (req) => req.ipWhitelisted,
        handler: (req, res) => res.status(429).json({ code: 429, msg: '请求过于频繁,请稍后再试' })
    });
}

const DATA_DIR = path.join(__dirname, 'data');
const DANMU_FILE = path.join(DATA_DIR, 'danmu.json');
const BANNED_WORDS_FILE = path.join(DATA_DIR, 'banned_words.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const VIDEOS_FILE = path.join(DATA_DIR, 'videos.json');

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

function hashPassword(password, salt) {
    return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function initAccounts() {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
        const salt = crypto.randomBytes(16).toString('hex');
        const defaultAccount = {
            admin: { salt, hash: hashPassword('admin123', salt), name: '管理员', created: Date.now() }
        };
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(defaultAccount, null, 2));
        console.log('[认证] 已创建默认账号 admin / admin123');
    }
}

function readAccounts() {
    try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { return {}; }
}

function writeAccounts(accounts) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
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
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.body.token || req.headers['x-admin-token'];
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
    render: { maxPerSecond: 250, speedJitter: 10 },
    api: { apis: DEFAULT_API_RULES, retentionDays: 1 },
    bannedWords: { subscriptions: [] },
    security: { sessionMinutes: 120, adminPath: '', trustProxy: true, anomaly: { reqPerMin: 60, mbPerMin: 20, reqPerHour: 2000, mbPerHour: 1024 } },
    theme: 'bilibili',
    adminTheme: 'bilibili',
    cdn: { enabled: false, baseUrl: '' }
};

if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
}

function readConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const merged = { ...DEFAULT_CONFIG, ...raw };
        merged.security = { ...DEFAULT_CONFIG.security, ...(raw.security || {}) };
        return merged;
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

function writeConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/* 信任反向代理头（X-Forwarded-For 等），默认开启；
   关闭后 req.ip 直接取 socket 地址（直连部署） */
function applyTrustProxy(config) {
    const trust = !(config.security && config.security.trustProxy === false);
    app.set('trust proxy', trust ? 1 : false);
}
applyTrustProxy(readConfig());

function readData(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return [];
    }
}

function writeData(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function containsBannedWord(text) {
    const bannedWords = readData(BANNED_WORDS_FILE);
    const lowerText = text.toLowerCase();
    return bannedWords.some(word => lowerText.includes(word.toLowerCase()));
}

// ==================== 安全中心：IP 统计 / 归属地 / 封禁 / 白名单 / 异常检测 ====================

const SECURITY_FILE = path.join(DATA_DIR, 'security.json');
initDataFile(SECURITY_FILE, { banned: {}, whitelist: {} });

function readSecurity() {
    try {
        const d = JSON.parse(fs.readFileSync(SECURITY_FILE, 'utf8'));
        return {
            banned: (d && d.banned && typeof d.banned === 'object') ? d.banned : {},
            whitelist: (d && d.whitelist && typeof d.whitelist === 'object') ? d.whitelist : {}
        };
    } catch { return { banned: {}, whitelist: {} }; }
}
function writeSecurity(s) {
    fs.writeFileSync(SECURITY_FILE, JSON.stringify(s, null, 2));
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
function securityMiddleware(req, res, next) {
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    req.clientIp = ip;
    const sec = readSecurity();
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
    const sec = readSecurity();
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

app.get('/api/danmu/v3/', (req, res) => {
    const id = req.query.id;
    console.log(`[弹幕API] GET 请求(query) - 视频ID: ${id}`);
    
    let danmuList = readData(DANMU_FILE);
    console.log(`[弹幕API] 数据库中共有 ${danmuList.length} 条弹幕`);
    
    if (id) {
        danmuList = danmuList.filter(d => d.vid === id);
        console.log(`[弹幕API] 过滤后剩余 ${danmuList.length} 条弹幕`);
    }
    
    const bannedWords = readData(BANNED_WORDS_FILE);
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

app.get('/api/danmu/v3/:id', (req, res) => {
    const id = req.params.id;
    console.log(`[弹幕API] GET 请求(path) - 视频ID: ${id}`);
    
    let danmuList = readData(DANMU_FILE);
    
    if (id) {
        danmuList = danmuList.filter(d => d.vid === id);
    }
    
    const bannedWords = readData(BANNED_WORDS_FILE);
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

app.get('/api/danmu/', (req, res) => {
    const id = req.query.id;
    console.log(`[弹幕API] GET 请求(query) - 视频ID: ${id}`);
    
    let danmuList = readData(DANMU_FILE);
    console.log(`[弹幕API] 数据库中共有 ${danmuList.length} 条弹幕`);
    
    if (id) {
        danmuList = danmuList.filter(d => d.vid === id);
        console.log(`[弹幕API] 过滤后剩余 ${danmuList.length} 条弹幕`);
    }
    
    const bannedWords = readData(BANNED_WORDS_FILE);
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

app.post('/api/danmu/', (req, res) => {
    const { id, player, text, color, type, time, author } = req.body;
    const vid = id || player;
    console.log(`[弹幕API] POST 请求 - 视频ID: ${vid}, 内容: ${text}`);

    if (!vid || !text) {
        console.log(`[弹幕API] 参数不完整 - id/player: ${vid}, text: ${text}`);
        return res.status(400).json({ code: 1, msg: '参数不完整' });
    }

    if (!checkDanmakuLimit(req, res)) return;

    if (containsBannedWord(text)) {
        console.log(`[弹幕API] 弹幕包含屏蔽词: ${text}`);
        return res.status(403).json({ code: 2, msg: '弹幕包含屏蔽词' });
    }

    const danmuList = readData(DANMU_FILE);

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
        author: author || 'anonymous',
        date: new Date().toISOString()
    };

    danmuList.push(newDanmu);
    writeData(DANMU_FILE, danmuList);

    console.log(`[弹幕API] 弹幕保存成功: ${text}`);
    res.json({ code: 0, data: newDanmu });
});

app.post('/api/danmu/v3/', (req, res) => {
    const { id, player, text, color, type, time, author } = req.body;
    const vid = id || player;
    console.log(`[弹幕API] POST 请求 - 视频ID: ${vid}, 内容: ${text}`);

    if (!vid || !text) {
        console.log(`[弹幕API] 参数不完整 - id/player: ${vid}, text: ${text}`);
        return res.status(400).json({ code: 1, msg: '参数不完整' });
    }

    if (!checkDanmakuLimit(req, res)) return;

    if (containsBannedWord(text)) {
        console.log(`[弹幕API] 弹幕包含屏蔽词: ${text}`);
        return res.status(403).json({ code: 2, msg: '弹幕包含屏蔽词' });
    }

    const danmuList = readData(DANMU_FILE);

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
        author: author || 'anonymous',
        date: new Date().toISOString()
    };

    danmuList.push(newDanmu);
    writeData(DANMU_FILE, danmuList);

    console.log(`[弹幕API] 弹幕保存成功: ${text}`);
    res.json({ code: 0, data: newDanmu });
});

// ==================== 视频映射 ====================

initDataFile(VIDEOS_FILE, {});

function readVideoMap() {
    const data = readData(VIDEOS_FILE);
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
}
function writeVideoMap(videos) {
    writeData(VIDEOS_FILE, videos);
}

app.post('/api/video/map', (req, res) => {
    const { vid, url } = req.body;
    if (!vid || !url) return res.status(400).json({ code: 1, msg: '参数不完整' });
    const videos = readVideoMap();
    videos[vid] = url;
    writeVideoMap(videos);
    res.json({ code: 0, msg: '已记录' });
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
function hasDanmuForVid(vid) {
    try { return new RegExp('"vid"\\s*:\\s*"' + vid + '"').test(fs.readFileSync(DANMU_FILE, 'utf8')); } catch { return false; }
}
function genVideoId() {
    const videos = readVideoMap();
    const used = new Set(Object.keys(videos));
    try { readData(DANMU_FILE).forEach(d => used.add(d.vid)); } catch {}
    for (let i = 0; i < 200; i++) {
        let s = '';
        for (let j = 0; j < 8; j++) s += VID_CHARS[Math.floor(Math.random() * VID_CHARS.length)];
        if (!used.has(s)) return s;
    }
    return 'v' + Date.now().toString(36);
}
app.get('/api/video/resolve', (req, res) => {
    const url = (req.query.url || '').trim();
    if (!url) return res.status(400).json({ code: 1, msg: '缺少 url 参数' });
    const videos = readVideoMap();
    let existing = null;
    for (const [vid, u] of Object.entries(videos)) {
        if (u === url) { existing = vid; break; }
    }
    if (existing) return res.json({ code: 0, data: { vid: existing, source: 'map' } });
    // 旧散列算法兼容：该 URL 已有历史弹幕 → 继承旧 ID，弹幕不丢
    const legacyId = legacyVideoId(url);
    if (hasDanmuForVid(legacyId)) {
        videos[legacyId] = url;
        writeVideoMap(videos);
        return res.json({ code: 0, data: { vid: legacyId, source: 'legacy' } });
    }
    const vid = genVideoId();
    videos[vid] = url;
    writeVideoMap(videos);
    res.json({ code: 0, data: { vid, source: 'new' } });
});

app.get('/api/admin/videos', checkAdmin, (req, res) => {
    const videos = readVideoMap();
    const list = Object.entries(videos).map(([vid, url]) => ({ vid, url }));
    res.json({ code: 0, data: list });
});

app.post('/api/admin/videos', checkAdmin, (req, res) => {
    const { vid, url } = req.body;
    if (!vid || !url) return res.status(400).json({ code: 1, msg: '参数不完整' });
    const videos = readVideoMap();
    videos[vid] = url;
    writeVideoMap(videos);
    res.json({ code: 0, msg: '已保存', data: { vid, url } });
});

app.post('/api/admin/videos/delete', checkAdmin, (req, res) => {
    const { vid } = req.body;
    const videos = readVideoMap();
    if (!videos[vid]) return res.status(404).json({ code: 1, msg: '不存在' });
    delete videos[vid];
    writeVideoMap(videos);
    res.json({ code: 0, msg: '已删除' });
});

// ==================== 管理员API ====================

const loginLimiter = rateLimit({
    windowMs: 60000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ code: 429, msg: '登录尝试过于频繁，请1分钟后再试' })
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ code: 1, msg: '请输入账号和密码' });
    }
    const accounts = readAccounts();
    const account = accounts[username];
    if (!account) {
        return res.status(401).json({ code: 2, msg: '账号或密码错误' });
    }
    const hash = hashPassword(password, account.salt);
    if (hash !== account.hash) {
        return res.status(401).json({ code: 2, msg: '账号或密码错误' });
    }
    const token = generateToken(username);
    res.json({ code: 0, msg: '登录成功', data: { token, username, name: account.name || username } });
});

app.post('/api/admin/change-password', checkAdmin, (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ code: 1, msg: '参数不完整' });
    if (newPassword.length < 4) return res.status(400).json({ code: 2, msg: '新密码至少4位' });
    const accounts = readAccounts();
    const account = accounts[req.adminUser];
    if (hashPassword(oldPassword, account.salt) !== account.hash) {
        return res.status(403).json({ code: 3, msg: '原密码错误' });
    }
    const newSalt = crypto.randomBytes(16).toString('hex');
    account.salt = newSalt;
    account.hash = hashPassword(newPassword, newSalt);
    accounts[req.adminUser] = account;
    writeAccounts(accounts);
    res.json({ code: 0, msg: '密码已更新，请重新登录' });
});

app.post('/api/admin/change-username', checkAdmin, (req, res) => {
    const { password, newUsername } = req.body;
    if (!password || !newUsername) return res.status(400).json({ code: 1, msg: '参数不完整' });
    if (newUsername.length < 2) return res.status(400).json({ code: 2, msg: '用户名至少2位' });
    if (!/^[a-zA-Z0-9_]+$/.test(newUsername)) return res.status(400).json({ code: 3, msg: '用户名只能包含字母数字和下划线' });
    const accounts = readAccounts();
    if (accounts[newUsername]) return res.status(400).json({ code: 4, msg: '该用户名已存在' });
    const account = accounts[req.adminUser];
    if (hashPassword(password, account.salt) !== account.hash) {
        return res.status(403).json({ code: 5, msg: '密码错误' });
    }
    accounts[newUsername] = account;
    delete accounts[req.adminUser];
    writeAccounts(accounts);
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
        if (size > 200 * 1024) return res.json({ code: 0, data: { type: 'file', name: path.basename(target), size, tooLarge: true } });
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

// 上传（multer）
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 * 200 }
});
app.post('/api/admin/files/upload', checkAdmin, upload.array('files'), (req, res) => {
    const dir = safeResolve(req.body.dir || '');
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(400).json({ code: 1, msg: '目标目录无效' });
    if (!req.files || !req.files.length) return res.status(400).json({ code: 1, msg: '未选择文件' });
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
    const { pow, rateLimit: rl, danmakuLimit: dl, render, bannedWords, api, security: sec, theme, adminTheme, cdn } = req.body;
    if (pow) config.pow = { ...config.pow, ...pow };
    if (rl) config.rateLimit = { ...config.rateLimit, ...rl };
    if (dl) config.danmakuLimit = { ...config.danmakuLimit, ...dl };
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
    res.json({ code: 0, data: { cdn: config.cdn, theme: config.theme || 'bilibili', render: config.render } });
});

app.get('/api/admin/banned-words', checkAdmin, (req, res) => {
    let words = readData(BANNED_WORDS_FILE);
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

app.post('/api/admin/banned-words', checkAdmin, (req, res) => {
    const { word } = req.body;
    if (!word || !word.trim()) {
        return res.status(400).json({ code: 1, msg: '关键词不能为空' });
    }
    
    const words = readData(BANNED_WORDS_FILE);
    const newWord = word.trim().toLowerCase();
    
    if (words.map(w => w.toLowerCase()).includes(newWord)) {
        return res.status(400).json({ code: 2, msg: '该关键词已存在' });
    }
    
    words.push(word.trim());
    writeData(BANNED_WORDS_FILE, words);
    res.json({ code: 0, msg: '添加成功', data: words });
});

app.delete('/api/admin/banned-words', checkAdmin, (req, res) => {
    const { word } = req.body;
    let words = readData(BANNED_WORDS_FILE);
    const index = words.map(w => w.toLowerCase()).indexOf(word.toLowerCase());
    
    if (index === -1) {
        return res.status(404).json({ code: 1, msg: '关键词不存在' });
    }
    
    words.splice(index, 1);
    writeData(BANNED_WORDS_FILE, words);
    res.json({ code: 0, msg: '删除成功', data: words });
});

app.get('/api/admin/danmu', checkAdmin, (req, res) => {
    let danmuList = readData(DANMU_FILE);
    const vid = req.query.vid || '';
    const search = (req.query.search || '').toLowerCase();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    if (vid) danmuList = danmuList.filter(d => d.vid === vid);
    if (search) danmuList = danmuList.filter(d => d.text.toLowerCase().includes(search));
    danmuList.sort((a,b)=> new Date(b.date) - new Date(a.date));
    const total = danmuList.length;
    const start = (page - 1) * limit;
    const paged = danmuList.slice(start, start + limit);
    res.json({ code: 0, data: { list: paged, total, page, limit } });
});

app.get('/api/admin/danmu/vids', checkAdmin, (req, res) => {
    const danmuList = readData(DANMU_FILE);
    const map = {};
    for (const d of danmuList) {
        if (!map[d.vid]) map[d.vid] = { vid: d.vid, count: 0 };
        map[d.vid].count++;
    }
    const vids = Object.values(map).sort((a, b) => b.count - a.count);
    res.json({ code: 0, data: vids });
});

app.delete('/api/admin/danmu', checkAdmin, (req, res) => {
    const { id } = req.body;
    let danmuList = readData(DANMU_FILE);
    const index = danmuList.findIndex(d => d.id === id);
    
    if (index === -1) {
        return res.status(404).json({ code: 1, msg: '弹幕不存在' });
    }
    
    danmuList.splice(index, 1);
    writeData(DANMU_FILE, danmuList);
    res.json({ code: 0, msg: '删除成功' });
});

// ==================== 安全中心 API ====================

function isValidIp(ip) {
    return typeof ip === 'string' && /^[\d.]+$/.test(ip) && ip.split('.').length === 4;
}

app.get('/api/admin/security/overview', checkAdmin, async (req, res) => {
    const sec = readSecurity();
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
    const sec = readSecurity();
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

app.get('/api/admin/security/lists', checkAdmin, (req, res) => {
    const sec = readSecurity();
    res.json({
        code: 0,
        data: {
            banned: Object.entries(sec.banned).map(([ip, v]) => ({ ip, reason: (v && v.reason) || '', at: (v && v.at) || 0 })),
            whitelist: Object.entries(sec.whitelist).map(([ip, v]) => ({ ip, at: (v && v.at) || 0 }))
        }
    });
});

app.post('/api/admin/security/ban', checkAdmin, (req, res) => {
    const { ip, reason } = req.body;
    if (!isValidIp(ip)) return res.status(400).json({ code: 1, msg: '无效 IP' });
    const sec = readSecurity();
    sec.banned[ip] = { reason: String(reason || '').slice(0, 200), at: Date.now() };
    delete sec.whitelist[ip];
    writeSecurity(sec);
    res.json({ code: 0, msg: '已封禁 ' + ip });
});

app.post('/api/admin/security/unban', checkAdmin, (req, res) => {
    const { ip } = req.body;
    if (!isValidIp(ip)) return res.status(400).json({ code: 1, msg: '无效 IP' });
    const sec = readSecurity();
    delete sec.banned[ip];
    writeSecurity(sec);
    res.json({ code: 0, msg: '已解除封禁 ' + ip });
});

app.post('/api/admin/security/whitelist', checkAdmin, (req, res) => {
    const { ip } = req.body;
    if (!isValidIp(ip)) return res.status(400).json({ code: 1, msg: '无效 IP' });
    const sec = readSecurity();
    if (!sec.whitelist[ip]) sec.whitelist[ip] = { at: Date.now() };
    delete sec.banned[ip];
    writeSecurity(sec);
    res.json({ code: 0, msg: '已加入白名单 ' + ip });
});

app.post('/api/admin/security/unwhitelist', checkAdmin, (req, res) => {
    const { ip } = req.body;
    if (!isValidIp(ip)) return res.status(400).json({ code: 1, msg: '无效 IP' });
    const sec = readSecurity();
    delete sec.whitelist[ip];
    writeSecurity(sec);
    res.json({ code: 0, msg: '已移出白名单 ' + ip });
});

app.post('/api/admin/security/config', checkAdmin, (req, res) => {
    const { reqPerMin, mbPerMin, reqPerHour, mbPerHour } = req.body;
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
    writeConfig(config);
    res.json({ code: 0, msg: '阈值已保存' });
});

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

app.get('/api/subtitle/detect', (req, res) => {
    const url = decodeURIComponent(req.query.url || '');
    if (!url) return res.json({ code: 1, msg: '缺少 url 参数' });
    if (/^https?:\/\//i.test(url)) return res.json({ code: 0, data: { subtitles: [] } });

    const clean = url.split('?')[0].split('#')[0].replace(/^\//, '');
    const dir = path.dirname(clean);
    const base = path.basename(clean, path.extname(clean));
    const subExts = ['.srt', '.vtt', '.ass', '.ssa', '.webvtt'];
    const searchDir = path.join(__dirname, 'public', dir);

    if (!fs.existsSync(searchDir)) return res.json({ code: 0, data: { subtitles: [] } });

    const langMap = {
        'sc':'简体中文','chs':'简体中文','zh-cn':'简体中文','zh-hans':'简体中文',
        'tc':'繁體中文','cht':'繁體中文','zh-tw':'繁體中文','zh-hk':'繁體中文','zh-hant':'繁體中文',
        'en':'English','eng':'English',
        'ja':'日本語','jpn':'日本語',
        'ko':'한국어','kor':'한국어',
        'fr':'Français','fre':'Français',
        'de':'Deutsch','ger':'Deutsch',
        'es':'Español','spa':'Español',
        'pt':'Português','por':'Português','pt-br':'Português (BR)',
        'it':'Italiano','ita':'Italiano',
        'ru':'Русский','rus':'Русский',
        'ar':'العربية','ara':'العربية',
        'th':'ไทย','tha':'ไทย',
        'vi':'Tiếng Việt','vie':'Tiếng Việt',
        'hi':'हिन्दी','hin':'हिन्दी',
        'id':'Bahasa Indonesia','ind':'Bahasa Indonesia',
    };
    function getLang(suffix) {
        const s = suffix.toLowerCase();
        return langMap[s] || (s.length <= 4 ? s.toUpperCase() : s);
    }

    const files = fs.readdirSync(searchDir);
    const subtitles = [];

    for (const f of files) {
        const fullExt = path.extname(f).toLowerCase();
        if (!subExts.includes(fullExt)) continue;

        const nameNoExt = f.slice(0, -fullExt.length);
        // exact match (same base): video.srt
        if (nameNoExt === base) {
            const subPath = '/' + path.join(dir, f).replace(/\\/g, '/');
            subtitles.push({ title: '默认', lang: '', url: subPath });
            continue;
        }
        // language suffix: basename.lang.srt
        if (nameNoExt.startsWith(base + '.')) {
            const langPart = nameNoExt.slice(base.length + 1);
            const subPath = '/' + path.join(dir, f).replace(/\\/g, '/');
            subtitles.push({ title: getLang(langPart), lang: langPart, url: subPath });
        }
    }

    // Sort: default first, then by lang
    subtitles.sort((a, b) => {
        if (a.title === '默认') return -1;
        if (b.title === '默认') return 1;
        return a.title.localeCompare(b.title, 'zh');
    });

    res.json({ code: 0, data: { subtitles } });
});

// 接受外部字幕 url
app.post('/api/subtitle/external', (req, res) => {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.json({ code: 1, msg: '无效链接' });
    res.json({ code: 0, data: { url } });
});

// ==================== 页面路由 ====================

// 主题 API
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
    fs.writeFileSync(BANNED_WORDS_FILE, JSON.stringify(wordList, null, 2));
    console.log(`[敏感词库] 更新完成，共 ${wordList.length} 个词`);
    return wordList.length;
}

const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;

function scheduleUpdate() {
    setInterval(async () => {
        try {
            await refreshBannedWords();
        } catch (err) {
            console.error('[敏感词库] 定时更新失败:', err.message);
        }
    }, UPDATE_INTERVAL);
    console.log('[敏感词库] 已设置定时更新，每24小时自动更新一次');
}

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
