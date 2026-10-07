import { COLORS, NICKNAME, PLAYER } from '../config.js';
import { Ball } from './ball.js';
import { randomItem } from './utils.js';

// 玩家小球：复用 Ball 的全部逻辑（移动/钳制/回弹/绘制/进食/互吃），
// 速度由摇杆写进 speedX/speedY，这里只负责出生时的初始状态。
export class Player extends Ball {
    constructor(name) {
        super(0, 0, PLAYER.radius, randomItem(COLORS), name || NICKNAME.defaultName);
    }
}