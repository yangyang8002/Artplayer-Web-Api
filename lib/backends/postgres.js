'use strict';
/* PostgreSQL 后端（pg 驱动，占位符自动转换 ? → $n） */
const { SqlBackend } = require('../store');

class PostgresBackend extends SqlBackend {
    constructor(cfg) {
        super('postgres', 'PostgreSQL', cfg);
        this.connCfg = {
            host: cfg.host || '127.0.0.1',
            port: parseInt(cfg.port) || 5432,
            user: cfg.user || 'postgres',
            password: cfg.password || '',
            database: cfg.database || 'postgres',
            connectionTimeoutMillis: 8000,
            max: 5
        };
        this._rowCount = 0;
    }

    async init() {
        let pg;
        try {
            pg = require('pg');
        } catch (e) {
            throw new Error('未安装 pg 驱动（npm install pg）: ' + e.message);
        }
        const { Pool } = pg;
        this.pool = new Pool(this.connCfg);
        const conn = await this.pool.connect();
        try {
            await conn.query('SELECT 1');
        } finally {
            conn.release();
        }
        for (const sql of this.ddl()) await this.pool.query(sql);
    }

    async close() {
        if (this.pool) { try { await this.pool.end(); } catch (e) {} this.pool = null; }
    }

    _ph(sql) {
        let n = 0;
        return sql.replace(/\?/g, () => '$' + (++n));
    }

    async _q(sql, params) {
        const res = await this.pool.query(this._ph(sql), params || []);
        this._rowCount = res.rowCount;
        return res.rows;
    }
    _affected() { return this._rowCount; }

    async _tx(fn) {
        const conn = await this.pool.connect();
        try {
            await conn.query('BEGIN');
            await fn(conn);
            await conn.query('COMMIT');
        } catch (e) {
            try { await conn.query('ROLLBACK'); } catch (x) {}
            throw e;
        } finally {
            conn.release();
        }
    }
    async _qC(conn, sql, params) {
        const res = await conn.query(this._ph(sql), params || []);
        return res.rows;
    }
    async _insertManyTx(conn, table, cols, rows) {
        const sql = 'INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES ' + rows.map(() => '(' + cols.map(() => '?').join(', ') + ')').join(', ');
        await this._qC(conn, sql, rows.flatMap(r => cols.map(c => r[c])));
    }
    async _insertMany(table, cols, rows) {
        await this._tx((conn) => this._insertManyTx(conn, table, cols, rows));
    }

    async videoSet(vid, url) {
        await this._tx(async (conn) => {
            await this._qC(conn, 'DELETE FROM videos WHERE vid = ?', [vid]);
            await this._qC(conn, 'INSERT INTO videos (vid, url) VALUES (?, ?)', [vid, url]);
        });
    }
    async bannedReplaceAll(list) {
        await this._tx(async (conn) => {
            await this._qC(conn, 'DELETE FROM banned_words');
            if (list.length) await this._insertManyTx(conn, 'banned_words', ['word'], list.map(w => ({ word: w })));
        });
    }
    async accountsWrite(obj) {
        await this._tx(async (conn) => {
            await this._qC(conn, 'DELETE FROM accounts');
            const rows = Object.entries(obj || {}).map(([username, a]) => ({ username, salt: a.salt, hash: a.hash, name: a.name, created: a.created }));
            if (rows.length) await this._insertManyTx(conn, 'accounts', ['username', 'salt', 'hash', 'name', 'created'], rows);
        });
    }
    async loginLogsWrite(list) {
        await this._tx(async (conn) => {
            await this._qC(conn, 'DELETE FROM login_logs');
            const rows = (list || []).map(x => ({ ip: x.ip, u: x.u, ok: x.ok ? 1 : 0, t: x.t, r: x.r }));
            if (rows.length) await this._insertManyTx(conn, 'login_logs', ['ip', 'u', 'ok', 't', 'r'], rows);
        });
    }
    async loginFailsWrite(obj) {
        await this._tx(async (conn) => {
            await this._qC(conn, 'DELETE FROM login_fails');
            const rows = Object.entries(obj || {}).map(([ip, v]) => ({ ip, count: v.count, firstAt: v.firstAt, lockedUntil: v.lockedUntil }));
            if (rows.length) await this._insertManyTx(conn, 'login_fails', ['ip', 'count', 'firstAt', 'lockedUntil'], rows);
        });
    }
    async kvSet(key, value) {
        await this._tx(async (conn) => {
            await this._qC(conn, 'DELETE FROM kv WHERE key = ?', [key]);
            await this._qC(conn, 'INSERT INTO kv (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
        });
    }
    async securityWrite(s) { await this.kvSet('security', s); }

    _like(col) { return col + ' ILIKE'; }

    ddl() {
        return [
            'CREATE TABLE IF NOT EXISTS danmu (id TEXT PRIMARY KEY, vid TEXT, text TEXT, color TEXT, type TEXT, time DOUBLE PRECISION, author TEXT, date TEXT)',
            'CREATE INDEX IF NOT EXISTS idx_danmu_vid ON danmu (vid)',
            'CREATE TABLE IF NOT EXISTS videos (vid TEXT PRIMARY KEY, url TEXT)',
            'CREATE TABLE IF NOT EXISTS banned_words (word TEXT PRIMARY KEY)',
            'CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, salt TEXT, hash TEXT, name TEXT, created BIGINT)',
            'CREATE TABLE IF NOT EXISTS login_logs (ip TEXT, u TEXT, ok SMALLINT, t BIGINT, r TEXT)',
            'CREATE TABLE IF NOT EXISTS login_fails (ip TEXT PRIMARY KEY, count INT, firstAt BIGINT, lockedUntil BIGINT)',
            'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)',
            'CREATE TABLE IF NOT EXISTS subtitles (id TEXT PRIMARY KEY, name TEXT, lang TEXT, langName TEXT, type TEXT, url TEXT, content TEXT, file TEXT, localized SMALLINT, createdAt BIGINT)'
        ];
    }
}

module.exports = PostgresBackend;
