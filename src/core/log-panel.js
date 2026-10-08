// 日志面板：把 log.js 的缓冲渲染到屏幕上。
//
// 为什么要单独一个文件：面板是"看日志"这个动作的 UI，日志本身是数据。
// 分开之后 log.js 不碰 DOM（core/ 保持无 DOM，可单测），面板样式也只在这里出现一次。
//
// 挂载：main.js 里 initLog 之后调 mountLogPanel()。默认关掉日志时它不挂载。
import { clearLog, isLogOn, logEntries, logText } from './log.js';

const CSS = `
#log-panel{position:fixed;left:8px;top:52px;z-index:30;width:min(360px,64vw);max-height:48vh;
display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.22);border-radius:10px;
background:rgba(6,16,14,.92);color:#dff3ec;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace}
#log-panel .t{display:flex;align-items:center;gap:6px;padding:4px 7px;color:#8ff0cd;
font-weight:600;border-bottom:1px solid rgba(255,255,255,.14)}
#log-panel .t .sp{flex:1}
#log-panel .t button{padding:1px 6px;border:none;border-radius:5px;font:inherit;
color:#06231f;background:#8ff0cd;cursor:pointer}
#log-panel ol{flex:1;margin:0;padding:5px 7px;list-style:none;overflow-y:auto;
max-height:calc(48vh - 26px)}
#log-panel li{margin-bottom:2px;word-break:break-word;display:flex;gap:5px}
#log-panel li b{color:#7f9c95;font-weight:400;flex:0 0 auto}
#log-panel li i{color:#8ff0cd;font-style:normal;flex:0 0 auto}
#log-panel li span{flex:1}
#log-panel li.debug{color:#8aa8a1}
#log-panel li.warn{color:#ffd76a}
#log-panel li.error{color:#ff9a9a}
`;

let panel = null;
let listEl = null;
let countEl = null;
let onlyImportant = false;

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
    const all = logEntries();
    const shown = onlyImportant ? all.filter((e) => e.levelValue >= 30) : all;
    countEl.textContent = `${shown.length}${onlyImportant ? '/' + all.length : ''}`;
    listEl.innerHTML = shown
        .map((e) => `<li class="${e.level}"><b>${e.time}</b><i>[${escapeHtml(e.tag)}]</i>`
            + `<span>${escapeHtml(e.message)}</span></li>`)
        .join('');
    // 贴到最下面，方便看最新的
    listEl.scrollTop = listEl.scrollHeight;
}

export function mountLogPanel(doc = document) {
    if (!isLogOn() || panel) {
        return panel;
    }
    // 样式也在这里注入：index.css 是被 git 跟踪的，不该为了调试去改它
    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.appendChild(style);

    panel = doc.createElement('div');
    // ui-interactive：不加的话摇杆会接管点面板的触摸，顺带把球也带跑
    panel.id = 'log-panel';
    panel.className = 'ui-interactive';
    panel.innerHTML = '<div class="t">运行日志'
        + `<span class="sp"></span><span class="n"></span>`
        + '<button type="button" data-act="important">只看警告</button>'
        + '<button type="button" data-act="export">导出</button>'
        + '<button type="button" data-act="clear">清空</button>'
        + '</div><ol></ol>';
    listEl = panel.querySelector('ol');
    countEl = panel.querySelector('.n');
    panel.querySelector('[data-act="clear"]').addEventListener('click', () => {
        clearLog();
        render();
    });
    panel.querySelector('[data-act="export"]').addEventListener('click', () => exportLog(doc));
    const imp = panel.querySelector('[data-act="important"]');
    imp.addEventListener('click', () => {
        onlyImportant = !onlyImportant;
        imp.textContent = onlyImportant ? '显示全部' : '只看警告';
        render();
    });
    doc.body.appendChild(panel);
    render();
    return panel;
}

function exportLog(doc = document) {
    const blob = new Blob([logText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = 'debug-log.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 面板需要随日志增长自动刷新。挂一个 250ms 的低频轮询，
// 比每条日志都去改 DOM 更省，也让 log() 保持"只管往缓冲里塞"的纯粹。
export function startLogPanelTicker(doc = document, intervalMs = 250) {
    if (!isLogOn()) {
        return null;
    }
    const id = doc.defaultView.setInterval(render, intervalMs);
    return () => doc.defaultView.clearInterval(id);
}