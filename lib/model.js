'use strict';
/* ==========================================================================
 * 插件数据模型（ctx.model.define）
 * 插件可定义自己的数据表，存储于统一存储层的 plugin_tables 键：
 *   JSON 后端 → data/plugin_tables.json
 *   SQL 后端  → kv 表 plugin_tables 键
 *   MongoDB   → kv 集合
 * 切换存储时随 collectAll/restoreAll 自动迁移。
 * 注意：表数据为整表读写（适合插件级规模数据），单表上限建议 ≤ 1万行。
 * ========================================================================== */

const TABLE_NAME_RE = /^[a-zA-Z0-9_]{2,48}$/;

/* 依据 schema 校验/规整一条记录（宽松：未知字段保留，类型尽力转换） */
function coerceRecord(schema, record) {
    const out = {};
    const fields = (schema && schema.fields) || {};
    for (const [key, value] of Object.entries(record || {})) {
        const def = fields[key];
        if (!def) { out[key] = value; continue; }
        const type = (def.type || 'any').toLowerCase();
        if (type === 'number') out[key] = (typeof value === 'number') ? value : (parseFloat(value) || 0);
        else if (type === 'boolean') out[key] = !!value;
        else if (type === 'string') out[key] = String(value == null ? '' : value);
        else if (type === 'json') out[key] = (typeof value === 'object') ? value : value;
        else out[key] = value;
    }
    return out;
}

class PluginTable {
    constructor(model, name, schema) {
        this.model = model;
        this.name = name;
        this.schema = schema || {};
        this.primary = (schema && schema.primary) || 'id';
    }

    async _data() {
        const all = await this.model._store.pluginTableGet();
        return (all && all[this.name] && typeof all[this.name] === 'object') ? all[this.name] : {};
    }
    async _save(data) {
        const all = await this.model._store.pluginTableGet();
        all[this.name] = data;
        await this.model._store.pluginTableSet(all);
    }
    _genId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    /* 创建（无主键时自动生成 id），存在同主键则覆盖 */
    async create(record) {
        const data = await this._data();
        const row = coerceRecord(this.schema, record);
        if (row[this.primary] == null || row[this.primary] === '') row[this.primary] = this._genId();
        if (row.createdAt == null) row.createdAt = Date.now();
        data[row[this.primary]] = row;
        await this._save(data);
        return row;
    }

    async get(key) {
        const data = await this._data();
        return data[key] || null;
    }

    async update(key, patch) {
        const data = await this._data();
        if (!data[key]) return null;
        const row = coerceRecord(this.schema, { ...data[key], ...patch });
        data[key] = row;
        await this._save(data);
        return row;
    }

    async remove(key) {
        const data = await this._data();
        if (!data[key]) return false;
        delete data[key];
        await this._save(data);
        return true;
    }

    async count() {
        return Object.keys(await this._data()).length;
    }

    async clear() {
        await this._save({});
    }

    /* 分页查询：search 匹配 searchKey 字段（默认主键），返回 { list, total } */
    async list({ page = 1, limit = 50, search = '', searchKey = null } = {}) {
        const data = await this._data();
        let rows = Object.values(data).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        if (search) {
            const key = searchKey || this.primary;
            const lower = String(search).toLowerCase();
            rows = rows.filter(r => String(r[key] == null ? '' : r[key]).toLowerCase().includes(lower));
        }
        const total = rows.length;
        const start = (page - 1) * limit;
        return { list: rows.slice(start, start + limit), total, page, limit };
    }

    async all() {
        return Object.values(await this._data());
    }

    /* 批量替换（迁移用） */
    async _restore(rows) {
        const data = {};
        for (const r of Array.isArray(rows) ? rows : []) {
            const row = coerceRecord(this.schema, r);
            if (row[this.primary] != null && row[this.primary] !== '') data[row[this.primary]] = row;
        }
        await this._save(data);
    }
}

class PluginModel {
    constructor(store) {
        this._store = store;
        this._tables = new Map(); /* name -> PluginTable */
    }

    /* 定义（或获取）一张动态表。schema: { fields: {key: {type}}, primary } */
    define(name, schema) {
        if (!TABLE_NAME_RE.test(name)) throw new Error('无效的表名: ' + name);
        if (this._tables.has(name)) return this._tables.get(name);
        const table = new PluginTable(this, name, schema);
        this._tables.set(name, table);
        return table;
    }

    has(name) { return this._tables.has(name); }

    list() {
        return Array.from(this._tables.values()).map(t => ({ name: t.name, primary: t.primary, fields: Object.keys((t.schema && t.schema.fields) || {}) }));
    }

    /* 存储切换后重建绑定（表实例保持，底层数据自动切换） */
    rebind(store) { this._store = store; }
}

module.exports = { PluginModel, PluginTable, TABLE_NAME_RE };
