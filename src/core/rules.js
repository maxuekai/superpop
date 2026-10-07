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
        // eatBonus 让 AI 吃人长得更明显（实测不吃倍率时互吃太稀疏、玩家几乎看不到）
        eater.absorb(victim, eater.eatBonus || 1);
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

// 名次：按传入的整组质量比（死亡时要用「死亡瞬间」的质量，不能用清空后的 0）。
// 注意不要写 cells[0].xxx：玩家全灭后 cells 是空数组，那会抛 TypeError，
// 而异常从 Game.loop 抛出后 rAF 链就断了，表现为整页卡死。
export function rankOfGroup(mass, others) {
    let rank = 1;
    for (const other of others) {
        if (other.alive && other.mass > mass) {
            rank += 1;
        }
    }
    return rank;
}

// 排行榜：玩家按整组质量算一条，AI 每个球一条，降序取前 N。
// 玩家已全灭（cells 为空）时不出现在榜上——名次由结算界面显示。
export function leaderboardEntries(cells, others, size = HUD.leaderboardSize) {
    const rows = others
        .filter((ball) => ball.alive)
        .map((ball) => ({ name: ball.name, weight: ball.mass, isPlayer: false }));
    if (cells.length > 0) {
        rows.push({ name: cells[0].name, weight: groupMass(cells), isPlayer: true });
    }
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

// 软碰撞：吃不掉彼此却已经重叠的球互推开（各退一半，推到刚好接触）。
// 不做这一步，大小相近的球会直接穿模叠在一起，AI 直冲过来看起来就像"撞到玩家"
// 却毫无效果；有了它，撞人只会把两球挤开——人类玩家也是同样的待遇。
// 同一 owner 的分身不走这里（它们靠 mergeCells 合并）。
// 调用前应先跑 resolveEatings：能吃的已经在那一帧死了，剩下需要推的都是吃不掉的关系。
export function resolveOverlaps(balls) {
    const pushed = [];
    for (let i = 0; i < balls.length; i += 1) {
        const a = balls[i];
        if (!a.alive) {
            continue;
        }
        for (let j = i + 1; j < balls.length; j += 1) {
            const b = balls[j];
            if (!b.alive || b.ownerId === a.ownerId) {
                continue;
            }
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            const minGap = a.r + b.r;
            if (d >= minGap) {
                continue;
            }
            if (d <= 0.001) {
                // 圆心重合：按名字给一个固定方向，避免除零
                a.x -= a.r;
                b.x += b.r;
            } else {
                const push = (minGap - d) / 2;
                const ux = dx / d;
                const uy = dy / d;
                a.x -= ux * push;
                a.y -= uy * push;
                b.x += ux * push;
                b.y += uy * push;
            }
            pushed.push(a, b);
        }
    }
    return pushed;
}

// ---------- 出生点 ----------
// 取一个当前没人用的昵称：AI 数量可能接近名字数量，纯随机抽必然出现两个「芋圆」，
// 玩家分不清谁是谁。名字全被占满时才退回随机。
export function pickFreeName(used, names) {
    const taken = new Set(used);
    const free = names.filter((name) => !taken.has(name));
    const pool = free.length > 0 ? free : names;
    return pool[Math.floor(Math.random() * pool.length)];
}

// 这个点是否落在相机视口之外（view = {x, y, w, h}，margin 为额外余量）。
// AI 出生/重生时优先挑这种位置，否则会在玩家眼前"凭空闪现"。
export function isOutsideView(pos, view, margin) {
    if (!view || !view.w || !view.h) {
        return true; // 视口还没算出来时不做限制
    }
    return pos.x < view.x - margin
        || pos.x > view.x + view.w + margin
        || pos.y < view.y - margin
        || pos.y > view.y + view.h + margin;
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