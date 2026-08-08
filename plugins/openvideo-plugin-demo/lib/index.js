/* ==========================================================================
 * OpenVideoAPI 示例插件（Koishi 风格 npm 包）
 *
 * 演示能力：
 *   1. 服务层：ctx.provide('stats') 提供服务；inject 声明依赖（store/model/app/logger/http）
 *   2. 动态表：ctx.model.define('demo_notes', schema) —— 存储随主存储切换自动迁移
 *   3. 事件总线：ctx.on('danmu:send') / ctx.on('dispose')
 *   4. 服务控制：ctx.app（version / uptime / restart / getConfig / saveConfig）
 *   5. 分级日志：ctx.logger（后台调试工具的数据源）
 *   6. 前端扩展：后台「调试工具」tab（lib/client/admin/debug.js）、播放器浮层（lib/client/player/overlay.js）
 *   7. 新 API：ctx.router（/api/plugin/demo/*）
 * ========================================================================== */
'use strict';

module.exports = {
    apply(ctx, config) {
        const stats = { danmuCount: 0, startedAt: Date.now(), notesCount: 0 };
        /* 1. 提供服务（其他插件可在 manifest.inject 声明 "stats" 来使用） */
        ctx.provide('stats', {
            get: () => ({ ...stats }),
            addNote: async (text) => {
                const row = await notes.create({ text });
                stats.notesCount = await notes.count();
                return row;
            }
        });

        /* 2. 动态表 */
        const notes = ctx.model.define('demo_notes', {
            primary: 'id',
            fields: { id: { type: 'string' }, text: { type: 'string' }, createdAt: { type: 'number' } }
        });
        notes.count().then(n => { stats.notesCount = n; }).catch(() => {});

        /* 3. 事件总线：监听弹幕发送 */
        ctx.on('danmu:send', (danmu) => {
            stats.danmuCount++;
            if (config.logDanmu !== false) {
                ctx.logger.debug('danmu', '[' + danmu.vid + '] ' + danmu.text);
            }
        });

        /* 4. 新 API：插件路由 */
        ctx.router.get('/api/plugin/demo/stats', async (req, res) => {
            res.json({ code: 0, data: {
                ...stats,
                version: ctx.version,
                uptime: ctx.app.uptime(),
                config: config
            } });
        });
        ctx.router.post('/api/plugin/demo/note', async (req, res) => {
            const text = String((req.body || {}).text || '').slice(0, 200);
            if (!text) return res.status(400).json({ code: 1, msg: '缺少内容' });
            const row = await notes.create({ text });
            res.json({ code: 0, data: row });
        });
        ctx.router.get('/api/plugin/demo/notes', async (req, res) => {
            const page = parseInt(req.query.page) || 1;
            const search = String(req.query.search || '');
            const d = await notes.list({ page, limit: 20, search, searchKey: 'text' });
            res.json({ code: 0, data: d });
        });
        ctx.router.delete('/api/plugin/demo/note', async (req, res) => {
            const { id } = req.body || {};
            const ok = await notes.remove(id);
            res.json({ code: ok ? 0 : 1, msg: ok ? '已删除' : '不存在' });
        });

        /* 5. 日志 + 服务信息 */
        ctx.logger.info('demo', '插件已加载，服务端版本 ' + ctx.version + '，PID ' + ctx.app.pid);

        /* 心跳定时器（示例：定时任务） */
        const interval = Math.max(5, parseInt(config.interval) || 60);
        const timer = setInterval(() => {
            ctx.logger.debug('demo', '心跳: 运行 ' + ctx.app.uptime() + 's，累计弹幕 ' + stats.danmuCount);
        }, interval * 1000);

        /* 卸载清理 */
        ctx.on('dispose', () => {
            clearInterval(timer);
            ctx.logger.info('demo', '插件已卸载');
        });
    }
};
