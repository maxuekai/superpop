import { Game } from './core/game.js';
import { Joystick } from './input/joystick.js';

window.addEventListener('load', () => {
    const canvas = document.getElementById('ball');
    const game = new Game(canvas);

    const controlPanel = document.querySelector('.control-panel');
    const joystick = new Joystick(controlPanel, game.player);
    joystick.enable();

    game.start();
});
