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

// 把 #rgb / #rrggbb 颜色调亮（amount > 0）或调暗（amount < 0），返回 rgb() 字符串
export function shadeColor(hex, amount) {
    let value = hex.replace('#', '');
    if (value.length === 3) {
        value = value.split('').map((c) => c + c).join('');
    }
    const num = parseInt(value, 16);
    const clamp = (channel) => Math.min(255, Math.max(0, Math.round(channel + 255 * amount)));
    const r = clamp((num >> 16) & 0xff);
    const g = clamp((num >> 8) & 0xff);
    const b = clamp(num & 0xff);
    return `rgb(${r}, ${g}, ${b})`;
}
