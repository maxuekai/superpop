// 运行日志设施：整个游戏共用一套。
//
// 存在的理由：真机反馈只能描述**现象**（"球突然消失"、"视角很生硬"、"AI 很傻"），
// 而现象和代码路径之间隔着好几层推理——球消失可能是被吃、被踢、重生到界外、世界重置，
// 四条完全不同的代码路径，不记下来就只能猜。所以这里给运行时事件一个统一的落笔处。
//
// 设计取舍：
//   · 默认关闭，?debug=1 打开。关着的时候 log() 是一次极短的 early-return，
//     不会有字符串拼接的开销（所以埋点可以放心撒在热路径上）。
//   · 环形缓冲，固定上限，不会因为跑久了吃掉内存。
//   · 分级（debug/info/warn/error），面板可以只看重要的。
//   · 埋点一律用 `log(标签, 内容)` 或 `log(标签, 内容, 'warn')` 这种最短形式。
//
// 面板见 log-panel.js，埋点见 game.js / ball.js 等。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_NAMES = Object.keys(LEVELS);

let threshold = LEVELS.info;
let bufferSize = 200;
let enabled = false;
let consoleSink = false;
const entries = [];
let seq = 0;

function pad(n) {
    return String(n).padStart(2, '0');
}

// 由 main.js 调用。默认关；?debug=1 打开；?debug=all 连 debug 级也显示。
export function initLog(options = {}) {
    const search = typeof location === 'undefined' ? '' : location.search;
    const params = new URLSearchParams(search);
    const mode = options.mode !== undefined ? options.mode : params.get('debug');

    enabled = mode === '1' || mode === 'all';
    threshold = mode === 'all' ? LEVELS.debug : LEVELS.info;
    consoleSink = options.console === true;
    bufferSize = options.bufferSize || bufferSize;
    if (!enabled) {
        return false;
    }
    entries.length = 0;
    log('日志', `已开启（缓冲 ${bufferSize} 条，?debug=all 看 debug 级，?debug=0 关闭）`);
    return true;
}

export function isLogOn() {
    return enabled;
}

// 主入口。标签用于面板配色与检索，内容是自由文本。
export function log(tag, message, level = 'info') {
    // 关着的时候直接返回：连 message 的求值都省了（调用处传的是引用）
    if (!enabled) {
        return null;
    }
    const value = LEVELS[level];
    if (value === undefined) {
        throw new Error(`未知的日志级别 "${level}"，可用：${LEVEL_NAMES.join(' / ')}`);
    }
    if (value < threshold) {
        return null;
    }
    seq += 1;
    const now = new Date();
    const entry = {
        seq,
        time: `${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
        level,
        levelValue: value,
        tag: String(tag),
        message: String(message),
    };
    entries.push(entry);
    if (entries.length > bufferSize) {
        entries.shift();
    }
    if (consoleSink) {
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn(`[${entry.tag}] ${entry.message}`);
    }
    return entry;
}

// 周期性快照：把"当时场上是什么情况"钉在时间线上。
// 没有它，事后再看到一条"某球消失"是查不出它旁边站着谁的。
export function logSnapshot(getState) {
    if (!enabled) {
        return;
    }
    const s = getState();
    const fps = s.fps ? ` / ${s.fps}fps` : '';
    const frame = s.frameMs ? ` / 帧 ${s.frameMs}ms` : '';
    log('快照', `玩家 ${s.mass}kg 第${s.rank}名 / AI ${s.alive}个 / 最大AI ${s.topAi}kg${fps}${frame}`, 'debug');
}

export function logEntries() {
    return entries.slice();
}

export function clearLog() {
    entries.length = 0;
}

export function logText(minLevel = 'debug') {
    const floor = LEVELS[minLevel];
    return entries
        .filter((e) => e.levelValue >= floor)
        .map((e) => `${e.time} [${e.level}] [${e.tag}] ${e.message}`)
        .join('\n');
}