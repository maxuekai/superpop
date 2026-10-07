import { COLORS, NICKNAME, PLAYER, PLAYER_OWNER } from '../config.js';
import { Ball } from './ball.js';
import { randomItem } from './utils.js';

// 玩家细胞：复用 Ball 的全部逻辑（移动/钳制/回弹/绘制/进食/互吃）。
// 速度由输入写进 game.input，再由 Game 同步到每一个分身。
// 所有分身共用 PLAYER_OWNER 这个 ownerId —— 于是它们彼此不能互吃，
// 排行榜则按「整组质量之和」统计。
export class Player extends Ball {
    constructor(name, ownerId) {
        super(0, 0, PLAYER.radius, randomItem(COLORS), name || NICKNAME.defaultName, ownerId || PLAYER_OWNER);
    }
}
