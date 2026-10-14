import { AI, COLORS, FOOD, JOYSTICK, PLAYER, VIEW, WORLD } from '../config.js';
import { PROTOCOL_VERSION } from './protocol.js';

// config 指纹：联机握手时客户端与服务器各算一份、逐字节比对。
// 两端跑不同数值的 bug（flee-sim 硬编码旧世界是同款教训）最难靠手感发现，
// 在 join 那一刻就拒绝比几周后"手感不对"便宜得多。
//
// ⚠ 参与指纹的块在这份清单里显式列出：新增/调整数值块后要把它加进来，
// 两端 import 的是同一个模块，清单本身不会漂。
//
// PROTOCOL_VERSION 也要算进去：configHash 只覆盖数值块，覆盖不到**协议形状**。
// 快照元组加一个字段时，旧客户端不会报错、只会读到错位的值——那才是最难查的一类联机 bug。
const BLOCKS = { PROTOCOL_VERSION, AI, COLORS, FOOD, JOYSTICK, PLAYER, VIEW, WORLD };

export function configHash() {
    let hash = 0x811c9dc5;
    const text = JSON.stringify(BLOCKS);
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}
