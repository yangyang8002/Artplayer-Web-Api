/* OpenVideoAPI 示例插件 —— 后台「调试工具」tab */
(function () {
    'use strict';
    OpenVideoAdmin.registerTab({
        id: 'demo-debug',
        title: '调试工具',
        mount(el) {
            el.innerHTML = `
                <div class="card">
                    <h3><span class="dot" style="background:var(--accent);box-shadow:0 0 6px var(--accent)"></span>插件状态
                        <button class="btn btn-sm" style="margin-left:8px" id="demoRefresh">刷新</button>
                        <button class="btn btn-sm" style="border-color:var(--danger);color:var(--danger);margin-left:6px" id="demoRestart">重启服务</button>
                    </h3>
                    <div id="demoStats" style="font-size:12px;color:var(--text2);line-height:1.9">加载中...</div>
                </div>
                <div class="card">
                    <h3><span class="dot" style="background:var(--primary);box-shadow:0 0 6px var(--primary)"></span>插件日志（logger 缓冲）
                        <button class="btn btn-sm" style="margin-left:8px" onclick="OpenVideoAdmin._demoLoadLogs()">刷新</button>
                    </h3>
                    <div id="demoLogs" style="font-size:11px;font-family:monospace;max-height:260px;overflow:auto;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px;line-height:1.8">加载中...</div>
                </div>
                <div class="card">
                    <h3><span class="dot" style="background:var(--warn);box-shadow:0 0 6px var(--warn)"></span>动态表测试（ctx.model.define）
                        <div style="display:flex;gap:8px;margin-top:8px">
                            <input type="text" id="demoNoteText" placeholder="输入一条记录..." style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface2);color:var(--text);font-size:12px;outline:none">
                            <button class="btn btn-sm btn-primary" onclick="OpenVideoAdmin._demoAddNote()">添加</button>
                        </div>
                    </h3>
                    <div id="demoNotes" style="font-size:12px;margin-top:10px;color:var(--text2)">加载中...</div>
                </div>`;
            const refresh = document.getElementById('demoRefresh');
            refresh.onclick = () => OpenVideoAdmin._demoLoadAll();
            const restart = document.getElementById('demoRestart');
            restart.onclick = () => {
                if (!confirm('确认重启服务？')) return;
                OpenVideoAdmin.api('/api/admin/restart', { method: 'POST', body: JSON.stringify({}) })
                    .then(() => { restart.textContent = '重启中...'; restart.disabled = true; })
                    .catch(() => {});
            };
            OpenVideoAdmin._demoLoadAll();
        }
    });

    OpenVideoAdmin._demoLoadAll = function () {
        OpenVideoAdmin._demoLoadStats();
        OpenVideoAdmin._demoLoadLogs();
        OpenVideoAdmin._demoLoadNotes();
    };
    OpenVideoAdmin._demoLoadStats = function () {
        OpenVideoAdmin.api('/api/plugin/demo/stats').then(d => {
            if (d.code !== 0) return;
            const s = d.data;
            document.getElementById('demoStats').innerHTML =
                `服务端版本 <b style="color:var(--text)">${esc2(s.version)}</b> · 运行 <b style="color:var(--text)">${fmtUptime(s.uptime)}</b><br>` +
                `累计弹幕 <b style="color:var(--accent)">${s.danmuCount}</b> 条 · 动态表记录 <b style="color:var(--success)">${s.notesCount}</b> 条<br>` +
                `插件配置: <span data-i18n-skip>${JSON.stringify(s.config)}</span>`;
        }).catch(() => {});
    };
    OpenVideoAdmin._demoLoadLogs = function () {
        OpenVideoAdmin.api('/api/admin/plugins/logs?limit=60').then(d => {
            if (d.code !== 0) return;
            const el = document.getElementById('demoLogs');
            el.innerHTML = d.data.length ? d.data.map(l => {
                const color = l.level === 'error' ? 'var(--danger)' : l.level === 'warn' ? 'var(--warn)' : l.level === 'debug' ? 'var(--text3)' : 'var(--text2)';
                return `<div><span style="color:var(--text3)">${new Date(l.t).toLocaleTimeString('zh-CN')}</span> <span style="color:${color}">[${esc2(l.level)}][${esc2(l.scope)}]</span> ${esc2(l.msg)}</div>`;
            }).join('') : '<div style="color:var(--text3)">暂无日志</div>';
        }).catch(() => {});
    };
    OpenVideoAdmin._demoLoadNotes = function () {
        OpenVideoAdmin.api('/api/plugin/demo/notes').then(d => {
            if (d.code !== 0) return;
            const el = document.getElementById('demoNotes');
            el.innerHTML = d.data.list.length
                ? d.data.list.map(n => `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border)"><span style="flex:1">${esc2(n.text)}</span><span style="font-size:11px;color:var(--text3)">${new Date(n.createdAt).toLocaleString('zh-CN')}</span><button class="btn btn-sm" onclick="OpenVideoAdmin._demoDelNote('${n.id}')">删除</button></div>`).join('')
                : '<div class="empty-state">暂无记录，可通过 /api/plugin/demo/note 添加</div>';
        }).catch(() => {});
    };
    OpenVideoAdmin._demoAddNote = function () {
        const input = document.getElementById('demoNoteText');
        const text = input.value.trim();
        if (!text) return;
        OpenVideoAdmin.api('/api/plugin/demo/note', { method: 'POST', body: JSON.stringify({ text }) })
            .then(d => { if (d.code === 0) { input.value = ''; OpenVideoAdmin._demoLoadAll(); } })
            .catch(() => {});
    };
    OpenVideoAdmin._demoDelNote = function (id) {
        OpenVideoAdmin.api('/api/plugin/demo/note', { method: 'DELETE', body: JSON.stringify({ id }) })
            .then(d => { if (d.code === 0) OpenVideoAdmin._demoLoadNotes(); })
            .catch(() => {});
    };
})();
