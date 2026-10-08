// 本地诊断日志 —— 正常代码，入库。
//
// 目的：真机反馈"球突然消失，没有被吃"这类问题。玩家只看得见屏幕上少了一个球，
// 分不出它是被吃了、被踢了、还是重生到了视野外——这几件事在代码里是完全不同的路径，
// 凭猜很难定位。这个文件把所有"球消失的原因"都记下来。
//
// 用法：直接开 http://<局域网IP>:3000/ ，面板默认出现。地址栏加 ?debug=0 可关掉。
// 取日志：① 手机直接截面板那张图；② 点「导出」下载 debug-log.txt（已在 .gitignore 里）；
//         ③ 桌面浏览器控制台敲 __superpopLog() 取全文。
//
// 为什么用原型补丁而不是直接在 Game 里埋 log() 调用：
//   这样 game.js / index.css 一个字都不用改，面板和样式都在这个文件里（CSS 由 JS 注入），
//   关掉（?debug=0）或删掉这个文件都不会影响游戏本体。
import { Game } from './core/game.js';

const MAX = 80;
const entries = [];
let panel = null;
let listEl = null;

const stamp = () => {
    const d = new Date();
    return `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function render() {
    if (!listEl) {
        return;
    }
    listEl.innerHTML = entries
        .map((e) => `<li class="debug-${e.kind}"><b>${e.time}</b> [${e.kind}] ${escapeHtml(e.text)}</li>`)
        .join('');
}

// 分类：
//   异常  —— 不该发生的，球无缘无故没了
//   消失  —— 离开视野但不是被吃（被踢 / 重生到界外 / 重置世界）
//   互吃  —— 正常被吃
//   玩家  —— 玩家自己的动作与状态
function log(kind, text) {
    const entry = { time: stamp(), kind, text: String(text) };
    entries.push(entry);
    if (entries.length > MAX) {
        entries.shift();
    }
    if (panel) {
        render();
    }
}

function describe(ball) {
    return `${ball.name || '(无名)'} r=${ball.r.toFixed(1)} ${Math.round(ball.mass)}kg`;
}

// 接管一个原型方法：先跑原实现，再做记录
function watch(name, after) {
    const original = Game.prototype[name];
    Game.prototype[name] = function patched(...args) {
        const result = original.apply(this, args);
        try {
            after.call(this, result, args);
        } catch (err) {
            log('异常', `诊断钩子 ${name} 自己报错了：${err && err.message}`);
        }
        return result;
    };
}

// ── 探针 1：每帧对账。这是"没被吃却消失"的通用探测器 ——
// 任何来源（哪怕是以后新加的路径）只要让球 alive 了又死了、却没进互吃名单，都会被抓到。
watch('updateWorld', function after(dt) {
    if (this.state !== 'playing' || this.__prevAlive === undefined) {
        return;
    }
    const now = this.balls.filter((b) => b.alive);
    const nowIds = new Set(now);
    for (const ball of this.__prevAlive) {
        if (!ball.alive && !nowIds.has(ball) && !ball.__wasEaten) {
            log('异常', `${describe(ball)} 消失了，但不是被互吃吃掉的`
                + `（respawnAt=${ball.respawnAt}，${ball.respawnAt === Infinity ? '已永久移除' : '等待重生'}）`);
        }
    }
    this.__prevAlive = now;
});

// 在互吃裁定之前打个标记，这样探针 1 能区分"被吃"和"别的什么"
watch('eatBalls', function after() {
    for (const ball of this.balls) {
        if (ball.alive) {
            ball.__wasEaten = false;
        }
    }
});

// 真正的"被吃掉"记录：Game.eatBalls 结算后会安排 respawnAt，
// 这里从 balls 里消失且 respawnAt 是有限值的，就是被吃后等重生
watch('eatBalls', function afterEatBalls() {
    for (const ball of this.balls) {
        if (!ball.alive && ball.ownerId !== 'player') {
            ball.__wasEaten = true;
        }
    }
});

// ── 探针 2：超编永久移除。这是头号嫌疑 —— 玩家眼里就是"凭空消失、没有被吃"。
watch('syncAiCount', function after() {
    if (this.__aiGone === undefined) {
        this.__aiGone = new Set();
    }
    const alive = new Set(this.ai.filter((a) => a.alive));
    const gone = [...this.__aiGone].filter((ai) => !alive.has(ai));
    for (const ai of gone) {
        log('消失', `AI「${ai.name}」r=${ai.r.toFixed(0)} 被**永久移除**（超编，不进重生队列）——`
            + `玩家眼里这就是凭空消失、没有被吃`);
    }
    this.__aiGone = new Set(this.ai);
});

// ── 探针 3：AI 重生。重生点"优先挑视口外"，于是玩家会看到它凭空消失、
// 过几秒在别处冒出来——这也是一种"没被吃却不见了"。
watch('respawnAi', function after(ai) {
    log('消失', `AI「${ai.name}」重生到 r=${ai.r.toFixed(0)}（视口外优先，`
        + `所以看起来像凭空消失又冒出来）`);
});

// ── 探针 4：玩家动作与状态
watch('requestSplit', function after(result) {
    if (result) {
        log('玩家', `分裂 → ${this.playerCells.length} 个分身，总质量 ${Math.round(this.playerMass())}kg`);
    }
});

watch('onPlayerEaten', function after(mass) {
    log('玩家', `全灭，最终 ${Math.round(mass)}kg，存活 ${this.playTime.toFixed(1)}s`);
});

watch('onCrowned', function after() {
    log('玩家', `称王！${Math.round(this.playerMass())}kg，存活 ${this.playTime.toFixed(1)}s`);
});

watch('restartWorld', function after() {
    log('消失', `世界重置：全部 ${this.ai.length} 个 AI 拉回出生体型、食物重新铺`);
});

// ── 面板
const CSS = `
#debug-log{position:fixed;left:8px;top:52px;z-index:30;width:min(340px,62vw);max-height:46vh;
overflow:hidden;border:1px solid rgba(255,255,255,.22);border-radius:10px;
background:rgba(6,16,14,.9);color:#dff3ec;font-size:11px;line-height:1.45}
#debug-log .t{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 7px;
color:#8ff0cd;font-weight:600;border-bottom:1px solid rgba(255,255,255,.14)}
#debug-log .btns{display:flex;gap:4px}
#debug-log .c{padding:1px 7px;border:none;border-radius:5px;font:inherit;color:#06231f;background:#8ff0cd}
#debug-log ol{margin:0;padding:5px 7px;list-style:none;overflow-y:auto;max-height:calc(46vh - 26px)}
#debug-log li{margin-bottom:2px;word-break:break-all}
#debug-log b{color:#7f9c95;font-weight:400}
#debug-log .异常{color:#ff9a9a}
#debug-log .消失{color:#ffd76a}
#debug-log .互吃{color:#9fe8c8}
#debug-log .玩家{color:#9ad4ff}
#debug-log .系统{color:#cfe9e2}
`;

function mount(doc = document) {
    const params = new URLSearchParams(doc.defaultView.location.search);
    if (params.get('debug') === '0') {
        return;
    }
    // 样式也由这里注入：index.css 是被 git 跟踪的，不能为了调试去改它
    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.appendChild(style);

    panel = doc.createElement('div');
    panel.id = 'debug-log';
    // ui-interactive：不加的话摇杆会接管点面板的触摸，顺带把球也带跑
    panel.className = 'ui-interactive';
    panel.innerHTML = '<div class="t">诊断日志（?debug=0 关闭）<span class="btns">'
        + '<button type="button" class="c" data-act="export">导出</button>'
        + '<button type="button" class="c" data-act="clear">清空</button>'
        + '</span></div><ol></ol>';
    listEl = panel.querySelector('ol');
    panel.querySelector('[data-act="clear"]').addEventListener('click', () => {
        entries.length = 0;
        render();
    });
    panel.querySelector('[data-act="export"]').addEventListener('click', () => exportLog(doc));
    doc.body.appendChild(panel);
    log('系统', `诊断日志已开启。共 ${MAX} 条滚动缓冲。`);
}

// 导出成 debug-log.txt（已在 .gitignore 里）。手机上点它会触发下载，
// 也可以直接截图面板 —— 两种都行，截图最省事。
function exportLog(doc = document) {
    const blob = new Blob([logText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = 'debug-log.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function logText() {
    return entries.map((e) => `${e.time} [${e.kind}] ${e.text}`).join('\n');
}

mount();
window.__superpopLog = logText;