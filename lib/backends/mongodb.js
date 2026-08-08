'use strict';
/* MongoDB 后端（mongodb 官方驱动，文档型存储）
   集合：danmu / videos / banned_words / accounts / login_logs / login_fails / subtitles / kv
   security（封禁/白名单）与 SQL 后端一致，存放在 kv 集合的 security 键中 */
const { SqlBackend } = require('../store');

class MongodbBackend extends SqlBackend {
    constructor(cfg) {
        super('mongodb', 'MongoDB', cfg);
        this.connCfg = {
            host: cfg.host || '127.0.0.1',
            port: parseInt(cfg.port) || 27017,
            user: cfg.user || '',
            password: cfg.password || '',
            database: cfg.database || 'artplayer',
            authSource: cfg.authSource || 'admin'
        };
    }

    async init() {
        let MongoClient;
        try {
            ({ MongoClient } = require('mongodb'));
        } catch (e) {
            throw new Error('未安装 mongodb 驱动（npm install mongodb）: ' + e.message);
        }
        const { host, port, user, password, database, authSource } = this.connCfg;
        const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : '';
        const url = `mongodb://${auth}${host}:${port}/?authSource=${authSource}&serverSelectionTimeoutMS=8000`;
        this.client = new MongoClient(url, { maxPoolSize: 5 });
        await this.client.connect();
        this.db = this.client.db(database);
        /* 唯一索引（幂等） */
        await Promise.all([
            this.db.collection('danmu').createIndex({ id: 1 }, { unique: true }),
            this.db.collection('danmu').createIndex({ vid: 1 }),
            this.db.collection('videos').createIndex({ vid: 1 }, { unique: true }),
            this.db.collection('banned_words').createIndex({ word: 1 }, { unique: true }),
            this.db.collection('accounts').createIndex({ username: 1 }, { unique: true }),
            this.db.collection('login_fails').createIndex({ ip: 1 }, { unique: true }),
            this.db.collection('subtitles').createIndex({ id: 1 }, { unique: true }),
            this.db.collection('kv').createIndex({ key: 1 }, { unique: true })
        ]);
    }

    async close() {
        if (this.client) { try { await this.client.close(); } catch (e) {} this.client = null; }
    }

    col(name) { return this.db.collection(name); }

    static escapeRegex(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /* ---- 弹幕 ---- */
    async danmuAll() {
        return this.col('danmu').find({}, { projection: { _id: 0 } }).toArray();
    }
    async danmuPage({ page = 1, limit = 50, vid = '', search = '' } = {}) {
        const q = {};
        if (vid) q.vid = vid;
        if (search) q.text = { $regex: MongodbBackend.escapeRegex(search), $options: 'i' };
        const total = await this.col('danmu').countDocuments(q);
        const list = await this.col('danmu').find(q, { projection: { _id: 0 } })
            .sort({ date: -1 }).skip((page - 1) * limit).limit(limit).toArray();
        return { list, total };
    }
    async danmuBulkInsert(items) {
        if (!items.length) return;
        const chunk = 400;
        for (let i = 0; i < items.length; i += chunk) {
            await this.col('danmu').insertMany(items.slice(i, i + chunk));
        }
    }
    async danmuAdd(item) { await this.col('danmu').insertOne(item); }
    async danmuDelete(id) {
        const r = await this.col('danmu').deleteOne({ id });
        return (r.deletedCount || 0) > 0;
    }
    async danmuClear() { await this.col('danmu').deleteMany({}); }
    async danmuHasVid(vid) { return !!(await this.col('danmu').findOne({ vid }, { projection: { _id: 1 } })); }
    async danmuVids() {
        const rows = await this.col('danmu').aggregate([
            { $group: { _id: '$vid', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]).toArray();
        return rows.map(r => ({ vid: r._id, count: r.count }));
    }
    async danmuAllVids() { return this.col('danmu').distinct('vid'); }

    /* ---- 视频映射 ---- */
    async videosAll() {
        const rows = await this.col('videos').find({}, { projection: { _id: 0 } }).toArray();
        const out = {};
        for (const r of rows) out[r.vid] = r.url;
        return out;
    }
    async videoSet(vid, url) {
        await this.col('videos').replaceOne({ vid }, { vid, url }, { upsert: true });
    }
    async videoDelete(vid) {
        const r = await this.col('videos').deleteOne({ vid });
        return (r.deletedCount || 0) > 0;
    }
    async videoClear() { await this.col('videos').deleteMany({}); }
    async videoByUrl(url) {
        const r = await this.col('videos').findOne({ url }, { projection: { _id: 0, vid: 1 } });
        return r ? r.vid : null;
    }

    /* ---- 屏蔽词 ---- */
    async bannedAll() {
        const rows = await this.col('banned_words').find({}, { projection: { _id: 0 } }).toArray();
        return rows.map(r => r.word);
    }
    async bannedAdd(word) {
        if (await this.col('banned_words').findOne({ word: new RegExp('^' + MongodbBackend.escapeRegex(word) + '$', 'i') })) return false;
        await this.col('banned_words').insertOne({ word });
        return true;
    }
    async bannedDelete(word) {
        const r = await this.col('banned_words').deleteOne({ word: new RegExp('^' + MongodbBackend.escapeRegex(word) + '$', 'i') });
        return (r.deletedCount || 0) > 0;
    }
    async bannedReplaceAll(list) {
        await this.col('banned_words').deleteMany({});
        if (list.length) await this.col('banned_words').insertMany(list.map(w => ({ word: w })));
    }

    /* ---- 账号 ---- */
    async accountsAll() {
        const rows = await this.col('accounts').find({}, { projection: { _id: 0 } }).toArray();
        const out = {};
        for (const r of rows) out[r.username] = { salt: r.salt, hash: r.hash, name: r.name, created: r.created };
        return out;
    }
    async accountsWrite(obj) {
        await this.col('accounts').deleteMany({});
        const rows = Object.entries(obj || {}).map(([username, a]) => ({ username, salt: a.salt, hash: a.hash, name: a.name, created: a.created }));
        if (rows.length) await this.col('accounts').insertMany(rows);
    }

    /* ---- 安全（kv 集合 security 键） ---- */
    async securityGet() {
        const doc = await this.col('kv').findOne({ key: 'security' }, { projection: { _id: 0 } });
        if (doc && doc.value && doc.value.banned && doc.value.whitelist) return doc.value;
        return { banned: {}, whitelist: {} };
    }
    async securityWrite(s) { await this.kvSet('security', s); }

    /* ---- 登录记录 ---- */
    async loginLogs() {
        const rows = await this.col('login_logs').find({}, { projection: { _id: 0 } }).sort({ t: 1 }).toArray();
        return rows.map(r => ({ ip: r.ip, u: r.u, ok: !!r.ok, t: r.t, r: r.r }));
    }
    async loginLogsWrite(list) {
        await this.col('login_logs').deleteMany({});
        const rows = (list || []).map(x => ({ ip: x.ip, u: x.u, ok: x.ok ? 1 : 0, t: x.t, r: x.r }));
        if (rows.length) await this.col('login_logs').insertMany(rows);
    }
    async loginFails() {
        const rows = await this.col('login_fails').find({}, { projection: { _id: 0 } }).toArray();
        const out = {};
        for (const r of rows) out[r.ip] = { count: r.count, firstAt: r.firstAt, lockedUntil: r.lockedUntil };
        return out;
    }
    async loginFailsWrite(obj) {
        await this.col('login_fails').deleteMany({});
        const rows = Object.entries(obj || {}).map(([ip, v]) => ({ ip, count: v.count, firstAt: v.firstAt, lockedUntil: v.lockedUntil }));
        if (rows.length) await this.col('login_fails').insertMany(rows);
    }

    /* ---- kv ---- */
    async kvGet(key) {
        const doc = await this.col('kv').findOne({ key }, { projection: { _id: 0 } });
        return doc ? doc.value : null;
    }
    async kvSet(key, value) {
        await this.col('kv').replaceOne({ key }, { key, value }, { upsert: true });
    }

    /* ---- 字幕库 ---- */
    async subtitleAll() {
        return this.col('subtitles').find({}, { projection: { _id: 0 } }).toArray();
    }
    async subtitleAdd(item) { await this.col('subtitles').insertOne(item); }
    async subtitleUpdate(id, patch) {
        const r = await this.col('subtitles').updateOne({ id }, { $set: patch });
        return (r.modifiedCount || 0) > 0 || (r.matchedCount || 0) > 0;
    }
    async subtitleDelete(id) {
        const r = await this.col('subtitles').deleteOne({ id });
        return (r.deletedCount || 0) > 0;
    }
    async subtitleBulkInsert(items) {
        if (!items.length) return;
        const chunk = 200;
        for (let i = 0; i < items.length; i += chunk) {
            await this.col('subtitles').insertMany(items.slice(i, i + chunk));
        }
    }
    async subtitleClear() { await this.col('subtitles').deleteMany({}); }
    async videoSubsAll() {
        const v = await this.kvGet('video_subs');
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    }
    async videoSubsWrite(obj) { await this.kvSet('video_subs', obj); }

    /* ---- 统计与浏览 ---- */
    async tables() {
        const names = ['danmu', 'videos', 'banned_words', 'accounts', 'login_logs', 'login_fails', 'subtitles', 'kv'];
        const out = [];
        for (const name of names) out.push({ name, count: await this.col(name).countDocuments() });
        const sec = await this.col('kv').findOne({ key: 'security' }, { projection: { _id: 1 } });
        out.push({ name: 'security', count: sec ? 1 : 0 });
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
        const q = search ? { [cols[0]]: { $regex: MongodbBackend.escapeRegex(search), $options: 'i' } } : {};
        const total = await this.col(table).countDocuments(q);
        const list = await this.col(table).find(q, { projection: { _id: 0 } })
            .sort({ [cols[0]]: 1 }).skip((page - 1) * limit).limit(limit).toArray();
        return { list, total };
    }
}

module.exports = MongodbBackend;
