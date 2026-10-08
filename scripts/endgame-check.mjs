// 终局体检：单局的终点（称王）是不是真的够得到。
//
// 回答两个问题：
//   ① AI 会不会滚雪球到玩家追不上的量级？——那会让玩家永远当不了第一，终点形同虚设
//   ② 玩家会不会长到"比整个世界还大"？——Ball.update 的边界钳制在 r > world.width 时
//      会把球心硬推到 r（界外），相机的视口被 clamp 在世界内，于是球永远在屏幕外。
//      正常玩到不了（称王 r=173 就结束），但这是缺一道保险。
//
// 用法：node scripts/endgame-check.mjs
// 改 KING.mass / WORLD / EAT.ratio / AI.eatBonus 之后跑一次。
// 判据：①「被 AI 卡住」不该出现在表里；② 称王应该在玩家质量远小于世界面积量级时发生。
import { pathToFileURL } from 'url';
const ROOT = 'file:///C:/Users/%E9%A3%8E%E4%BB%8E%E5%93%AA%E9%87%8C%E6%9D%A5/projects/superpop/src';

const cfg = await import(`${ROOT}/config.js`);
const { Ball } = await import(`${ROOT}/core/ball.js`);
const { AiPlayer } = await import(`${ROOT}/core/ai.js`);
const rules = await import(`${ROOT}/core/rules.js`);
const utils = await import(`${ROOT}/core/utils.js`);
const { AI, FOOD, KING, PLAYER, WORLD } = cfg;
const { distance, randomFloat, randomInt } = utils;
const STEP = 1 / 60;

let seed = 20261008;
Math.random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};

const margin = FOOD.radius + 4 + FOOD.clusterRadius;
const posIn = (m) => ({ x: randomInt(WORLD.width - m * 2) + m, y: randomInt(WORLD.height - m * 2) + m });
function spawnFood(balls) {
    let c = { x: 0, y: 0 };
    for (let a = 0; a < 8; a += 1) {
        c = posIn(margin);
        let clean = true;
        for (const b of balls) {
            if (b.alive && distance(c.x, c.y, b.x, b.y) < b.r + FOOD.avoidGap) { clean = false; break; }
        }
        if (clean) break;
    }
    const off = utils.clusterOffset(FOOD.clusterRadius);
    return {
        x: Math.max(FOOD.radius + 2, Math.min(c.x + off.dx, WORLD.width - FOOD.radius - 2)),
        y: Math.max(FOOD.radius + 2, Math.min(c.y + off.dy, WORLD.height - FOOD.radius - 2)),
    };
}

const player = new Ball(WORLD.width / 2, WORLD.height / 2, PLAYER.radius, '#fff', 'wo', 'player');
const ais = [];
function spawnAi() {
    const hi = Math.max(PLAYER.radius * AI.spawnRadiusMin,
        Math.min(PLAYER.radius * AI.spawnRadiusMax, player.r * AI.spawnRadiusRatio));
    const r = randomFloat(PLAYER.radius * AI.spawnRadiusMin, hi);
    const p = posIn(r + 8 + 90);
    const a = new AiPlayer(p.x, p.y, r, '#f00', `ai${ais.length}`);
    a.foodGain = AI.foodGain;
    ais.push(a);
}
for (let i = 0; i < rules.targetAiCount(player.r); i += 1) spawnAi();

let food = [];
for (let i = 0; i < FOOD.count; i += 1) food.push(spawnFood([player, ...ais]));

console.log(`玩家正常发育 + AI 互吞 + syncAiCount + 重生。KING.mass=${KING.mass}\n`);
console.log('时间 | 玩家质量  | 最大AI质量 | 最大AI半径 | AI存活 | 已移除 | 称王状态');
console.log('-'.repeat(88));
let syncTimer = 0;
for (let t = 0; t <= 900; t += 1) {
    for (let s = 0; s < 60; s += 1) {
        const now = t + s * STEP;
        let best = null;
        let bd = Infinity;
        for (const f of food) {
            const d = distance(player.x, player.y, f.x, f.y);
            if (d < bd) { bd = d; best = f; }
        }
        if (best) {
            const len = bd || 1;
            player.speedX = ((best.x - player.x) / len) * 70;
            player.speedY = ((best.y - player.y) / len) * 70;
        }
        player.update(STEP, WORLD);
        const all = [player, ...ais];
        for (const a of ais) if (a.alive) a.update(STEP, WORLD, all, food);

        const res = rules.resolveFoodEating(food, all, () => spawnFood(all));
        food = res.foodList;
        rules.resolveEatings(all, now);
        for (const a of ais) if (!a.alive && a.respawnAt === 0) a.respawnAt = now + AI.respawnDelay;
        for (const a of rules.dueRespawns(ais, now)) {
            const hi = Math.max(PLAYER.radius * 0.8,
                Math.min(PLAYER.radius * 2.2, player.r * AI.respawnRadiusRatio));
            a.reset(posIn(PLAYER.radius + 98).x, posIn(PLAYER.radius + 98).y,
                randomFloat(PLAYER.radius * 0.8, hi), '#f00');
            a.foodGain = AI.foodGain;
            a.targetBall = null;
            a.targetFood = null;
            a.escapeFood = null;
        }
        syncTimer -= STEP;
        if (syncTimer <= 0) {
            syncTimer = AI.syncInterval;
            const alive = ais.filter((a) => a.alive);
            const target = rules.targetAiCount(player.r);
            let missing = target - alive.length;
            while (missing > 0 && ais.length < AI.count) { spawnAi(); missing -= 1; }
            for (const v of rules.excessToRemove(alive, target)) {
                v.alive = false;
                v.respawnAt = Infinity;
                ais.splice(ais.indexOf(v), 1);
            }
        }
    }
    if (t % 60 === 0) {
        const alive = ais.filter((a) => a.alive).sort((x, y) => y.mass - x.mass);
        const top = alive[0];
        const topMass = top ? Math.round(top.mass) : 0;
        const status = (player.mass >= KING.mass && topMass < player.mass)
            ? '可以称王'
            : (topMass >= KING.mass ? '被 AI 卡住' : '还没到线');
        console.log(
            `${String(t).padStart(4)}s | ${String(Math.round(player.mass)).padStart(8)}kg | `
            + `${String(topMass).padStart(10)}kg | ${(top ? top.r.toFixed(0) : 0).padStart(9)} | `
            + `${String(alive.length).padStart(5)} | ${String(AI.count - ais.length).padStart(6)} | `
            + `${status.padStart(12)}`,
        );
    }
}
