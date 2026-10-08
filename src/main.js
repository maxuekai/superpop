import { ACTIONS } from './config.js';
import { Game } from './core/game.js';
import { Joystick } from './input/joystick.js';
import { Keyboard } from './input/keyboard.js';
import { Hud } from './ui/hud.js';

window.addEventListener('load', () => {
    // 本地诊断脚手架（src/debug-local.js，已在 .gitignore 里）：文件不存在时静默跳过，
    // 所以这个 hook 提交上去是安全的。定位完真机问题把那个文件删掉即可。
    import('./debug-local.js').catch(() => {});

    const canvas = document.getElementById('ball');
    const hud = new Hud(document);
    const game = new Game(canvas, hud);

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

    // 开局 / 结算界面的按钮把操作转交给游戏
    hud.onStart((name) => game.begin(name));
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