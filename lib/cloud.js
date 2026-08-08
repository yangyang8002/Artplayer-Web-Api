'use strict';
/* ==========================================================================
 * 云端备份同步：FTP / FTPS / SFTP / WebDAV / OpenList（AList 兼容 API）
 * 统一接口：test() / list() / upload(localFile, name) / download(name, destFile) / remove(name)
 * ========================================================================== */

/* FTP / FTPS（basic-ftp，TLS 由 secure 选项控制） */
class CloudFtp {
    constructor(cfg) {
        this.cfg = cfg;
    }
    async _client() {
        const ftp = require('basic-ftp');
        const c = new ftp.Client(30000);
        c.ftp.verbose = false;
        return c;
    }
    async connect() {
        const c = await this._client();
        try {
            await c.access({
                host: this.cfg.host,
                port: parseInt(this.cfg.port) || 21,
                user: this.cfg.user || 'anonymous',
                password: this.cfg.password || '',
                secure: !!this.cfg.secure,
                secureOptions: this.cfg.secure ? { rejectUnauthorized: false } : undefined
            });
            const dir = this.cfg.path || '';
            if (dir && dir !== '/') {
                try { if (!(await c.exists(dir))) await c.ensureDir(dir); } catch (e) { /* 目录已存在等情况忽略 */ }
                await c.cd(dir);
            }
            return c;
        } catch (e) { try { c.close(); } catch (x) {} throw e; }
    }
    async test() { const c = await this.connect(); c.close(); }
    async list() {
        const c = await this.connect();
        try {
            const rows = await c.list();
            return rows.filter(r => r.name && !r.isDirectory)
                .map(r => ({ name: r.name, size: r.size || 0, modified: r.modifiedAt ? r.modifiedAt.getTime() : 0 }));
        } finally { c.close(); }
    }
    async upload(localFile, name) {
        const c = await this.connect();
        try { await c.uploadFrom(localFile, name); } finally { c.close(); }
    }
    async download(name, destFile) {
        const c = await this.connect();
        try { await c.downloadTo(destFile, name); } finally { c.close(); }
    }
    async remove(name) {
        const c = await this.connect();
        try { await c.remove(name); } finally { c.close(); }
    }
}

/* SFTP（ssh2-sftp-client） */
class CloudSftp {
    constructor(cfg) { this.cfg = cfg; }
    async connect() {
        const Sftp = require('ssh2-sftp-client');
        const s = new Sftp();
        await s.connect({
            host: this.cfg.host,
            port: parseInt(this.cfg.port) || 22,
            username: this.cfg.user,
            password: this.cfg.password
        });
        const dir = this.cfg.path || '/';
        try { await s.mkdir(dir, true); } catch (e) {}
        try { await s.cwd(); } catch (e) {}
        s._dir = dir;
        return s;
    }
    async test() { const s = await this.connect(); s.end(); }
    async list() {
        const s = await this.connect();
        try {
            const rows = await s.list(s._dir);
            return rows.filter(r => !r.type || r.type !== 'd')
                .map(r => ({ name: r.name, size: r.size || 0, modified: (r.modifyTime || 0) * 1000 }));
        } finally { s.end(); }
    }
    async upload(localFile, name) {
        const s = await this.connect();
        try { await s.put(localFile, s._dir + '/' + name); } finally { s.end(); }
    }
    async download(name, destFile) {
        const s = await this.connect();
        try { await s.get(s._dir + '/' + name, destFile); } finally { s.end(); }
    }
    async remove(name) {
        const s = await this.connect();
        try { await s.delete(s._dir + '/' + name); } finally { s.end(); }
    }
}

/* WebDAV（webdav 客户端） */
class CloudWebdav {
    constructor(cfg) {
        this.cfg = cfg;
        this.base = cfg.baseUrl || '';
    }
    client() {
        const { createClient, AuthType } = require('webdav');
        const opts = {
            username: this.cfg.user || '',
            password: this.cfg.password || '',
            authType: AuthType.Password
        };
        if (this.cfg.secure === false) opts.https = false;
        return createClient(this.base, opts);
    }
    _p(name) {
        const dir = String(this.cfg.path || '').replace(/\/+$/, '');
        return (dir || '') + '/' + name;
    }
    async test() {
        const cl = this.client();
        const dir = String(this.cfg.path || '');
        try { await cl.getDirectoryContents(dir || '/'); } catch (e) {
            if (e && (e.status === 404 || e.status === 301 || (e.response && e.response.status === 404))) {
                try { await cl.createDirectory(dir, { recursive: true }); } catch (e2) {}
            } else throw e;
        }
    }
    async list() {
        const cl = this.client();
        const dir = String(this.cfg.path || '');
        let rows = [];
        try { rows = await cl.getDirectoryContents(dir || '/'); } catch (e) {
            if (e && (e.status === 404 || e.status === 301 || (e.response && e.response.status === 404))) return [];
            throw e;
        }
        return rows.filter(r => r.type !== 'directory')
            .map(r => ({ name: r.basename, size: r.size || 0, modified: r.lastmod ? new Date(r.lastmod).getTime() : 0 }));
    }
    async upload(localFile, name) {
        const cl = this.client();
        const fs = require('fs');
        await cl.putFileContents(this._p(name), fs.createReadStream(localFile), { overwrite: true });
    }
    async download(name, destFile) {
        const cl = this.client();
        const fs = require('fs');
        const data = await cl.getFileContents(this._p(name));
        fs.writeFileSync(destFile, Buffer.isBuffer(data) ? data : Buffer.from(data));
    }
    async remove(name) {
        const cl = this.client();
        await cl.deleteFile(this._p(name));
    }
}

/* OpenList / AList 兼容 HTTP API */
class CloudOpenlist {
    constructor(cfg) {
        this.cfg = cfg;
        this.base = String(cfg.baseUrl || '').replace(/\/+$/, '');
        this.token = null;
    }
    async _login() {
        const r = await fetch(this.base + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: this.cfg.user, password: this.cfg.password }),
            signal: AbortSignal.timeout(15000)
        });
        const d = await r.json();
        if (!d || d.code !== 200 || !d.data || !d.data.token) throw new Error('登录失败: ' + ((d && d.message) || ('HTTP ' + r.status)));
        this.token = d.data.token;
    }
    async _req(method, path, body) {
        if (!this.token) await this._login();
        const r = await fetch(this.base + path, {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': this.token },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(60000)
        });
        const d = await r.json().catch(() => null);
        if (!d || d.code !== 200) {
            /* 令牌失效重试一次 */
            if (d && d.code === 401 && this._retried) throw new Error('请求失败: ' + ((d && d.message) || 'HTTP ' + r.status));
            if (d && d.code === 401) { this._retried = true; this.token = null; return this._req(method, path, body); }
            throw new Error('请求失败: ' + ((d && d.message) || ('HTTP ' + r.status)));
        }
        this._retried = false;
        return d.data;
    }
    _p(name) {
        const dir = String(this.cfg.path || '').replace(/\/+$/, '');
        return (dir || '') + '/' + name;
    }
    async test() {
        await this._req('POST', '/api/auth/login', { username: this.cfg.user, password: this.cfg.password });
        await this._listDir();
    }
    async _listDir() {
        const dir = String(this.cfg.path || '').replace(/\/+$/, '') || '/';
        const d = await this._req('POST', '/api/fs/list', { path: dir, page: 1, per_page: 0, refresh: false });
        return (d && d.content) || [];
    }
    async list() {
        const rows = await this._listDir();
        return rows.filter(r => !r.is_dir)
            .map(r => ({ name: r.name, size: r.size || 0, modified: r.modified ? new Date(r.modified).getTime() : 0 }));
    }
    async upload(localFile, name) {
        if (!this.token) await this._login();
        const fs = require('fs');
        const fd = new FormData();
        fd.append('path', String(this.cfg.path || '').replace(/\/+$/, '') || '/');
        fd.append('file', new Blob([fs.readFileSync(localFile)]), name);
        const r = await fetch(this.base + '/api/fs/upload', {
            method: 'POST',
            headers: { 'Authorization': this.token },
            body: fd,
            signal: AbortSignal.timeout(120000)
        });
        const d = await r.json().catch(() => null);
        if (!d || d.code !== 200) throw new Error('上传失败: ' + ((d && d.message) || ('HTTP ' + r.status)));
    }
    async download(name, destFile) {
        const d = await this._req('POST', '/api/fs/get', { path: this._p(name) });
        if (!d || !d.raw_url) throw new Error('获取下载链接失败');
        const r = await fetch(d.raw_url, { signal: AbortSignal.timeout(120000) });
        if (!r.ok) throw new Error('下载失败: HTTP ' + r.status);
        const fs = require('fs');
        fs.writeFileSync(destFile, Buffer.from(await r.arrayBuffer()));
    }
    async remove(name) {
        const dir = String(this.cfg.path || '').replace(/\/+$/, '') || '/';
        await this._req('POST', '/api/fs/remove', { path: dir, names: [name] });
    }
}

const TYPES = ['ftp', 'sftp', 'webdav', 'openlist'];

function createCloud(cfg) {
    switch (cfg.type) {
        case 'ftp': return new CloudFtp(cfg);
        case 'sftp': return new CloudSftp(cfg);
        case 'webdav': return new CloudWebdav(cfg);
        case 'openlist': return new CloudOpenlist(cfg);
        default: throw new Error('不支持的同步类型: ' + cfg.type);
    }
}

module.exports = { createCloud, TYPES };
