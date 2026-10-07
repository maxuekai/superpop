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

// [min, max] 闭区间随机浮点数
export function randomFloat(min, max) {
    return min + Math.random() * (max - min);
}

export function randomItem(list) {
    return list[randomInt(list.length)];
}

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// 成簇食物里，某一颗相对簇心的偏移：方向随机、半径内距离随机
export function clusterOffset(clusterRadius) {
    const angle = randomFloat(0, Math.PI * 2);
    const dist = randomFloat(0, clusterRadius);
    return { dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist };
}

// 秒 → m:ss
export function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

// 把 #rgb / #rrggbb 颜色调亮（amount > 0）或调暗（amount < 0），返回 rgb() 字符串
export function shadeColor(hex, amount) {
    let value = hex.replace('#', '');
    if (value.length === 3) {
        value = value.split('').map((c) => c + c).join('');
    }
    const num = parseInt(value, 16);
    const clampChannel = (channel) => Math.min(255, Math.max(0, Math.round(channel + 255 * amount)));
    const r = clampChannel((num >> 16) & 0xff);
    const g = clampChannel((num >> 8) & 0xff);
    const b = clampChannel(num & 0xff);
    return `rgb(${r}, ${g}, ${b})`;
}