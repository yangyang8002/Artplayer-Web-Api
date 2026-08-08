/* OpenVideoAPI 示例插件 —— 播放器浮层（演示前端扩展 / hooks） */
(function () {
    'use strict';
    OpenVideoPlayer.onReady(function (ctx) {
        /* 插件公开配置通过插件自己的公开 API 读取（示例：/api/plugin/demo/stats） */
        fetch('/api/plugin/demo/stats').then(function (r) { return r.json(); }).then(function (d) {
            if (d.code !== 0) return;
            var cfg = d.data.config || {};
            if (cfg.showOverlay === false) return;
            var el = document.createElement('div');
            el.style.cssText = 'position:absolute;top:12px;left:12px;z-index:98;pointer-events:none;' +
                'background:rgba(0,0,0,.55);border:1px solid rgba(124,92,252,.4);color:#fff;' +
                'font-size:12px;padding:6px 12px;border-radius:8px;backdrop-filter:blur(6px);' +
                'font-family:monospace;letter-spacing:.5px;';
            el.textContent = 'OpenVideoAPI · 插件浮层';
            ctx.container.appendChild(el);
            var upd = function (ev) { el.textContent = 'OpenVideoAPI · 插件浮层 (' + (ev && ev.vid ? ev.vid : '等待加载') + ')'; };
            ctx.on('video:load', upd);
            el.addEventListener('dblclick', function () { el.style.display = 'none'; });
            upd();
        }).catch(function () {});
    });
})();
