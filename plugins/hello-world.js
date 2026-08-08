/* ==========================================================================
 * ArtPlayer-Web-Api 示例插件（Koishi 风格）
 *
 * 插件 = 函数 / 类 / 带 apply 的对象。本示例使用「对象导出」：
 *   - 元数据：name / version / description / author / homepage（后台展示用）
 *   - 配置 Schema：schema 数组，后台自动生成配置表单
 *   - 逻辑：apply(ctx, config) 在加载时执行
 *
 * ctx 可用 API：
 *   router            Express 路由（ctx.router.get('/api/hello', ...)）
 *   store / model     数据存储（danmuAll / videoSet / kvGet / kvSet ...）
 *   getServerConfig() 服务器配置
 *   http              fetch 封装（get / post / json）
 *   log(msg)          带插件名前缀的日志
 *   on('dispose', fn) 卸载清理
 *   on(event, fn)     事件订阅（内置事件：danmu:send）
 *   emit(event, ...)  事件广播
 *   plugin(p, cfg)    嵌套插件
 *   version           服务端版本
 *
 * 安装方式（后台「插件管理」）：
 *   - 上传 .js 文件
 *   - GitHub / URL 下载：https://raw.githubusercontent.com/yangyang8002/Artplayer-Web-Api/master/plugins/hello-world.js
 *   - npm 包：插件导出 apply 的对象/函数即可
 * ========================================================================== */
'use strict';

module.exports = {
    name: 'hello-world',
    version: '1.0.0',
    description: '示例插件：启动时打印欢迎信息，监听弹幕发送事件并记录到日志',
    author: 'yangyang8002',
    homepage: 'https://github.com/yangyang8002/Artplayer-Web-Api',
    schema: [
        { key: 'greeting', label: '欢迎语', type: 'string', default: 'Hello, ArtPlayer!', hint: '服务启动时打印的欢迎信息' },
        { key: 'logDanmu', label: '记录弹幕', type: 'boolean', default: true, hint: '监听 danmu:send 事件并打印弹幕内容' },
        { key: 'level', label: '日志级别', type: 'select', default: 'info', options: [ { value: 'debug', label: '调试' }, { value: 'info', label: '普通' } ], hint: '日志输出级别' }
    ],
    apply(ctx, config) {
        ctx.log('[' + config.level + '] ' + (config.greeting || 'Hello, ArtPlayer!'));
        ctx.log('插件已加载，配置: ' + JSON.stringify(config));

        /* 注册一个示例路由：GET /api/hello-world */
        ctx.router.get('/api/hello-world', (req, res) => {
            res.json({ code: 0, data: { message: config.greeting || 'Hello, ArtPlayer!', time: Date.now() } });
        });

        /* 监听弹幕发送事件 */
        if (config.logDanmu !== false) {
            ctx.on('danmu:send', (danmu) => {
                ctx.log('收到弹幕 [' + danmu.vid + '] ' + danmu.text);
            });
        }

        /* 定时任务示例：每 60 秒打印一次运行状态 */
        const timer = setInterval(() => {
            ctx.log('运行中，当前时间: ' + new Date().toLocaleString());
        }, 60000);

        /* 卸载时清理定时器 */
        ctx.on('dispose', () => {
            clearInterval(timer);
            ctx.log('已卸载');
        });
    }
};
