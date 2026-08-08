'use strict';
/* SQLite 后端（better-sqlite3，本地文件，零配置） */
const path = require('path');
const { SqlBackend } = require('../store');

class SqliteBackend extends SqlBackend {
    constructor(cfg) {
        super('sqlite', 'SQLite', cfg);
        this.file = cfg.file || 'data/app.db';
        if (!path.isAbsolute(this.file)) this.file = path.join(__dirname, '..', '..', this.file);
    }

    async init() {
        let Database;
        try {
            Database = require('better-sqlite3');
        } catch (e) {
            throw new Error('未安装 better-sqlite3 驱动（npm install better-sqlite3）: ' + e.message);
        }
        this.db = new Database(this.file);
        this.db.pragma('journal_mode = WAL');
        for (const sql of this.ddl()) this.db.exec(sql);
    }

    async close() {
        if (this.db) { try { this.db.close(); } catch (e) {} this.db = null; }
    }

    async _q(sql, params) {
        const stmt = this.db.prepare(sql);
        if (/^\s*(SELECT|PRAGMA|EXPLAIN)/i.test(sql)) return stmt.all(...(params || []));
        const info = stmt.run(...(params || []));
        return { affectedRows: info.changes, lastInsertRowid: info.lastInsertRowid };
    }
    /* 多语句操作：每条语句原子提交即可，批量插入已按多行 VALUES 分块 */
    async _tx(fn) { return fn(); }

    ddl() {
        return [
            'CREATE TABLE IF NOT EXISTS danmu (id TEXT PRIMARY KEY, vid TEXT, text TEXT, color TEXT, type TEXT, time REAL, author TEXT, date TEXT)',
            'CREATE INDEX IF NOT EXISTS idx_danmu_vid ON danmu (vid)',
            'CREATE TABLE IF NOT EXISTS videos (vid TEXT PRIMARY KEY, url TEXT)',
            'CREATE TABLE IF NOT EXISTS banned_words (word TEXT PRIMARY KEY)',
            'CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, salt TEXT, hash TEXT, name TEXT, created INTEGER)',
            'CREATE TABLE IF NOT EXISTS login_logs (ip TEXT, u TEXT, ok INTEGER, t INTEGER, r TEXT)',
            'CREATE TABLE IF NOT EXISTS login_fails (ip TEXT PRIMARY KEY, count INTEGER, firstAt INTEGER, lockedUntil INTEGER)',
            'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)',
            'CREATE TABLE IF NOT EXISTS subtitles (id TEXT PRIMARY KEY, name TEXT, lang TEXT, langName TEXT, type TEXT, url TEXT, content TEXT, file TEXT, localized INTEGER, createdAt INTEGER)'
        ];
    }
}

module.exports = SqliteBackend;
