#!/usr/bin/env node
/* 生成 update.xml 版本清单（服务端更新校验用）
   用法: node tools/gen-update-xml.js [更新说明] */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXCLUDE = /^(data\/|node_modules\/|temp_lexicon_update\/|\.git\/|tools\/|update\.xml$|.*\.log$|.*\.tgz$|\.DS_Store$)/;

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

let files = [];
try {
    files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
        .split('\n').map(s => s.trim()).filter(Boolean);
} catch (e) {
    console.error('git ls-files 失败（非 git 仓库?）: ' + e.message);
    process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const message = process.argv.slice(2).join(' ') || '例行更新';

const entries = files.filter(f => !EXCLUDE.test(f)).map(f => {
    const full = path.join(ROOT, f);
    let size = 0, hash = '';
    try { const st = fs.statSync(full); size = st.size; hash = sha256(full); } catch (e) { return null; }
    return `  <file path="${f.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" sha256="${hash}" size="${size}"/>`;
}).filter(Boolean);

const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- 版本清单：更新进程依据此文件校验与执行更新（data/ 目录不参与更新） -->
<update>
  <version>${version}</version>
  <date>${new Date().toISOString().slice(0, 10)}</date>
  <message>${message.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</message>
  <files>
${entries.join('\n')}
  </files>
</update>
`;

const out = path.join(ROOT, 'update.xml');
fs.writeFileSync(out, xml);
console.log(`已生成 ${out}：版本 ${version}，${entries.length} 个文件`);
