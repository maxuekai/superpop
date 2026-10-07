import { AI, HUD, PLAYER, SPLIT } from '../config.js';
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

// 名次：按"整组质量"比。cells 是玩家那一组（可能已全灭，此时也算），others 是别人的球。
// 例：结算界面要显示死亡那一刻的名次，所以 cells 全灭时也要能算。
export function rankOfGroup(cells, others) {
    const total = groupMass(cells);
    let rank = 1;
    for (const other of others) {
        if (other.alive && other.ownerId !== cells[0].ownerId && other.mass > total) {
            rank += 1;
        }
    }
    return rank;
}

// 排行榜：玩家按整组质量算一条，AI 每个球一条，降序取前 N。
export function leaderboardEntries(cells, others, size = HUD.leaderboardSize) {
    const total = groupMass(cells);
    const rows = others
        .filter((ball) => ball.alive && ball.ownerId !== cells[0].ownerId)
        .map((ball) => ({ name: ball.name, weight: ball.mass, isPlayer: false }));
    rows.push({ name: cells[0].name, weight: total, isPlayer: true });
    return rows
        .sort((a, b) => b.weight - a.weight)
        .slice(0, size)
        .map((row, index) => ({
            rank: index + 1,
            name: row.name,
            weight: Math.round(row.weight),
            isPlayer: row.isPlayer,
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

// ---------- 分裂 / 合并（玩家可以有多个细胞） ----------
// 一个"细胞组"= 同一 ownerId 的所有存活细胞。质量守恒：分裂只是把质量对半分。

// 整组质量（体重面板、排行榜都用这个口径，不是单个细胞的半径平方）
export function groupMass(cells) {
    let total = 0;
    for (const cell of cells) {
        if (cell.alive) {
            total += cell.mass;
        }
    }
    return total;
}

// 现在能不能分裂：需要有够大的细胞，且冷却结束，且没超过细胞数上限
export function canSplit(cells, now, lastSplitAt) {
    if (now - lastSplitAt < SPLIT.cooldown) {
        return false;
    }
    if (cells.length >= SPLIT.maxCells) {
        return false;
    }
    return cells.some((cell) => cell.alive && cell.r >= SPLIT.minCellRadius);
}

// 分裂：把所有够大的细胞一切两半，朝当前移动方向的垂直方向分开（避免挡住去路）。
// makeCell(x, y, r, from) 由调用方提供（Player 实例 / 随机颜色）。
// 返回新的细胞数组（原数组不动，方便测试与回滚）。
export function splitCells(cells, dirX, dirY, makeCell) {
    const out = [];
    const length = Math.sqrt(dirX * dirX + dirY * dirY);
    // 移动方向为单位向量时，分开方向取其垂直方向；没有输入就用 x 轴
    const ux = length > 0.0001 ? dirX / length : 1;
    const uy = length > 0.0001 ? dirY / length : 0;
    const px = -uy;
    const py = ux;

    for (const cell of cells) {
        if (!cell.alive || cell.r < SPLIT.minCellRadius) {
            out.push(cell);
            continue;
        }
        // 原来的球自己变成一半（保持对象引用：镜头/重生逻辑都指着它），
        // 另一半是新球；两半各得一半质量，总量守恒。
        const half = Math.sqrt(cell.mass / 2);
        const gap = cell.r * 0.35;
        const originX = cell.x;
        const originY = cell.y;
        cell.r = half;
        cell.x = originX - px * gap;
        cell.y = originY - py * gap;
        out.push(cell);
        out.push(makeCell(originX + px * gap, originY + py * gap, half, cell));
    }
    return out;
}

// 合并：同一 owner 的两个细胞靠得太近、且过了合并冷却，就并回一个（质量相加）。
// 返回 { cells, merged }；merged 是本帧发生了几次合并（给动画/音效用）。
export function mergeCells(cells, now) {
    const out = [];
    let merged = 0;
    for (const cell of cells) {
        if (!cell.alive) {
            continue;
        }
        // 已在本帧并过别人的，跳过（避免一次吞掉三个）
        const partner = out.find((other) => other.alive
            && other.ownerId === cell.ownerId
            && now >= Math.max(other.mergeAfter, cell.mergeAfter)
            && distance(other.x, other.y, cell.x, cell.y) < (other.r + cell.r) * SPLIT.mergeFactor);
        if (partner) {
            partner.r = Math.sqrt(partner.mass + cell.mass);
            partner.mergeAfter = now;
            merged += 1;
            continue;
        }
        out.push(cell);
    }
    return { cells: out, merged };
}

// ---------- 出生点 ----------
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