import { JOYSTICK } from '../config.js';

export function distance(x1, y1, x2, y2) {
    return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
}

// 摇杆头超出圆形范围时，沿当前方向固定在边缘位置
export function edgeOffsetX(x, y, radius = JOYSTICK.radius) {
    return radius * Math.cos(Math.atan2(y, x));
}

export function edgeOffsetY(x, y, radius = JOYSTICK.radius) {
    return radius * Math.sin(Math.atan2(y, x));
}

export function randomInt(max) {
    return Math.floor(Math.random() * max);
}

export function randomItem(list) {
    return list[randomInt(list.length)];
}
