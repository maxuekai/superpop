// 食物密度与成长仿真：回答「为什么总觉得吃不到东西」。
// 两部分：① 静态指标（密度、间距、屏内数量、命中概率）
//          ② 觅食仿真（玩家球 vs AI 球各跑 30 秒，看谁吃得多、长得多）
// 用途：调 FOOD.count / radius / cluster、PLAYER.growthPerFood、AI.foodGain 之前先跑它。
import { AI, FOOD, JOYSTICK, PLAYER, WORLD } from '../src/config.js';
import { AiPlayer } from '../src/core/ai.js';
import { Ball } from '../src/core/ball.js';
import { distance, randomFloat } from '../src/core/utils.js';

const STEP = 1 / 60;
const SECONDS = 30;

// 固定随机种子，和 flee-sim 一样保证结果可复现
let rngSeed = 20261007;
Math.random = () => {
    rngSeed = (rngSeed * 1103515245 + 12345) % 2147483648;
    return rngSeed / 2147483648;
};

// 命令行覆盖：--divisor / --speedUnit / --playerGain / --foodGain
const args = process.argv.slice(2);
const flagValue = (name) => {
    const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) {
        return undefined;
    }
    const raw = hit.includes('=') ? hit.split('=')[1] : args[args.indexOf(hit) + 1];
    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
};
if (flagValue('divisor') !== undefined) PLAYER.speedDivisor = flagValue('divisor');
if (flagValue('slowdown') !== undefined) PLAYER.slowdownPerRadius = flagValue('slowdown');
if (flagValue('playerGain') !== undefined) PLAYER.growthPerFood = flagValue('playerGain');
if (flagValue('foodGain') !== undefined) AI.foodGain = flagValue('foodGain');
// AI 行为旋钮：调觅食效率/追击范围时用。AI/玩家比掉下来时先扫这几个，
// 而不是去动 foodGain（瓶颈往往在决策而不是收益）
if (flagValue('thinkInterval') !== undefined) AI.thinkInterval = flagValue('thinkInterval');
if (flagValue('chaseRange') !== undefined) AI.chaseRange = flagValue('chaseRange');
if (flagValue('escapeFoodRange') !== undefined) AI.escapeFoodRange = flagValue('escapeFoodRange');
if (flagValue('fleeRange') !== undefined) AI.fleeRange = flagValue('fleeRange');
if (flagValue('escapeProbe') !== undefined) AI.escapeProbe = flagValue('escapeProbe');
if (flagValue('escapeChange') !== undefined) AI.escapeChange = flagValue('escapeChange');
if (flagValue('speedScale') !== undefined) AI.speedScale = flagValue('speedScale');
// AI 觅食时还有一层额外减速（config.AI.foragePower，原为硬编码 0.95），
// 和 speedScale 叠起来是 0.874 倍满舵——比玩家慢 12.6%。--foragePower=1 可以关掉它。
if (flagValue('foragePower') !== undefined) AI.foragePower = flagValue('foragePower');

// 与 Ball.update 同一套公式
function speedOf(r) {
    const divisor = PLAYER.speedDivisor + Math.max(0, r - PLAYER.radius) * PLAYER.slowdownPerRadius;
    return (JOYSTICK.radius / divisor) * PLAYER.speedUnit;
}

// ---------- ① 静态指标 ----------

const area = WORLD.width * WORLD.height;
const lambda = FOOD.count / area;
const spacing = Math.sqrt(area / FOOD.count);
const nearestExpected = 0.5 / Math.sqrt(lambda);

// 满速直线穿过一片食物，单位路程吃到一颗的概率
// 判定走廊宽 = 2 × (r + 食物半径)，走廊扫过的面积 = 距离 × 走廊宽，再乘面密度 λ
const corridor = 2 * (PLAYER.radius + FOOD.radius);
const perUnit = corridor * lambda;
const speed = JOYSTICK.radius / PLAYER.speedDivisor * PLAYER.speedUnit; // 初始半径时的满速（世界单位/秒）

console.log('【静态指标】');
console.log(`  世界 ${WORLD.width}×${WORLD.height}（${area} 单位²），食物 ${FOOD.count} 颗，半径 ${FOOD.radius}`);
console.log(`  平均间距 ${spacing.toFixed(1)}，到最近食物的期望距离 ${nearestExpected.toFixed(1)} 世界单位`);
console.log(`  进食判定半径 ${PLAYER.radius + FOOD.radius}，直线行进每 100 单位期望吃到 ${(perUnit * 100).toFixed(2)} 颗`);
console.log(`  初始满速 ${speed.toFixed(0)} 单位/秒 → 直线觅食每秒期望吃到 ${(perUnit * speed).toFixed(2)} 颗`);

// 速度剖面：慢不慢要用「跨屏/跨图要几秒」来判断，而不是看公式
const desktopScale = Math.max(1280 / WORLD.width, 720 / WORLD.height, 1280 / 900);
const screenSpan = 1280 / desktopScale; // 桌面视口宽度（世界单位）
console.log('\n【速度剖面】速度 = 满舵 / (分母 + (r-初始半径) × 减速系数) × speedUnit');
console.log(`  半径 | 速度(单位/秒) | 相对初始 | 跨屏(${screenSpan.toFixed(0)}单位) | 跨全图(${WORLD.width}单位)`);
for (const r of [10, 15, 20, 30, 40, 50, 60, 80]) {
    const v = speedOf(r);
    const pct = (v / speedOf(PLAYER.radius)) * 100;
    console.log(`  ${String(r).padStart(4)} | ${v.toFixed(1).padStart(12)} | ${pct.toFixed(0).padStart(8)}% `
        + `| ${(screenSpan / v).toFixed(1).padStart(17)}s | ${(WORLD.width / v).toFixed(1).padStart(14)}s`);
}
console.log(`  目标手感参考：跨屏 5~7 秒比较跟手（>10 秒会明显觉得慢）`);

for (const [label, cssW, cssH] of [['手机竖屏 390×844', 390, 844], ['桌面 1280×720', 1280, 720]]) {
    const scale = Math.max(cssW / WORLD.width, cssH / WORLD.height, Math.max(cssW, cssH) / 900);
    const wView = cssW / scale;
    const hView = cssH / scale;
    const visible = Math.round(FOOD.count * (wView * hView) / area);
    console.log(`  ${label}：视口 ${wView.toFixed(0)}×${hView.toFixed(0)}（占全图 ${((wView * hView) / area * 100).toFixed(0)}%），`
        + `屏内约 ${visible} 颗，食物直径 ${(FOOD.radius * 2 * scale).toFixed(1)} css px`);
}

// ---------- ② 觅食仿真 ----------

function makeFoodField(count) {
    const list = [];
    for (let i = 0; i < count; i += 1) {
        list.push({ x: randomFloat(FOOD.radius + 4, WORLD.width - FOOD.radius - 4),
            y: randomFloat(FOOD.radius + 4, WORLD.height - FOOD.radius - 4) });
    }
    return list;
}

// 玩家式：永远奔向最近的食物（真人不会更聪明）
class Forager extends Ball {
    // 只用于仿真：一步之内吃掉范围内的食物后不再处理（eat 在下面统一统计）
    step(dt, foodList) {
        let target = null;
        let best = Infinity;
        for (const food of foodList) {
            const d = distance(this.x, this.y, food.x, food.y);
            if (d < best) {
                best = d;
                target = food;
            }
        }
        const len = best || 1;
        this.speedX = ((target.x - this.x) / len) * JOYSTICK.radius;
        this.speedY = ((target.y - this.y) / len) * JOYSTICK.radius;
        super.update(dt, { width: WORLD.width, height: WORLD.height });
    }
}

function run(label, makeBall, gain) {
    const foodList = makeFoodField(FOOD.count);
    const ball = makeBall();
    const isPlayerStyle = ball instanceof Forager;
    const startMass = ball.mass;
    let eaten = 0;
    for (let step = 0; step < SECONDS / STEP; step += 1) {
        if (isPlayerStyle) {
            ball.step(STEP, foodList);
        } else {
            ball.update(STEP, { width: WORLD.width, height: WORLD.height }, [ball], foodList);
        }
        for (let i = foodList.length - 1; i >= 0; i -= 1) {
            if (ball.canEatFood(foodList[i].x, foodList[i].y)) {
                foodList.splice(i, 1);
                eaten += 1;
                ball.r += gain;
                foodList.push({
                    x: randomFloat(FOOD.radius + 4, WORLD.width - FOOD.radius - 4),
                    y: randomFloat(FOOD.radius + 4, WORLD.height - FOOD.radius - 4),
                });
            }
        }
    }
    const minutes = SECONDS / 60;
    console.log(`  ${label}：${SECONDS}s 内吃 ${eaten} 颗（${(eaten / minutes).toFixed(0)} 颗/分），`
        + `体重 ${Math.round(startMass)} → ${Math.round(ball.mass)} kg（半径 ${ball.r.toFixed(1)}）`);
    return { eaten, mass: ball.mass };
}

// 多次采样取平均：30 秒单局对 AI 决策来说是混沌系统的一次抽样，
// 不同参数会让路线发散、结果相差 20%+（实测 foragePower 0.95→1 比值从 0.77 掉到 0.67，
// 但那是单局噪声不是真实趋势）。flee-sim 靠 20 轮取平均，这里同理。
const TRIALS = flagValue('trials') ?? 1;
const BASE_SEED = 20261007;

function runTrial(label, makeBall, gain, seed) {
    rngSeed = seed;
    Math.random = () => {
        rngSeed = (rngSeed * 1103515245 + 12345) % 2147483648;
        return rngSeed / 2147483648;
    };
    return run(label, makeBall, gain);
}

console.log(`\n【觅食仿真】各跑 ${SECONDS} 秒 × ${TRIALS} 局（玩家球/AI 球都从 100kg 起）`);
const cx = WORLD.width / 2;
const cy = WORLD.height / 2;
let playerTotal = 0;
let aiTotal = 0;
for (let i = 0; i < TRIALS; i += 1) {
    const seed = BASE_SEED + i * 7919;
    const p = runTrial(`  [第 ${i + 1} 局] 玩家`, () => new Forager(cx, cy, PLAYER.radius, '#fff', 'p'), PLAYER.growthPerFood, seed);
    const a = runTrial(`  [第 ${i + 1} 局] AI`, () => new AiPlayer(cx, cy, PLAYER.radius, '#fff', 'ai'), AI.foodGain ?? PLAYER.growthPerFood, seed);
    playerTotal += p.eaten;
    aiTotal += a.eaten;
}
const avg = (v) => v / TRIALS;
console.log(`\n  平均：玩家 ${avg(playerTotal).toFixed(1)} 颗/局，AI ${avg(aiTotal).toFixed(1)} 颗/局`);
console.log(`  AI / 玩家 食物获取比：${(aiTotal / playerTotal).toFixed(3)}（>1 表示 AI 吃得比玩家快）`);