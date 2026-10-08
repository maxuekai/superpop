// 不变量检查：把散在文档里的硬约束写成**会失败的断言**。
//
// 为什么要有：AGENTS.md / tuning.md 里写了很多"必须同时满足"的约束，
// 但人（和 AI）不会每次都翻文档。这类东西的正确形态是可执行检查——
// 违反了就在 `npm run verify` 里当场炸，而不是几周后靠"手感不对"才发现。
//
// 每条断言都写清楚「它保护的是什么」，这样后来的人删断言之前得先想清楚。
import {
    AI, DIFFICULTY, EAT, FOOD, KING, PLAYER, SPLIT, VIEW, WORLD,
} from '../src/config.js';

const checks = [];
const add = (name, why, fn) => checks.push({ name, why, fn });

function assert(ok, message) {
    if (!ok) {
        throw new Error(message);
    }
}

// ── 世界与食物 ──────────────────────────────────────────────

add('食物面密度保持不变', 'WORLD 和 FOOD.count 必须同步改，否则屏内食物数会随地图缩放漂移；'
    + 'λ 掉了玩家"吃不过来"，λ 涨了又会挤成一坨', () => {
    // 1280×960 / 560 颗是反复验证过的基线，见 docs/tuning.md
    const BASE_AREA = 1280 * 960;
    const BASE_COUNT = 560;
    const lambda = FOOD.count / (WORLD.width * WORLD.height);
    const base = BASE_COUNT / BASE_AREA;
    const drift = Math.abs(lambda / base - 1);
    assert(drift < 0.02, `面密度偏离基线 ${(drift * 100).toFixed(1)}%`
        + `（当前 λ=${lambda.toExponential(3)}，基线 ${base.toExponential(3)}）。`
        + `改 WORLD 时请按面积同比例调整 FOOD.count，现在应为 ${Math.round(base * WORLD.width * WORLD.height)}。`);
});

add('单球半径上限装得进世界', 'Ball.update 的边界钳制在 r > 世界尺寸时会把球心硬推到界外，'
    + '而相机视口被 clamp 在世界内 → 球永远在屏幕外、走不回来（死档）', () => {
    const minSide = Math.min(WORLD.width, WORLD.height);
    assert(WORLD.maxBallRadius * 2 <= minSide,
        `maxBallRadius=${WORLD.maxBallRadius}，直径 ${WORLD.maxBallRadius * 2} 超过最短边 ${minSide}，`
        + `上限应 ≤ min(W,H)/2 = ${Math.floor(minSide / 2)}`);
});

add('称王门槛在半径上限之内', 'KING.mass 换算出的半径必须小于 maxBallRadius，'
    + '否则玩家在够到终点之前先撞上天花板，终点形同虚设', () => {
    const rKing = Math.sqrt(KING.mass);
    assert(rKing < WORLD.maxBallRadius,
        `KING.mass=${KING.mass} 对应半径 ${rKing.toFixed(0)}，已经 ≥ 上限 ${WORLD.maxBallRadius}。`
        + '玩家会在称王之前先被封顶。');
});

// ── 互吃与分裂 ──────────────────────────────────────────────

add('互吃比例大于 1', 'EAT.ratio ≤ 1 会让双方同时吃得掉对方（互吞），'
    + '也让"体型大 = 有优势"这条最基本的规则失效', () => {
    assert(EAT.ratio > 1, `EAT.ratio=${EAT.ratio}，必须 > 1`);
});

add('分裂门槛的文案与数值一致', '开局文案写死了 256kg。改了 minCellRadius 却不改文案，'
    + '玩家会一直等一个不会出现的按钮（AGENTS.md 记过同一个坑：禁用态必须说得出原因）', () => {
    const mass = Math.round(SPLIT.minCellRadius * SPLIT.minCellRadius);
    assert(mass === 256, `minCellRadius=${SPLIT.minCellRadius} 对应 ${mass}kg，`
        + '但 index.html 的开局文案写的是 256kg，两者要一起改。');
});

add('分裂间距大于合并阈值', '初始中心距必须大于 mergeCells 的合并阈值，'
    + '否则 mergeCooldown 一到两半就粘回去，玩家看到的是"按了没反应"', () => {
    const half = SPLIT.minCellRadius / Math.SQRT2;
    const centerDist = 2 * SPLIT.separation * half;
    const mergeAt = 2 * half * SPLIT.mergeFactor;
    assert(centerDist > mergeAt,
        `初始中心距 ${centerDist.toFixed(1)} ≤ 合并阈值 ${mergeAt.toFixed(1)}，`
        + '切完 3 秒后会自动粘回去。调大 SPLIT.separation。');
});

// ── 视野 ────────────────────────────────────────────────────

add('视野上限范围合理', 'VIEW.maxZoomOut 是视口最大 worlds 的倍数；'
    + 'Camera.clampView 在视口大于世界时是"居中"，所以超界本身安全，但露出太多就是空白', () => {
    assert(VIEW.maxZoomOut >= 1 && VIEW.maxZoomOut <= 2,
        `maxZoomOut=${VIEW.maxZoomOut}，合理范围 1~2：`
        + '小于 1 会让相机钳制失效，大于 2 会露出大片空白');
});

add('称王门槛处的球不超过视口宽度的一半', '球比屏幕还大就等于"看不见地图"，'
    + '这是真机反馈过的失败形态（曾经 68 秒就把 1024×768 吸干净、球占满整屏）', () => {
    const rKing = Math.sqrt(KING.mass);
    const sizeZoom = Math.pow(rKing / PLAYER.radius, VIEW.zoomExponent);
    const scale = Math.max(
        Math.max(390 / WORLD.width, 844 / WORLD.height) / VIEW.maxZoomOut,
        Math.max(390, 844) / (VIEW.longEdgeWorld * sizeZoom),
    );
    const viewW = 390 / scale;
    const ratio = (rKing * 2) / viewW;
    assert(ratio < 0.5,
        `称王门槛处球占视口宽 ${(ratio * 100).toFixed(0)}%（应 < 50%）。`
        + '要么调低 KING.mass，要么调大 WORLD / maxZoomOut。跑 node scripts/zoom-report.mjs 看曲线。');
});

// ── AI 与难度 ────────────────────────────────────────────────

add('难度档位不动速度', 'AI 跑得快就抓不到（speedScale 0.92→1.05 时被吃率从 20/20 崩到 4/20），'
    + '难度只能调决策质量——见 config.DIFFICULTY 的注释', () => {
    const labels = new Set();
    for (const [key, preset] of Object.entries(DIFFICULTY)) {
        for (const banned of ['speedScale', 'foragePower']) {
            assert(!(banned in preset),
                `难度档 "${key}" 里出现了速度参数 ${banned}——它会同时加快逃跑，让 AI 抓不到。`);
        }
        assert(!labels.has(preset.label), `难度标签重复：${preset.label}`);
        labels.add(preset.label);
    }
});

add('难度至少两档', '只有一档的话"难度模式"这个开关没有意义', () => {
    assert(Object.keys(DIFFICULTY).length >= 2,
        `难度档位只有 ${Object.keys(DIFFICULTY).length} 个`);
});

add('AI 觅食收益不超过玩家', 'AI.foodGain > PLAYER.growthPerFood 意味着 AI 靠吃食物就能滚雪球超过玩家，'
    + '玩家永远追不上、也没有成长空间', () => {
    assert(AI.foodGain <= PLAYER.growthPerFood,
        `AI.foodGain=${AI.foodGain} > PLAYER.growthPerFood=${PLAYER.growthPerFood}，`
        + '同量食物下 AI 会比玩家长得快。');
});

// ── 跑 ──────────────────────────────────────────────────────

let failed = 0;
for (const c of checks) {
    try {
        c.fn();
        console.log(`  ok   ${c.name}`);
    } catch (err) {
        failed += 1;
        console.log(`  FAIL ${c.name}`);
        console.log(`       ${err.message}`);
        console.log(`       （保护的是什么：${c.why}）`);
    }
}
console.log(`invariants check: ${checks.length - failed}/${checks.length} passed`);
if (failed > 0) {
    process.exitCode = 1;
}