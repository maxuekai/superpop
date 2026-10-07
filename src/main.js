import { Game } from './core/game.js';
import { Joystick } from './input/joystick.js';
import { Keyboard } from './input/keyboard.js';
import { Hud } from './ui/hud.js';

window.addEventListener('load', () => {
    const canvas = document.getElementById('ball');
    const hud = new Hud(document);
    const game = new Game(canvas, hud);

    const controlPanel = document.querySelector('.control-panel');
    const joystick = new Joystick(controlPanel, game.player);
    joystick.enable();

    // 桌面端用 WASD/方向键；手指在屏幕上操控时键盘自动让位
    const keyboard = new Keyboard(document, game.player, {
        isBlocked: () => joystick.isActive,
    });
    keyboard.enable();

    // 开局 / 结算界面的按钮把操作转交给游戏
    hud.onStart((name) => game.begin(name));
    hud.onRespawn((name) => game.respawnPlayer(name));

    // 窗口尺寸 / 屏幕方向变化时重算画布与视口
    window.addEventListener('resize', game.resize);
    window.addEventListener('orientationchange', game.resize);

    game.start();
});