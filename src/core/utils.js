import { JOYSTICK, WORLD } from '../config.js';

// 单球半径上限。必须在**每一条增长路径**上都过一遍（吃食物、吃球），
// 否则总有一条能把球推到比世界还大，而那种球会被边界钳制钉在界外、永远看不见。
export function capRadius(r) {
    return Math.min(r, WORLD.maxBallRadius);
}

export function distance(x1, y1, x2, y2) {
    return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
}

// 平方距离：只用于「距离 vs 阈值」的比较（省去 sqrt，结果严格等价）。
// 距离值本身要参与加权/归一化的场合不能用这个。
export function distanceSq(x1, y1, x2, y2) {
    const dx = x1 - x2;
    const dy = y1 - y2;
    return dx * dx + dy * dy;
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

// 指数平滑：一帧最多追上「当前差距」的 (1 - e^(-rate·dt))。
// 关键性质是**单帧变化幅度与跳变大小无关**，只跟差距成比例——
// 无论目标值突然跳 1% 还是 30%，单帧位移都被 rate 限住，所以不会看出"突然一下"。
// 线性插值（current + (target-current) * t）做不到这点：t 固定时跳变越大单帧越猛。
// rate=6 时一帧最多追上 9.5%，63% 需要 167ms、95% 需要 500ms。
export function smoothTowards(current, target, rate, dt) {
    if (!(rate > 0) || !(dt > 0)) {
        return current;
    }
    return current + (target - current) * (1 - Math.exp(-rate * dt));
}

// 成簇食物里，某一颗相对簇心的偏移：方向随机、半径内距离随机
export function clusterOffset(clusterRadius) {
    const angle = randomFloat(0, Math.PI * 2);
    const dist = randomFloat(0, clusterRadius);
    return { dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist };
}

// 滚轮滚动量 → 缩放系数（>1 拉近）。deltaMode 各浏览器不一：0 像素（Chrome 一格约 ±100）、
// 1 行（Firefox 一格约 ±3）、2 页（罕见）。按行/页换算成像素量再取同一条指数曲线，
// 一格约 ×0.88，正负号天然处理方向（向上滚 deltaY<0 → 系数 >1 → 拉近）。
export function wheelZoomFactor(deltaY, deltaMode) {
    const unit = deltaMode === 1 ? 33 : deltaMode === 2 ? 400 : 1;
    return Math.exp(-deltaY * unit * 0.00125);
}

// 把用户缩放系数合成进目标缩放：缩出钳在 fitScale（fitScale 已含 maxZoomOut=1.3 的包络，
// 再往下会露出更多世界外空白、也架空视野类不变量），缩进钳在自动值的 userZoomMax 倍。
// auto 本身以 fitScale 为下限，所以 max ≥ min 恒成立，clamp 不会反转。
export function zoomTarget(auto, fitScale, userZoom, userZoomMax) {
    return clamp(auto * userZoom, fitScale, auto * userZoomMax);
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