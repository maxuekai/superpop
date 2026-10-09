import { ACTIONS } from './config.js';
import { Game } from './core/game.js';
import { initLog, logText } from './core/log.js';
import { mountLogPanel, startLogPanelTicker } from './core/log-panel.js';
import { Joystick } from './input/joystick.js';
import { Keyboard } from './input/keyboard.js';
import { Hud } from './ui/hud.js';

window.addEventListener('load', () => {
    // 运行日志：默认关，地址栏加 ?debug=1 打开（?debug=all 连 debug 级快照一起显示）。
    // 埋点撒在 game.js / ball.js 里，所以关着时几乎没有开销。
    if (initLog()) {
        mountLogPanel();
        startLogPanelTicker();
        window.__superpopLog = logText;
        // 调试钩子：无头/自动化测试用（后台标签页的 requestAnimationFrame 会被浏览器
        // 节流到不触发，世界冻住没法测）。只在 ?debug=1 下暴露，生产路径不碰。
        window.__exposeGame = (game) => {
            window.__game = game;
        };
    }

    const canvas = document.getElementById('ball');
    const hud = new Hud(document);
    const game = new Game(canvas, hud);
    if (typeof window.__exposeGame === 'function') {
        window.__exposeGame(game);
    }

    // 摇杆和键盘都往 game.input 写方向，再由 Game 同步给每一个分身
    const controlPanel = document.querySelector('.control-panel');
    const joystick = new Joystick(controlPanel, game.input);
    joystick.enable();

    // 桌面端用 WASD/方向键；手指在屏幕上操控时键盘自动让位。
    // Space 之类的动作键通过 onAction 转交给游戏（分裂）。
    const keyboard = new Keyboard(document, game.input, {
        isBlocked: () => joystick.isActive,
        onAction: (code) => {
            if (ACTIONS.split.includes(code)) {
                game.requestSplit();
            }
        },
    });
    keyboard.enable();

    // 开局 / 结算界面的按钮把操作转交给游戏。
    // 注意要把 difficulty 一并传下去：曾有一版只写 (name)，难度选择器点了
    // 也不生效（setDifficulty(undefined) 静默回落 normal），纯 UI 自嗨。
    hud.onStart((name, difficulty) => game.begin(name, difficulty));
    hud.onRespawn((name) => game.respawnPlayer(name));
    hud.onSplit(() => game.requestSplit());
    hud.onMenu(() => game.quitToMenu());

    // 窗口尺寸 / 屏幕方向变化时重算画布与视口
    window.addEventListener('resize', game.resize);
    window.addEventListener('orientationchange', game.resize);
    // 手机上地址栏收放会改变可视视口高度，但不一定触发 window.resize；
    // 漏了这次重算，画布尺寸就和显示尺寸对不上（球变形 + 镜头错位）
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', game.resize);
    }

    game.start();
});