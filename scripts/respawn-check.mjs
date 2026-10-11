// 真机发现的问题：晚局死亡后重生，玩家回到 100kg，而 AI 还留在几百 kg。
// 量一下"重生后能活多久"，以及重生瞬间有几个 AI 吃得掉玩家。
// 直接跑 core/world.js 的无头世界（与单机 Game / 联机服务端同一份代码）——
// 旧版这里手搓过一份世界循环，曾经和真实现悄悄分叉。
import { pathToFileURL } from 'url';
const ROOT = 'file:///C:/Users/%E9%A3%8E%E4%BB%8E%E5%93%AA%E9%87%8C%E6%9D%A5/projects/superpop/src';

const cfg = await import(`${ROOT}/config.js`);
const { World } = await import(`${ROOT}/core/world.js`);
const { PLAYER } = cfg;

let seed = 998877;
Math.random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};

const STEP = 1 / 60;
const world = new World();
const group = world.addGroup('player', 'wo');
world.spawnAi(world.targetAiCount());
const playerAlive = () => group.cells.some((c) => c.alive);

// 阶段一：世界跑 4 分钟（玩家躲着不死——这里是站着不动），让 AI 长起来
for (let t = 0; t < 240 && playerAlive(); t += 1) {
    world.update(STEP);
}
const sizes = world.ai.filter((a) => a.alive).map((a) => Math.round(a.mass)).sort((x, y) => y - x);
console.log(`世界跑满 4 分钟后，场上 ${sizes.length} 个 AI 的质量（降序）：`);
console.log(`  ${sizes.join('  ')}`);
console.log(`  玩家当前 ${Math.round(group.cells[0].mass)}kg\n`);

// 阶段二：玩家每次都重生回 100kg。REBOOT=true 时模拟修复后的行为——
// 「再来一局」把 AI 全部拉回出生体型（world.reset()，Game.respawnPlayer 同款顺序）。
const REBOOT = process.argv.includes('--reboot');
const MOVE = process.argv.includes('--move');
console.log(`\n玩家死亡后重生回 100kg（${REBOOT ? '带修复：AI 一并重置' : '当前行为：AI 体型保留'}，`
    + `玩家${MOVE ? '随机游走' : '站着不动'}），重复 8 次：`);
console.log('次数 | 存活时长 | 当时最大AI | 吃得掉玩家的AI数');
console.log('-'.repeat(58));
for (let run = 1; run <= 8; run += 1) {
    world.respawnGroup('player');
    if (REBOOT) {
        world.reset();
    }
    group.cells[0].grantShield(PLAYER.spawnShield, world.time);
    // MOVE=true 时玩家随机游走（不是真人，但至少不是"站着等死"的最坏情况）
    group.input.speedX = MOVE ? (Math.random() * 140 - 70) : 0;
    group.input.speedY = MOVE ? (Math.random() * 140 - 70) : 0;
    let secs = 0;
    let eaters = 0;
    let topMass = 0;
    for (let t = 0; t < 60 && playerAlive(); t += 1) {
        world.update(STEP);
        secs = t + 1;
        const alive = world.ai.filter((a) => a.alive);
        topMass = Math.max(topMass, alive[0] ? alive[0].mass : 0);
        eaters = alive.filter((a) => a.outweighs(group.cells[0])).length;
    }
    console.log(
        `${String(run).padStart(4)} | ${`${secs}s${playerAlive() ? '(未死)' : ''}`.padStart(8)} | `
        + `${`${Math.round(topMass)}kg`.padStart(10)} | ${String(eaters).padStart(13)}`,
    );
}
