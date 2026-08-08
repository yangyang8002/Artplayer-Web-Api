'use strict';
/* MySQL / MariaDB 后端（mysql2 驱动） */
const { SqlBackend } = require('../store');

class MysqlBackend extends SqlBackend {
    constructor(cfg, type) {
        super(type || 'mysql', type === 'mariadb' ? 'MariaDB' : 'MySQL', cfg);
        this.connCfg = {
            host: cfg.host || '127.0.0.1',
            port: parseInt(cfg.port) || 3306,
            user: cfg.user || 'root',
            password: cfg.password || '',
            database: cfg.database || '',
            charset: 'utf8mb4',
            connectionLimit: 5,
            connectTimeout: 8000
        };
    }

    async init() {
        let mysql2;
        try {
            mysql2 = require('mysql2/promise');
        } catch (e) {
            throw new Error('未安装 mysql2 驱动（npm install mysql2）: ' + e.message);
        }
        this.pool = mysql2.createPool(this.connCfg);
        // 连接测试 + 自动建库（无则创建）
        const conn = await this.pool.getConnection();
        try {
            if (!this.connCfg.database) throw new Error('未指定数据库名 (database)');
            await conn.query('CREATE DATABASE IF NOT EXISTS `' + this.connCfg.database.replace(/`/g, '``') + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
            await conn.query('USE `' + this.connCfg.database.replace(/`/g, '``') + '`');
        } finally {
            conn.release();
        }
        for (const sql of this.ddl()) await this.pool.query(sql);
    }

    async close() {
        if (this.pool) { try { await this.pool.end(); } catch (e) {} this.pool = null; }
    }

    async _q(sql, params) {
        const [rows] = await this.pool.query(sql, params || []);
        return rows;
    }
    async _tx(fn) {
        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();
            await fn(conn);
            await conn.commit();
        } catch (e) {
            try { await conn.rollback(); } catch (x) {}
            throw e;
        } finally {
            conn.release();
        }
    }
    /* 批量插入、整表写入等事务内操作需要传连接 */
    async _qC(conn, sql, params) {
        const [rows] = await conn.query(sql, params || []);
        return rows;
    }
    async _insertManyTx(conn, table, cols, rows) {
        const sql = 'INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES ' + rows.map(() => '(' + cols.map(() => '?').join(', ') + ')').join(', ');
        await this._qC(conn, sql, rows.flatMap(r => cols.map(c => r[c])));
    }
    async _insertMany(table, cols, rows) {
        await this._tx((conn) => this._insertManyTx(conn, table, cols, rows));
    }

    /* 继承的整表写入操作，改为使用连接内事务 */
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

    ddl() {
        return [
            'CREATE TABLE IF NOT EXISTS danmu (id VARCHAR(64) PRIMARY KEY, vid VARCHAR(64), text MEDIUMTEXT, color VARCHAR(16), type VARCHAR(16), time DOUBLE, author VARCHAR(128), date VARCHAR(64), KEY idx_danmu_vid (vid))',
            'CREATE TABLE IF NOT EXISTS videos (vid VARCHAR(64) PRIMARY KEY, url MEDIUMTEXT)',
            'CREATE TABLE IF NOT EXISTS banned_words (word VARCHAR(512) PRIMARY KEY)',
            'CREATE TABLE IF NOT EXISTS accounts (username VARCHAR(64) PRIMARY KEY, salt VARCHAR(64), hash VARCHAR(256), name VARCHAR(128), created BIGINT)',
            'CREATE TABLE IF NOT EXISTS login_logs (ip VARCHAR(64), u VARCHAR(64), ok TINYINT, t BIGINT, r VARCHAR(128))',
            'CREATE TABLE IF NOT EXISTS login_fails (ip VARCHAR(64) PRIMARY KEY, count INT, firstAt BIGINT, lockedUntil BIGINT)',
            'CREATE TABLE IF NOT EXISTS kv (key VARCHAR(64) PRIMARY KEY, value LONGTEXT)',
            'CREATE TABLE IF NOT EXISTS subtitles (id VARCHAR(64) PRIMARY KEY, name VARCHAR(255), lang VARCHAR(32), langName VARCHAR(64), type VARCHAR(16), url TEXT, content LONGTEXT, file VARCHAR(255), localized TINYINT, createdAt BIGINT)'
        ];
    }
}

module.exports = MysqlBackend;
