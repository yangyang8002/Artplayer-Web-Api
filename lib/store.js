'use strict';
/* ==========================================================================
 * 统一存储层：JSON 文件（默认，零依赖） / SQLite / MySQL / MariaDB / PostgreSQL / MongoDB
 * 所有数据读写必须经过 Store，后端可热切换（切换时自动迁移全部数据）。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.OPENVIDEO_DATA_DIR ? path.resolve(process.env.OPENVIDEO_DATA_DIR) : path.join(__dirname, '..', 'data');
const DANMU_FILE = path.join(DATA_DIR, 'danmu.json');
const BANNED_WORDS_FILE = path.join(DATA_DIR, 'banned_words.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const VIDEOS_FILE = path.join(DATA_DIR, 'videos.json');
const SECURITY_FILE = path.join(DATA_DIR, 'security.json');
const LOGIN_LOG_FILE = path.join(DATA_DIR, 'login-logs.json');
const LOGIN_FAIL_FILE = path.join(DATA_DIR, 'login-fails.json');
const API_STATS_FILE = path.join(DATA_DIR, 'api-stats.json');
const IP_STATS_FILE = path.join(DATA_DIR, 'ip-stats.json');
const SUBTITLES_FILE = path.join(DATA_DIR, 'subtitles.json');
const VIDEO_SUBS_FILE = path.join(DATA_DIR, 'video_subs.json');
const PLUGIN_TABLES_FILE = path.join(DATA_DIR, 'plugin_tables.json');

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

/* ==================== JSON 后端（默认） ==================== */
class JsonBackend {
    constructor() { this.type = 'json'; this.label = 'JSON 文件'; }
    async init() { }
    async close() { }

    async danmuAll() { return readJson(DANMU_FILE, []); }
    async danmuPage({ page = 1, limit = 50, vid = '', search = '' } = {}) {
        let list = readJson(DANMU_FILE, []);
        if (vid) list = list.filter(d => d.vid === vid);
        if (search) list = list.filter(d => String(d.text || '').toLowerCase().includes(String(search).toLowerCase()));
        list.sort((a, b) => new Date(b.date) - new Date(a.date));
        const total = list.length;
        const start = (page - 1) * limit;
        return { list: list.slice(start, start + limit), total };
    }
    async danmuBulkInsert(items) {
        if (!items.length) return;
        const list = readJson(DANMU_FILE, []);
        list.push(...items);
        writeJson(DANMU_FILE, list);
    }
    async danmuAdd(item) {
        const list = readJson(DANMU_FILE, []);
        list.push(item);
        writeJson(DANMU_FILE, list);
    }
    async danmuDelete(id) {
        const list = readJson(DANMU_FILE, []);
        const idx = list.findIndex(d => d.id === id);
        if (idx === -1) return false;
        list.splice(idx, 1);
        writeJson(DANMU_FILE, list);
        return true;
    }
    async danmuClear() { writeJson(DANMU_FILE, []); }
    async danmuHasVid(vid) { return readJson(DANMU_FILE, []).some(d => d.vid === vid); }
    async danmuVids() {
        const map = {};
        for (const d of readJson(DANMU_FILE, [])) map[d.vid] = (map[d.vid] || 0) + 1;
        return Object.entries(map).map(([vid, count]) => ({ vid, count })).sort((a, b) => b.count - a.count);
    }
    async danmuAllVids() {
        const set = new Set();
        for (const d of readJson(DANMU_FILE, [])) set.add(d.vid);
        return Array.from(set);
    }

    async videosAll() {
        const d = readJson(VIDEOS_FILE, {});
        return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
    }
    async videoSet(vid, url) {
        const v = await this.videosAll();
        v[vid] = url;
        /* 写放大防护：JSON 后端映射表体积上限（20MB） */
        try { if (fs.statSync(VIDEOS_FILE).size > 20 * 1024 * 1024) { const e = new Error('videos.json 体积超限'); e.code = 507; throw e; } } catch (e) { if (e.code === 507) throw e; }
        writeJson(VIDEOS_FILE, v);
    }
    async videoDelete(vid) {
        const v = await this.videosAll();
        if (!(vid in v)) return false;
        delete v[vid];
        writeJson(VIDEOS_FILE, v);
        return true;
    }
    async videoClear() { writeJson(VIDEOS_FILE, {}); }
    async videoByUrl(url) {
        for (const [vid, u] of Object.entries(await this.videosAll())) if (u === url) return vid;
        return null;
    }

    async bannedAll() { return readJson(BANNED_WORDS_FILE, []); }
    async bannedAdd(word) {
        const words = await this.bannedAll();
        if (words.map(w => w.toLowerCase()).includes(word.toLowerCase())) return false;
        words.push(word);
        writeJson(BANNED_WORDS_FILE, words);
        return true;
    }
    async bannedDelete(word) {
        const words = await this.bannedAll();
        const idx = words.map(w => w.toLowerCase()).indexOf(word.toLowerCase());
        if (idx === -1) return false;
        words.splice(idx, 1);
        writeJson(BANNED_WORDS_FILE, words);
        return true;
    }
    async bannedReplaceAll(list) { writeJson(BANNED_WORDS_FILE, list); }

    async accountsAll() { return readJson(ACCOUNTS_FILE, {}); }
    async accountsWrite(obj) { writeJson(ACCOUNTS_FILE, obj); }

    async securityGet() {
        const d = readJson(SECURITY_FILE, {});
        return {
            banned: (d && d.banned && typeof d.banned === 'object') ? d.banned : {},
            whitelist: (d && d.whitelist && typeof d.whitelist === 'object') ? d.whitelist : {}
        };
    }
    async securityWrite(s) { writeJson(SECURITY_FILE, s); }

    async loginLogs() { const d = readJson(LOGIN_LOG_FILE, []); return Array.isArray(d) ? d : []; }
    async loginLogsWrite(list) { writeJson(LOGIN_LOG_FILE, list); }
    async loginFails() {
        const d = readJson(LOGIN_FAIL_FILE, {});
        return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
    }
    async loginFailsWrite(obj) { writeJson(LOGIN_FAIL_FILE, obj); }

    async kvGet(key) {
        if (key === 'api_stats') return readJson(API_STATS_FILE, null);
        if (key === 'ip_stats') return readJson(IP_STATS_FILE, null);
        return null;
    }
    async kvSet(key, value) {
        if (key === 'api_stats') writeJson(API_STATS_FILE, value);
        else if (key === 'ip_stats') writeJson(IP_STATS_FILE, value);
    }

    /* ---- 字幕库 ---- */
    async subtitleAll() { return readJson(SUBTITLES_FILE, []); }
    async subtitleAdd(item) {
        const list = await this.subtitleAll();
        list.push(item);
        writeJson(SUBTITLES_FILE, list);
    }
    async subtitleUpdate(id, patch) {
        const list = await this.subtitleAll();
        const idx = list.findIndex(s => s.id === id);
        if (idx === -1) return false;
        list[idx] = { ...list[idx], ...patch };
        writeJson(SUBTITLES_FILE, list);
        return true;
    }
    async subtitleDelete(id) {
        const list = await this.subtitleAll();
        const idx = list.findIndex(s => s.id === id);
        if (idx === -1) return false;
        list.splice(idx, 1);
        writeJson(SUBTITLES_FILE, list);
        return true;
    }
    async subtitleBulkInsert(items) {
        if (!items.length) return;
        const list = await this.subtitleAll();
        list.push(...items);
        writeJson(SUBTITLES_FILE, list);
    }
    async subtitleClear() { writeJson(SUBTITLES_FILE, []); }

    /* ---- 视频字幕映射（vid -> [subtitleId]） ---- */
    async videoSubsAll() { return readJson(VIDEO_SUBS_FILE, {}); }
    async videoSubsWrite(obj) { writeJson(VIDEO_SUBS_FILE, obj); }

    /* ---- 插件动态表（全部插件表数据集中存于一个 JSON 键，随存储迁移） ---- */
    async pluginTableGet() {
        const d = readJson(PLUGIN_TABLES_FILE, {});
        return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
    }
    async pluginTableSet(data) { writeJson(PLUGIN_TABLES_FILE, data); }

    async tables() {
        const t = async (name, n) => ({ name, count: n });
        return [
            await t('danmu', (await this.danmuAll()).length),
            await t('videos', Object.keys(await this.videosAll()).length),
            await t('banned_words', (await this.bannedAll()).length),
            await t('accounts', Object.keys(await this.accountsAll()).length),
            await t('security', (await this.securityGet()).banned ? 1 : 0),
            await t('login_logs', (await this.loginLogs()).length),
            await t('login_fails', Object.keys(await this.loginFails()).length),
            await t('subtitles', (await this.subtitleAll()).length),
            await t('kv', (await this.kvGet('api_stats')) ? 1 : 0)
        ];
    }

    async browse(table, { page = 1, limit = 50, search = '' } = {}) {
        const lower = String(search || '').toLowerCase();
        const filter = (rows, key) => search ? rows.filter(r => String(r[key] || '').toLowerCase().includes(lower)) : rows;
        let rows = [], key = '';
        switch (table) {
            case 'danmu': rows = await this.danmuAll(); key = 'text'; break;
            case 'videos': rows = Object.entries(await this.videosAll()).map(([vid, url]) => ({ vid, url })); key = 'vid'; break;
            case 'banned_words': rows = (await this.bannedAll()).map(w => ({ word: w })); key = 'word'; break;
            case 'accounts': rows = Object.entries(await this.accountsAll()).map(([u, a]) => ({ username: u, salt: a.salt, hash: a.hash, name: a.name, created: a.created })); key = 'username'; break;
            case 'security': {
                const s = await this.securityGet();
                rows = [
                    ...Object.entries(s.banned).map(([ip, v]) => ({ ip, list: 'banned', reason: (v && v.reason) || '', at: (v && v.at) || 0 })),
                    ...Object.entries(s.whitelist).map(([ip, v]) => ({ ip, list: 'whitelist', reason: '', at: (v && v.at) || 0 }))
                ];
                key = 'ip'; break;
            }
            case 'login_logs': rows = await this.loginLogs(); key = 'ip'; break;
            case 'login_fails': rows = Object.entries(await this.loginFails()).map(([ip, v]) => ({ ip, ...v })); key = 'ip'; break;
            case 'subtitles': rows = await this.subtitleAll(); key = 'name'; break;
            case 'kv': {
                rows = [];
                for (const k of ['api_stats', 'ip_stats']) {
                    const v = await this.kvGet(k);
                    if (v) rows.push({ key: k, value: JSON.stringify(v).slice(0, 200) });
                }
                key = 'key'; break;
            }
            default: return { list: [], total: 0 };
        }
        rows = filter(rows, key);
        const total = rows.length;
        const start = (page - 1) * limit;
        return { list: rows.slice(start, start + limit), total };
    }
}

/* ==================== 通用 SQL 后端基类 ==================== */
class SqlBackend {
    constructor(type, label, cfg) { this.type = type; this.label = label; this.cfg = cfg || {}; }

    /* 子类必须实现：connect() / close() / q(sql, params) / table DDL */
    async init() { throw new Error('not implemented'); }
    async close() { }
    async _q(sql, params) { throw new Error('not implemented'); }
    async _tx(fn) { return fn(); }

    ddl() { throw new Error('not implemented'); }

    async createTables() {
        for (const sql of this.ddl()) await this._q(sql);
    }

    async danmuAll() {
        return this._q('SELECT id, vid, text, color, type, time, author, date FROM danmu');
    }
    async danmuPage({ page = 1, limit = 50, vid = '', search = '' } = {}) {
        let where = '1=1', params = [];
        if (vid) { where += ' AND vid = ?'; params.push(vid); }
        if (search) { where += ' AND ' + this._like('text') + ' ?'; params.push('%' + search + '%'); }
        const total = (await this._q('SELECT COUNT(*) AS n FROM danmu WHERE ' + where, params))[0].n;
        const start = (page - 1) * limit;
        params.push(limit, start);
        const list = await this._q('SELECT id, vid, text, color, type, time, author, date FROM danmu WHERE ' + where + ' ORDER BY date DESC LIMIT ? OFFSET ?', params);
        return { list, total };
    }
    async danmuBulkInsert(items) {
        if (!items.length) return;
        const chunk = 400;
        for (let i = 0; i < items.length; i += chunk) {
            await this._insertMany('danmu', ['id', 'vid', 'text', 'color', 'type', 'time', 'author', 'date'], items.slice(i, i + chunk));
        }
    }
    async danmuAdd(item) {
        await this._insertMany('danmu', ['id', 'vid', 'text', 'color', 'type', 'time', 'author', 'date'], [item]);
    }
    async danmuDelete(id) {
        const r = await this._q('DELETE FROM danmu WHERE id = ?', [id]);
        return this._affected(r) > 0;
    }
    async danmuClear() { await this._q('DELETE FROM danmu'); }
    async danmuHasVid(vid) {
        const r = await this._q('SELECT 1 AS x FROM danmu WHERE vid = ? LIMIT 1', [vid]);
        return r.length > 0;
    }
    async danmuVids() {
        const rows = await this._q('SELECT vid, COUNT(*) AS count FROM danmu GROUP BY vid ORDER BY count DESC');
        return rows.map(r => ({ vid: r.vid, count: r.count }));
    }
    async danmuAllVids() {
        const rows = await this._q('SELECT DISTINCT vid FROM danmu');
        return rows.map(r => r.vid);
    }

    async videosAll() {
        const rows = await this._q('SELECT vid, url FROM videos');
        const out = {};
        for (const r of rows) out[r.vid] = r.url;
        return out;
    }
    async videoSet(vid, url) {
        await this._tx(async () => {
            await this._q('DELETE FROM videos WHERE vid = ?', [vid]);
            await this._q('INSERT INTO videos (vid, url) VALUES (?, ?)', [vid, url]);
        });
    }
    async videoDelete(vid) {
        const r = await this._q('DELETE FROM videos WHERE vid = ?', [vid]);
        return this._affected(r) > 0;
    }
    async videoClear() { await this._q('DELETE FROM videos'); }
    async videoByUrl(url) {
        const rows = await this._q('SELECT vid FROM videos WHERE url = ? LIMIT 1', [url]);
        return rows.length ? rows[0].vid : null;
    }

    async bannedAll() {
        const rows = await this._q('SELECT word FROM banned_words');
        return rows.map(r => r.word);
    }
    async bannedAdd(word) {
        const r = await this._q('SELECT 1 AS x FROM banned_words WHERE word = ?', [word]);
        if (r.length) return false;
        await this._q('INSERT INTO banned_words (word) VALUES (?)', [word]);
        return true;
    }
    async bannedDelete(word) {
        const r = await this._q('DELETE FROM banned_words WHERE word = ?', [word]);
        return this._affected(r) > 0;
    }
    async bannedReplaceAll(list) {
        await this._tx(async () => {
            await this._q('DELETE FROM banned_words');
            for (const w of list) await this._q('INSERT INTO banned_words (word) VALUES (?)', [w]);
        });
    }

    async accountsAll() {
        const rows = await this._q('SELECT username, salt, hash, name, created FROM accounts');
        const out = {};
        for (const r of rows) out[r.username] = { salt: r.salt, hash: r.hash, name: r.name, created: r.created };
        return out;
    }
    async accountsWrite(obj) {
        await this._tx(async () => {
            await this._q('DELETE FROM accounts');
            for (const [username, a] of Object.entries(obj || {})) {
                await this._q('INSERT INTO accounts (username, salt, hash, name, created) VALUES (?, ?, ?, ?, ?)',
                    [username, a.salt, a.hash, a.name, a.created]);
            }
        });
    }

    async securityGet() {
        const rows = await this._q('SELECT key, value FROM kv WHERE key = ?', ['security']);
        if (rows.length) {
            try {
                const d = JSON.parse(rows[0].value);
                if (d && d.banned && d.whitelist) return d;
            } catch (e) { /* 损坏则回退 */ }
        }
        return { banned: {}, whitelist: {} };
    }
    async securityWrite(s) {
        await this.kvSet('security', s);
    }

    async loginLogs() {
        const rows = await this._q('SELECT ip, u, ok, t, r FROM login_logs ORDER BY t ASC');
        return rows.map(r => ({ ip: r.ip, u: r.u, ok: !!r.ok, t: r.t, r: r.r }));
    }
    async loginLogsWrite(list) {
        await this._tx(async () => {
            await this._q('DELETE FROM login_logs');
            for (const x of list) {
                await this._q('INSERT INTO login_logs (ip, u, ok, t, r) VALUES (?, ?, ?, ?, ?)',
                    [x.ip, x.u, x.ok ? 1 : 0, x.t, x.r]);
            }
        });
    }
    async loginFails() {
        const rows = await this._q('SELECT ip, count, firstAt, lockedUntil FROM login_fails');
        const out = {};
        for (const r of rows) out[r.ip] = { count: r.count, firstAt: r.firstAt, lockedUntil: r.lockedUntil };
        return out;
    }
    async loginFailsWrite(obj) {
        await this._tx(async () => {
            await this._q('DELETE FROM login_fails');
            for (const [ip, v] of Object.entries(obj || {})) {
                await this._q('INSERT INTO login_fails (ip, count, firstAt, lockedUntil) VALUES (?, ?, ?, ?)',
                    [ip, v.count, v.firstAt, v.lockedUntil]);
            }
        });
    }

    async kvGet(key) {
        const rows = await this._q('SELECT value FROM kv WHERE key = ?', [key]);
        if (!rows.length) return null;
        try { return JSON.parse(rows[0].value); } catch { return null; }
    }
    async kvSet(key, value) {
        await this._tx(async () => {
            await this._q('DELETE FROM kv WHERE key = ?', [key]);
            await this._q('INSERT INTO kv (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
        });
    }

    /* ---- 字幕库 ---- */
    async subtitleAll() {
        return this._q('SELECT id, name, lang, langName, type, url, content, file, localized, createdAt FROM subtitles');
    }
    async subtitleAdd(item) {
        await this._insertMany('subtitles', ['id', 'name', 'lang', 'langName', 'type', 'url', 'content', 'file', 'localized', 'createdAt'], [item]);
    }
    async subtitleUpdate(id, patch) {
        const cols = Object.keys(patch).filter(c => ['name', 'lang', 'langName', 'type', 'url', 'content', 'file', 'localized'].includes(c));
        if (!cols.length) return false;
        const sets = cols.map(c => c + ' = ?').join(', ');
        const r = await this._q('UPDATE subtitles SET ' + sets + ' WHERE id = ?', [...cols.map(c => patch[c]), id]);
        return this._affected(r) > 0;
    }
    async subtitleDelete(id) {
        const r = await this._q('DELETE FROM subtitles WHERE id = ?', [id]);
        return this._affected(r) > 0;
    }
    async subtitleBulkInsert(items) {
        if (!items.length) return;
        const chunk = 200;
        for (let i = 0; i < items.length; i += chunk) {
            await this._insertMany('subtitles', ['id', 'name', 'lang', 'langName', 'type', 'url', 'content', 'file', 'localized', 'createdAt'], items.slice(i, i + chunk));
        }
    }
    async subtitleClear() { await this._q('DELETE FROM subtitles'); }

    /* ---- 视频字幕映射（vid -> [subtitleId]，kv 存储） ---- */
    async videoSubsAll() {
        const v = await this.kvGet('video_subs');
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    }
    async videoSubsWrite(obj) { await this.kvSet('video_subs', obj); }

    /* ---- 插件动态表（kv 存储，随存储迁移） ---- */
    async pluginTableGet() {
        const v = await this.kvGet('plugin_tables');
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    }
    async pluginTableSet(data) { await this.kvSet('plugin_tables', data); }

    async tables() {
        const names = ['danmu', 'videos', 'banned_words', 'accounts', 'login_logs', 'login_fails', 'subtitles', 'kv'];
        const out = [];
        for (const name of names) {
            const r = await this._q('SELECT COUNT(*) AS n FROM ' + name);
            out.push({ name, count: r[0].n });
        }
        /* security（封禁/白名单）存储在 kv 表的 security 键中 */
        const sec = await this._q("SELECT 1 AS x FROM kv WHERE key = 'security'");
        out.push({ name: 'security', count: sec.length ? 1 : 0 });
        return out;
    }

    async browse(table, { page = 1, limit = 50, search = '' } = {}) {
        if (table === 'danmu') return this.danmuPage({ page, limit, search });
        const cols = {
            videos: ['vid', 'url'],
            banned_words: ['word'],
            accounts: ['username', 'salt', 'hash', 'name', 'created'],
            security: ['key', 'value'],
            login_logs: ['ip', 'u', 'ok', 't', 'r'],
            login_fails: ['ip', 'count', 'firstAt', 'lockedUntil'],
            subtitles: ['id', 'name', 'lang', 'type'],
            kv: ['key', 'value']
        }[table];
        if (!cols) return { list: [], total: 0 };
        let where = '1=1', params = [];
        if (search) { where += ' AND ' + this._like(cols[0]) + ' ?'; params.push('%' + search + '%'); }
        const total = (await this._q('SELECT COUNT(*) AS n FROM ' + table + ' WHERE ' + where, params))[0].n;
        const start = (page - 1) * limit;
        params.push(limit, start);
        const list = await this._q('SELECT * FROM ' + table + ' WHERE ' + where + ' ORDER BY ' + cols[0] + ' LIMIT ? OFFSET ?', params);
        return { list, total };
    }

    _insertMany(table, cols, rows) {
        const sql = 'INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES ' + rows.map(() => '(' + cols.map(() => '?').join(', ') + ')').join(', ');
        return this._q(sql, rows.flatMap(r => cols.map(c => r[c])));
    }
    _affected(r) { return r.affectedRows != null ? r.affectedRows : (r.changes != null ? r.changes : 0); }
    _like(col) { return col + ' LIKE'; }
}

/* ==================== 统一存储门面（带 5s 缓存） ==================== */
class Store {
    constructor(backend) {
        this.backend = backend;
        this._bannedCache = null; this._bannedAt = 0;
        this._secCache = null; this._secAt = 0;
    }
    get type() { return this.backend.type; }
    get label() { return this.backend.label; }

    async init() { await this.backend.init(); }
    async close() { await this.backend.close(); }
    invalidate() { this._bannedCache = null; this._secCache = null; }

    danmuAll() { return this.backend.danmuAll(); }
    danmuPage(o) { return this.backend.danmuPage(o); }
    danmuBulkInsert(i) { return this.backend.danmuBulkInsert(i); }
    danmuAdd(i) { return this.backend.danmuAdd(i); }
    danmuDelete(id) { return this.backend.danmuDelete(id); }
    danmuClear() { return this.backend.danmuClear(); }
    danmuHasVid(v) { return this.backend.danmuHasVid(v); }
    danmuVids() { return this.backend.danmuVids(); }
    danmuAllVids() { return this.backend.danmuAllVids(); }

    videosAll() { return this.backend.videosAll(); }
    videoSet(v, u) { return this.backend.videoSet(v, u); }
    videoDelete(v) { return this.backend.videoDelete(v); }
    videoClear() { return this.backend.videoClear(); }
    videoByUrl(u) { return this.backend.videoByUrl(u); }

    async bannedAll(noCache) {
        const now = Date.now();
        if (!noCache && this._bannedCache && now - this._bannedAt < 5000) return this._bannedCache;
        const list = await this.backend.bannedAll();
        if (!noCache) { this._bannedCache = list; this._bannedAt = now; }
        return list;
    }
    bannedAdd(w) { this.invalidate(); return this.backend.bannedAdd(w); }
    bannedDelete(w) { this.invalidate(); return this.backend.bannedDelete(w); }
    bannedReplaceAll(l) { this.invalidate(); return this.backend.bannedReplaceAll(l); }

    accountsAll() { return this.backend.accountsAll(); }
    accountsWrite(o) { return this.backend.accountsWrite(o); }

    async securityGet(noCache) {
        const now = Date.now();
        if (!noCache && this._secCache && now - this._secCacheAt < 5000) return this._secCache;
        const s = await this.backend.securityGet();
        if (!noCache) { this._secCache = s; this._secCacheAt = now; }
        return s;
    }
    securityWrite(s) { this.invalidate(); return this.backend.securityWrite(s); }

    loginLogs() { return this.backend.loginLogs(); }
    loginLogsWrite(l) { return this.backend.loginLogsWrite(l); }
    loginFails() { return this.backend.loginFails(); }
    loginFailsWrite(o) { return this.backend.loginFailsWrite(o); }

    kvGet(k) { return this.backend.kvGet(k); }
    kvSet(k, v) { return this.backend.kvSet(k, v); }
    tables() { return this.backend.tables(); }
    browse(t, o) { return this.backend.browse(t, o); }

    subtitleAll() { return this.backend.subtitleAll(); }
    subtitleAdd(i) { return this.backend.subtitleAdd(i); }
    subtitleUpdate(id, p) { return this.backend.subtitleUpdate(id, p); }
    subtitleDelete(id) { return this.backend.subtitleDelete(id); }
    subtitleBulkInsert(i) { return this.backend.subtitleBulkInsert(i); }
    subtitleClear() { return this.backend.subtitleClear(); }
    videoSubsAll() { return this.backend.videoSubsAll(); }
    videoSubsWrite(o) { return this.backend.videoSubsWrite(o); }
    pluginTableGet() { return this.backend.pluginTableGet(); }
    pluginTableSet(d) { return this.backend.pluginTableSet(d); }
}

/* ==================== 工厂 ==================== */
async function createStore(type, dbCfg) {
    dbCfg = dbCfg || {};
    let backend;
    switch (type) {
        case 'json':
            backend = new JsonBackend();
            break;
        case 'sqlite': {
            const SqliteBackend = require('./backends/sqlite');
            backend = new SqliteBackend(dbCfg.sqlite || {});
            break;
        }
        case 'mysql':
        case 'mariadb': {
            const MysqlBackend = require('./backends/mysql');
            backend = new MysqlBackend(dbCfg.mysql || {});
            break;
        }
        case 'postgres': {
            const PostgresBackend = require('./backends/postgres');
            backend = new PostgresBackend(dbCfg.postgres || {});
            break;
        }
        case 'mongodb': {
            const MongodbBackend = require('./backends/mongodb');
            backend = new MongodbBackend(dbCfg.mongodb || {});
            break;
        }
        default:
            throw new Error('未知的存储类型: ' + type);
    }
    const store = new Store(backend);
    await store.init();
    return store;
}

/* ==================== 迁移工具 ==================== */
async function collectAll(store) {
    const [danmu, videos, banned_words, accounts, security, login_logs, login_fails, api_stats, ip_stats, subtitles, video_subs, plugin_tables] = await Promise.all([
        store.danmuAll(), store.videosAll(), store.bannedAll(true), store.accountsAll(),
        store.securityGet(true), store.loginLogs(), store.loginFails(),
        store.kvGet('api_stats'), store.kvGet('ip_stats'),
        store.subtitleAll(), store.videoSubsAll(), store.pluginTableGet()
    ]);
    return { danmu, videos, banned_words, accounts, security, login_logs, login_fails, kv: { api_stats, ip_stats }, subtitles, video_subs, plugin_tables };
}

async function restoreAll(store, d) {
    /* 整体替换语义：先清空目标表，保证迁移可重复执行（幂等） */
    await store.danmuClear();
    /* JSON 后端历史数据可能含重复 id（无主键约束），迁入 SQL 前按 id 去重 */
    const uniqueDanmu = [];
    if (Array.isArray(d.danmu)) {
        const seen = new Set();
        for (const item of d.danmu) {
            if (item && item.id && !seen.has(item.id)) { seen.add(item.id); uniqueDanmu.push(item); }
        }
    }
    if (uniqueDanmu.length) await store.danmuBulkInsert(uniqueDanmu);
    await store.videoClear();
    for (const [vid, url] of Object.entries(d.videos || {})) await store.videoSet(vid, url);
    if (Array.isArray(d.banned_words)) await store.bannedReplaceAll(d.banned_words);
    if (d.accounts) await store.accountsWrite(d.accounts);
    if (d.security) await store.securityWrite(d.security);
    if (Array.isArray(d.login_logs)) await store.loginLogsWrite(d.login_logs);
    if (d.login_fails) await store.loginFailsWrite(d.login_fails);
    await store.subtitleClear();
    if (Array.isArray(d.subtitles) && d.subtitles.length) await store.subtitleBulkInsert(d.subtitles);
    if (d.video_subs) await store.videoSubsWrite(d.video_subs);
    const kv = d.kv || {};
    if (kv.api_stats) await store.kvSet('api_stats', kv.api_stats);
    if (kv.ip_stats) await store.kvSet('ip_stats', kv.ip_stats);
    if (d.plugin_tables) await store.pluginTableSet(d.plugin_tables);
}

function summarizeData(d) {
    return {
        danmu: Array.isArray(d.danmu) ? d.danmu.length : 0,
        videos: Object.keys(d.videos || {}).length,
        banned_words: Array.isArray(d.banned_words) ? d.banned_words.length : 0,
        accounts: Object.keys(d.accounts || {}).length,
        banned: Object.keys((d.security || {}).banned || {}).length,
        whitelist: Object.keys((d.security || {}).whitelist || {}).length,
        login_logs: Array.isArray(d.login_logs) ? d.login_logs.length : 0,
        login_fails: Object.keys(d.login_fails || {}).length,
        api_stats: !!(d.kv || {}).api_stats,
        ip_stats: !!(d.kv || {}).ip_stats
    };
}

module.exports = { Store, JsonBackend, SqlBackend, createStore, collectAll, restoreAll, summarizeData };
