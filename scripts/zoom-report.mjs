// 视野缩放体检：手机竖屏下"球越大看得越远"到底有没有在发生。
//
// 背景：updateViewScale 里有个 fitScale（下限），保证视口不大于整个世界——
// 否则相机会被钳制出负坐标。代价是手机竖屏的缩放只活到很小的半径就失效，
// "大球视野更广"这件事从来没发生过。VIEW.maxZoomOut 放开了一点，
// Camera.clampView 在视口超过世界时改为居中。
//
// 用法：
//   node scripts/zoom-report.mjs            看当前配置下的实际视口
//   node scripts/zoom-report.mjs --scan     顺带扫一遍世界长宽比的影响
//
// 改 WORLD / VIEW.longEdgeWorld / zoomExponent / maxZoomOut 之后跑一次，
// 重点看两件事：①「缩放失效于」够不够大；②球占视口宽度的百分比在
// KING.mass 对应半径处是不是已经离谱（占满整屏 = 又回到"看不见地图"）。
import { PLAYER, VIEW, WORLD, FOOD, KING } from '../src/config.js';

const CSS_W = 390;
const CSS_H = 844;

// 和 Game.targetScale 同一套公式
function fitScale(worldW, worldH) {
    return Math.max(CSS_W / worldW, CSS_H / worldH) / VIEW.maxZoomOut;
}

function targetScale(worldW, worldH, r) {
    const sizeZoom = Math.pow(r / PLAYER.radius, VIEW.zoomExponent);
    return Math.max(fitScale(worldW, worldH), Math.max(CSS_W, CSS_H) / (VIEW.longEdgeWorld * sizeZoom));
}

// 缩放失效的临界半径：目标缩放降到 fitScale（视口已是世界的 maxZoomOut 倍）
function zoomLimit(worldW, worldH) {
    const k = Math.max(CSS_W, CSS_H) / (VIEW.longEdgeWorld * fitScale(worldW, worldH));
    return PLAYER.radius * Math.pow(k, 1 / VIEW.zoomExponent);
}

function report(worldW, worldH, foodCount) {
    const rKing = Math.sqrt(KING.mass);
    console.log(`世界 ${worldW}×${worldH}，食物 ${foodCount} 颗，maxZoomOut=${VIEW.maxZoomOut}`);
    console.log(`手机竖屏 ${CSS_W}×${CSS_H}\n`);
    console.log('半径 | 质量      | 视口宽×高      | 球直径占视口宽 | 屏内食物约');
    console.log('-'.repeat(72));
    for (const r of [10, 16, 25, 40, 60, 80, 100, 140, Math.round(rKing)]) {
        const s = targetScale(worldW, worldH, r);
        const vw = CSS_W / s;
        const vh = CSS_H / s;
        const visible = Math.round(foodCount * (vw * vh) / (worldW * worldH));
        console.log(
            `${String(r).padStart(4)} | ${String(Math.round(r * r)).padStart(8)}kg | `
            + `${vw.toFixed(0).padStart(4)}×${vh.toFixed(0).padStart(4)}      | `
            + `${((r * 2) / vw * 100).toFixed(0).padStart(12)}% | ${String(visible).padStart(8)}`,
        );
    }
    const limit = zoomLimit(worldW, worldH);
    console.log(`\n缩放失效于 r≈${limit.toFixed(0)}（之后视野固定，不再随体型变化）`);
    console.log(`称王门槛 ${KING.mass}kg 对应 r=${Math.round(rKing)}，`
        + `${limit >= rKing ? '在缩放区间内 ✓' : '已在失效点之外（有意为之）'}`);
    console.log(`验收口径：r=10 与 r=40 的视口宽度之比应当明显 > 1；`
        + `KING.mass 处球占视口宽不宜超过 ~50%。`);
}

if (process.argv.includes('--scan')) {
    console.log('不同世界长宽比下，缩放能活到多大的半径（食物按面积同比缩放）：\n');
    console.log('世界           | 缩放失效于 | 面积   | 屏内食物');
    console.log('-'.repeat(56));
    for (const [w, h] of [[1280, 960], [1280, 1280], [1280, 1600], [1120, 1600], [1280, 1920]]) {
        const food = Math.round(FOOD.count * (w * h) / (WORLD.width * WORLD.height));
        const s10 = targetScale(w, h, 10);
        const visible = Math.round(food * (CSS_W / s10) * (CSS_H / s10) / (w * h));
        const mark = w === WORLD.width && h === WORLD.height ? ' ←当前' : '';
        console.log(
            `${`${w}×${h}`.padEnd(14)} | ${zoomLimit(w, h).toFixed(0).padStart(6)}   | `
            + `${((w * h) / (WORLD.width * WORLD.height)).toFixed(2)}× | ${String(visible).padStart(6)}${mark}`,
        );
    }
    console.log('\n世界越大 AI 越抓不到，定 WORLD 前必须重扫：npm run sim -- --worldW X --worldH Y');
    console.log();
}

report(WORLD.width, WORLD.height, FOOD.count);