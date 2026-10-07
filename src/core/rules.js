import { AI, HUD, PLAYER } from '../config.js';
import { clamp, distance } from './utils.js';

// 玩法裁定层：把「一帧内发生什么」写成纯函数，不碰 canvas / DOM，
// 这样 scripts/rules-test.js 能直接在 node 里测整局流程，而不用起浏览器。
// Game 只负责调度（准备数据 → 调这里 → 处理结果/渲染）。

// 互吃裁定：返回本帧被吃掉的球，以及每个球吃掉了几个（用于击杀统计）。
// 三条规则：
//   ① 能吃 = 尺寸够（r > 对手r × EAT.ratio）且对手圆心进入自己体内；
//   ② **被吃掉的球这一帧不能再吃到别人**：先按本帧开始时的尺寸/位置把所有配对算完，
//      配对时就把已被吃掉的球排除出「吃人方」，最后统一结算。
//      否则会出现「A 吃 B、B 吃 C」的链式互吞，结果取决于 balls 数组顺序（同一局重放结果就变了）；
//   ③ 出生保护期（isProtected）内的球吃不掉。
// 注意：大球同时吃掉多个小球（一帧吃掉 B 和 C）是正常结果，不是链式互吞。
export function resolveEatings(balls, now) {
    const aliveAtStart = balls.filter((ball) => ball.alive);
    const victims = new Set();
    const pairs = [];

    // 第一阶段：配对。只看本帧开始的状态，已被吃掉的球不再作为吃人方。
    for (const victim of aliveAtStart) {
        if (victim.isProtected(now)) {
            continue;
        }
        for (const eater of aliveAtStart) {
            if (eater === victim || victims.has(eater)) {
                continue;
            }
            if (eater.canEatBall(victim)) {
                victims.add(victim);
                pairs.push([eater, victim]);
                break;
            }
        }
    }

    // 第二阶段：统一结算（质量吸收在这里才发生）
    const eaten = new Map();
    const eatenList = [];
    for (const [eater, victim] of pairs) {
        victim.alive = false;
        eatenList.push(victim);
        eater.absorb(victim);
        eaten.set(eater, (eaten.get(eater) || 0) + 1);
    }
    return { victims: eatenList, eaten };
}

// 吃食物：任何球经过就算吃到（各自按 foodGain 长大），被吃的食物立刻补一颗，总量恒定。
// makeFood 由调用方提供（Game 里要避开所有球、还要用到世界尺寸）。
// 返回新的食物列表与每球吃到几颗。
export function resolveFoodEating(foodList, balls, makeFood) {
    const kept = [];
    const eaten = new Map();
    for (const food of foodList) {
        let eater = null;
        for (const ball of balls) {
            if (ball.alive && ball.canEatFood(food.x, food.y)) {
                eater = ball;
                break;
            }
        }
        if (eater) {
            eater.r += eater.foodGain;
            eater.onEat();
            eaten.set(eater, (eaten.get(eater) || 0) + 1);
            kept.push(makeFood());
        } else {
            kept.push(food);
        }
    }
    return { foodList: kept, eaten };
}

// 名次：比它重的存活球数量 + 1。球已死亡时也算（例如结算界面要显示死亡那一刻的名次）。
export function rankOf(ball, balls) {
    let rank = 1;
    for (const other of balls) {
        if (other !== ball && other.alive && other.mass > ball.mass) {
            rank += 1;
        }
    }
    return rank;
}

// 排行榜：存活球按体重降序取前 N，玩家那条标记 isPlayer。
export function leaderboardEntries(balls, player, size = HUD.leaderboardSize) {
    return balls
        .filter((ball) => ball.alive)
        .sort((a, b) => b.mass - a.mass)
        .slice(0, size)
        .map((ball, index) => ({
            rank: index + 1,
            name: ball.name,
            weight: Math.round(ball.mass),
            isPlayer: ball === player,
        }));
}

// AI 数量目标：玩家越大场上对手越多，但不超 AI.count。
// 开局只按这个数放 AI，否则一上来满屏对手容易被围。
export function targetAiCount(playerRadius) {
    const growth = playerRadius / PLAYER.radius - 1;
    return clamp(AI.minCount + Math.floor(growth / 1.5), AI.minCount, AI.count);
}

// 超编时该踢掉哪些：优先移除最大的那几个（它们才是真正的压力来源）。
// 返回要移除的球，剩下的留在场上。
export function excessToRemove(aliveList, target) {
    const extra = aliveList.length - target;
    if (extra <= 0) {
        return [];
    }
    return aliveList.slice().sort((a, b) => b.r - a.r).slice(0, extra);
}

// 到点该重生的 AI：respawnAt 是世界时间；被设为 Infinity 表示已永久移除，不再重生。
export function dueRespawns(aiList, now) {
    return aiList.filter((ai) => !ai.alive && Number.isFinite(ai.respawnAt) && now >= ai.respawnAt);
}

// 出生点是否安全：远离所有存活的球，比目标大的留更宽的余量。
export function isSpawnClear(pos, radius, balls, extraGap = 24) {
    for (const ball of balls) {
        if (!ball.alive) {
            continue;
        }
        const gap = ball.r >= radius ? ball.r + radius + extraGap : radius * 2 + 12;
        if (distance(pos.x, pos.y, ball.x, ball.y) < gap) {
            return false;
        }
    }
    return true;
}