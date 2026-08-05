const fs = require('fs');
const path = require('path');

function getVideoId(url) {
    let v = url;
    try { const u = new URL(url); v = u.pathname + u.search; } catch (e) {}
    let hash = 0;
    for (let i = 0; i < v.length; i++) { hash = ((hash << 5) - hash) + v.charCodeAt(i); hash |= 0; }
    return Math.abs(hash).toString(36);
}

const vid = getVideoId('/test_video1.mp4');
const COUNT = parseInt(process.argv[2]) || 5000;
const DURATION = 10; // test_video1.mp4 duration in seconds

const COLORS = ['#ffffff', '#e54256', '#ffe133', '#64dd17', '#39ccff', '#fb7299', '#a855f7'];
const WORDS = ['性能测试', '弹幕压测', '刷屏啦', '666', '哈哈哈', '前方高能', '打卡', '路过', '震撼', '好看', '再来一次', '测试弹幕', 'LLL', '弹幕护体', '空降', '名场面', '泪目', '破防', '离谱', '经典永流传'];
const MODES = [0, 0, 0, 0, 0, 0, 0, 1, 2]; // ~78% scroll, 11% top, 11% bottom

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

let idCounter = Date.now();
const list = [];
for (let i = 0; i < COUNT; i++) {
    const t = Math.floor(Math.random() * DURATION * 100) / 100;
    const words = [rand(WORDS)];
    if (Math.random() < 0.4) words.push(rand(WORDS));
    if (Math.random() < 0.15) words.push(String(Math.floor(Math.random() * 999)));
    const mode = rand(MODES);
    const type = mode === 0 ? 'right' : (mode === 1 ? 'top' : 'bottom');
    list.push({
        id: String(idCounter++),
        vid,
        text: words.join(' '),
        color: rand(COLORS),
        type,
        time: t,
        author: 'perf' + Math.floor(Math.random() * 1000),
        date: new Date().toISOString()
    });
}

const file = path.join(__dirname, 'data', 'danmu.json');
fs.writeFileSync(file, JSON.stringify(list, null, 0));
console.log(`已生成 ${list.length} 条弹幕 → ${file}`);
console.log(`视频ID: ${vid}`);
console.log(`时长: ${DURATION}s, 平均 ${Math.round(COUNT / DURATION)} 条/秒`);
// stats
const byType = { right: 0, top: 0, bottom: 0 };
list.forEach(d => byType[d.type]++);
console.log(`类型分布: 滚动=${byType.right} 顶部=${byType.top} 底部=${byType.bottom}`);
console.log(`文件大小: ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
