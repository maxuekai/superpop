// 终局体检：单局的终点（称王）是不是真的够得到。
//
// 回答两个问题：
//   ① AI 会不会滚雪球到玩家追不上的量级？——那会让玩家永远当不了第一，终点形同虚设
//   ② 玩家会不会长到"比整个世界还大"？——Ball.update 的边界钳制在 r > world.width 时
//      会把球心硬推到 r（界外），相机的视口被 clamp 在世界内，于是球永远在屏幕外。
//      正常玩到不了（称王 r=173 就结束），但这是缺一道保险。
//
// 直接跑 core/world.js 的无头世界（与单机 Game / 联机服务端同一份代码）。
// 用法：node scripts/endgame-check.mjs
// 改 KING.mass / WORLD / EAT.ratio / AI.eatBonus 之后跑一次。
// 判据：①「被 AI 卡住」不该出现在表里；② 称王应该在玩家质量远小于世界面积量级时发生。
import { pathToFileURL } from 'url';
const ROOT = 'file:///C:/Users/%E9%A3%8E%E4%BB%8E%E5%93%AA%E9%87%8C%E6%9D%A5/projects/superpop/src';

const cfg = await import(`${ROOT}/config.js`);
const { World } = await import(`${ROOT}/core/world.js`);
const { distance } = await import(`${ROOT}/core/utils.js`);
const { AI, KING } = cfg;
const STEP = 1 / 60;

let seed = 20261008;
Math.random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};

const world = new World();
const group = world.addGroup('player', 'wo');
world.spawnAi(world.targetAiCount());

console.log(`玩家正常发育 + AI 互吞 + syncAiCount + 重生。KING.mass=${KING.mass}\n`);
console.log('时间 | 玩家质量  | 最大AI质量 | 最大AI半径 | AI存活 | 已移除 | 称王状态');
console.log('-'.repeat(88));
for (let t = 0; t <= 900; t += 1) {
    for (let s = 0; s < 60; s += 1) {
        // 直线觅食：朝最近的食物满舵走（不是真人走位，但足以喂出成长曲线）
        const me = group.cells[0];
        let best = null;
        let bd = Infinity;
        for (const f of world.foodList) {
            const d = distance(me.x, me.y, f.x, f.y);
            if (d < bd) {
                bd = d;
                best = f;
            }
        }
        if (best) {
            const len = bd || 1;
            group.input.speedX = ((best.x - me.x) / len) * 70;
            group.input.speedY = ((best.y - me.y) / len) * 70;
        }
        world.update(STEP);
    }
    if (t % 60 === 0) {
        const alive = world.ai.filter((a) => a.alive).sort((x, y) => y.mass - x.mass);
        const top = alive[0];
        const topMass = top ? Math.round(top.mass) : 0;
        const myMass = Math.round(group.cells[0].mass);
        const status = (myMass >= KING.mass && topMass < myMass)
            ? '可以称王'
            : (topMass >= KING.mass ? '被 AI 卡住' : '还没到线');
        console.log(
            `${String(t).padStart(4)}s | ${String(myMass).padStart(8)}kg | `
            + `${String(topMass).padStart(10)}kg | ${(top ? top.r.toFixed(0) : 0).padStart(9)} | `
            + `${String(alive.length).padStart(5)} | ${String(AI.count - world.ai.length).padStart(6)} | `
            + `${status.padStart(12)}`,
        );
    }
}
