import { ACTIONS } from './config.js';
import { Game } from './core/game.js';
import { initLog, logText } from './core/log.js';
import { mountLogPanel, startLogPanelTicker } from './core/log-panel.js';
import { wheelZoomFactor } from './core/utils.js';
import { Joystick } from './input/joystick.js';
import { Keyboard } from './input/keyboard.js';
import { MouseSteer } from './input/mouse.js';
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

    // 摇杆和键盘都往 game.input 写方向，再由 Game 同步给每一个分身。
    // 摇杆的第二根手指走双指捏合缩放视野（onZoom 收两指距离比）
    const controlPanel = document.querySelector('.control-panel');
    const joystick = new Joystick(controlPanel, game.input, {
        onZoom: (factor) => game.zoomBy(factor),
    });
    joystick.enable();

    // 桌面端用 WASD/方向键；手指在屏幕上操控时键盘自动让位。
    // Space 之类的动作键通过 onAction 转交给游戏（分裂），+/- 键通过 onZoom 缩放视野。
    const keyboard = new Keyboard(document, game.input, {
        isBlocked: () => joystick.isActive,
        onAction: (code) => {
            if (ACTIONS.split.includes(code)) {
                game.requestSplit();
            }
        },
        onZoom: (factor) => game.zoomBy(factor),
    });
    keyboard.enable();

    // 桌面鼠标：球朝光标方向走（不用按住）。监听画布而不是 document——
    // HUD 面板浮在画布上方，指针停在面板上时画布收不到事件，球自然不动。
    // 手指在摇杆上操控时鼠标让位；菜单/结算弹层期间也不接管。
    const mouse = new MouseSteer(canvas, game.input, {
        getBallScreen: () => game.ballScreen(),
        isBlocked: () => joystick.isActive,
        isEnabled: () => game.state === 'playing' || game.state === 'dying',
    });
    mouse.enable();

    // 桌面滚轮也是视野缩放（一格约 ×0.88）。Ctrl+滚轮留给浏览器的页面缩放，不抢；
    // passive: false 才能 preventDefault 掉页面滚动
    canvas.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            return;
        }
        e.preventDefault();
        game.zoomBy(wheelZoomFactor(e.deltaY, e.deltaMode));
    }, { passive: false });

    // 开局 / 结算界面的按钮把操作转交给游戏。
    // 注意要把 difficulty 一并传下去：曾有一版只写 (name)，难度选择器点了
    // 也不生效（setDifficulty(undefined) 静默回落 normal），纯 UI 自嗨。
    // 联机走动态 import：单机玩家不付网络层的加载成本。
    hud.onStart(async (name, difficulty) => {
        if (hud.mode !== 'online') {
            game.begin(name, difficulty);
            return;
        }
        hud.showNetError('');
        try {
            const { NetSession } = await import('./net/client.js');
            const session = new NetSession();
            await session.join({
                name,
                viewport: { w: game.cssWidth, h: game.cssHeight },
                // 上次留下的认领令牌：刷新页面/被系统回收后再进来，还能要回同一颗球
                // （服务端宽限期内认领原细胞，见 server/index.js）。令牌失效时
                // 服务端当新玩家处理，这里不用特殊分支。
                token: NetSession.savedToken(),
            });
            game.attachNet(session);
            game.beginOnline();
        } catch (err) {
            hud.showNetError(`联机失败：${err.message}`);
        }
    });
    hud.onRespawn((name) => game.respawnPlayer(name));
    hud.onSplit(() => game.requestSplit());
    hud.onMenu(() => game.quitToMenu());

    // 窗口尺寸 / 屏幕方向变化时重算画布与视口。
    // 转屏、地址栏收放会同帧触发 resize / orientationchange / visualViewport.resize 中的多个，
    // 用 rAF 去抖：同帧只跑一次，跨帧的连续变化（地址栏动画）仍然每帧都响应。
    let resizeScheduled = false;
    const scheduleResize = () => {
        if (resizeScheduled) {
            return;
        }
        resizeScheduled = true;
        requestAnimationFrame(() => {
            resizeScheduled = false;
            game.resize();
        });
    };
    window.addEventListener('resize', scheduleResize);
    window.addEventListener('orientationchange', scheduleResize);
    // 手机上地址栏收放会改变可视视口高度，但不一定触发 window.resize；
    // 漏了这次重算，画布尺寸就和显示尺寸对不上（球变形 + 镜头错位）
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleResize);
    }

    game.start();
});