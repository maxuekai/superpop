// 真机发现的问题：晚局死亡后重生，玩家回到 100kg，而 AI 还留在几百 kg。
// 量一下"重生后能活多久"，以及重生瞬间有几个 AI 吃得掉玩家。
import { pathToFileURL } from 'url';
const ROOT = 'file:///C:/Users/%E9%A3%8E%E4%BB%8E%E5%93%AA%E9%87%8C%E6%9D%A5/projects/superpop/src';

const cfg = await import(`${ROOT}/config.js`);
const { Ball } = await import(`${ROOT}/core/ball.js`);
const { AiPlayer } = await import(`${ROOT}/core/ai.js`);
const rules = await import(`${ROOT}/core/rules.js`);
const utils = await import(`${ROOT}/core/utils.js`);
const { AI, FOOD, PLAYER, SPAWN, WORLD } = cfg;
const { distance, randomFloat, randomInt } = utils;
const STEP = 1 / 60;

let seed = 998877;
Math.random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};

const margin = FOOD.radius + 4 + FOOD.clusterRadius;
const posIn = (m) => ({ x: randomInt(WORLD.width - m * 2) + m, y: randomInt(WORLD.height - m * 2) + m });
function safeSpawn(radius, balls) {
    const m = radius + 8 + SPAWN.edgeGap;
    for (let a = 0; a < 60; a += 1) {
        const p = posIn(m);
        if (rules.isSpawnClear(p, radius, balls)) return p;
    }
    return posIn(m);
}
function spawnFood(balls) {
    let c = { x: 0, y: 0 };
    for (let a = 0; a < 8; a += 1) {
        c = posIn(margin);
        let clear = true;
        for (const b of balls) {
            if (b.alive && distance(c.x, c.y, b.x, b.y) < b.r + FOOD.avoidGap) { clear = false; break; }
        }
        if (clear) break;
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
    const p = safeSpawn(r, [player, ...ais]);
    const a = new AiPlayer(p.x, p.y, r, '#f00', `ai${ais.length}`);
    a.foodGain = AI.foodGain;
    ais.push(a);
}
for (let i = 0; i < rules.targetAiCount(player.r); i += 1) spawnAi();

let food = [];
for (let i = 0; i < FOOD.count; i += 1) food.push(spawnFood([player, ...ais]));

let time = 0;
let syncTimer = 0;
function step() {
    for (let s = 0; s < 60; s += 1) {
        time += STEP;
        player.update(STEP, WORLD);
        const all = [player, ...ais];
        for (const a of ais) if (a.alive) a.update(STEP, WORLD, all, food);
        const res = rules.resolveFoodEating(food, all, () => spawnFood(all));
        food = res.foodList;
        rules.resolveEatings(all, time);
        for (const a of ais) if (!a.alive && a.respawnAt === 0) a.respawnAt = time + AI.respawnDelay;
        for (const a of rules.dueRespawns(ais, time)) {
            const hi = Math.max(PLAYER.radius * 0.8,
                Math.min(PLAYER.radius * 2.2, player.r * AI.respawnRadiusRatio));
            const r = randomFloat(PLAYER.radius * 0.8, hi);
            const p = safeSpawn(r, [player, ...ais]);
            a.reset(p.x, p.y, r, '#f00');
            a.foodGain = AI.foodGain;
            a.targetBall = null;
            a.targetFood = null;
            a.escapeFood = null;
            a.grantShield(AI.respawnShield, time);
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
        if (!player.alive) {
            return;
        }
    }
}

// 阶段一：世界跑 4 分钟（玩家躲着不死），让 AI 长起来
for (let t = 0; t < 240 && player.alive; t += 1) step();
const sizes = ais.filter((a) => a.alive).map((a) => Math.round(a.mass)).sort((x, y) => y - x);
console.log(`世界跑满 4 分钟后，场上 ${sizes.length} 个 AI 的质量（降序）：`);
console.log(`  ${sizes.join('  ')}`);
console.log(`  玩家当前 ${Math.round(player.mass)}kg\n`);

// 阶段二：玩家每次都重生回 100kg。REBOOT=true 时模拟修复后的行为——
// 「再来一局」把 AI 全部拉回出生体型（Game.restartWorld）。
const REBOOT = process.argv.includes('--reboot');
const MOVE = process.argv.includes('--move');
console.log(`\n玩家死亡后重生回 100kg（${REBOOT ? '带修复：AI 一并重置' : '当前行为：AI 体型保留'}，`
    + `玩家${MOVE ? '随机游走' : '站着不动'}），重复 8 次：`);
console.log('次数 | 存活时长 | 当时最大AI | 吃得掉玩家的AI数');
console.log('-'.repeat(58));
for (let run = 1; run <= 8; run += 1) {
    if (REBOOT) {
        // Game.restartWorld：AI 全部回出生体型
        ais.length = 0;
        for (let i = 0; i < rules.targetAiCount(PLAYER.radius); i += 1) spawnAi();
        food = [];
        for (let i = 0; i < FOOD.count; i += 1) food.push(spawnFood([player, ...ais]));
    }
    player.alive = true;
    const p = safeSpawn(PLAYER.radius, [player, ...ais]);
    player.reset(p.x, p.y, PLAYER.radius, '#fff');
    player.grantShield(PLAYER.spawnShield, time);
    // MOVE=true 时玩家随机游走（不是真人，但至少不是"站着等死"的最坏情况）
    player.speedX = MOVE ? randomFloat(-70, 70) : 0;
    player.speedY = MOVE ? randomFloat(-70, 70) : 0;
    let secs = 0;
    let eaters = 0;
    let topMass = 0;
    for (let t = 0; t < 60 && player.alive; t += 1) {
        step();
        secs = t + 1;
        const alive = ais.filter((a) => a.alive);
        topMass = Math.max(topMass, alive[0] ? alive[0].mass : 0);
        eaters = alive.filter((a) => a.outweighs(player)).length;
    }
    console.log(
        `${String(run).padStart(4)} | ${`${secs}s${player.alive ? '(未死)' : ''}`.padStart(8)} | `
        + `${`${Math.round(topMass)}kg`.padStart(10)} | ${String(eaters).padStart(13)}`,
    );
}