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

console.log(`\n【觅食仿真】各跑 ${SECONDS} 秒（玩家球/AI 球都从 100kg 起）`);
const playerResult = run('玩家（永远追最近的食物）', () => new Forager(512, 384, PLAYER.radius, '#fff', 'p'), PLAYER.growthPerFood);
const aiResult = run('AI（自带决策）', () => new AiPlayer(512, 384, PLAYER.radius, '#fff', 'ai'), AI.foodGain ?? PLAYER.growthPerFood);

console.log(`  AI / 玩家 食物获取比：${(aiResult.eaten / playerResult.eaten).toFixed(2)}（>1 表示 AI 吃得比玩家快）`);