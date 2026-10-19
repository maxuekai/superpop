import { AI, COLORS, FOOD, NAMES, PLAYER, SPAWN, SPLIT, WORLD } from '../config.js';
import { AiPlayer } from './ai.js';
import { Player } from './player.js';
import {
    dueRespawns,
    excessToRemove,
    groupMass,
    isCrowned,
    isOutsideView,
    isSpawnClear,
    leaderboardEntries,
    mergeCells,
    pickFreeName,
    rankOfGroup,
    resolveEatings,
    resolveFoodEating,
    resolveOverlaps,
    splitCells,
    splitStatus,
    targetAiCount,
} from './rules.js';
import { clamp, clusterOffset, distance, randomFloat, randomInt, randomItem } from './utils.js';
import { log } from './log.js';

// 无头世界：食物 / AI / 玩家组 / 互吃 / 分裂 / 重生 / 称王判定，全部玩法逻辑都在这里，
// 不碰 canvas / camera / hud / DOM —— 单机的 Game 与联机的服务端跑同一份代码。
//
// 「玩家组」= 同一个真人的全部细胞（含分裂分身），按 ownerId 索引：
//   · 单机只有一个组（PLAYER_OWNER）；联机服务端每个连接 addGroup 一个组。
//   · 组内分身彼此不互吃、输入共享、排行榜按整组质量折成一条。
// 被吃掉的细胞**留在 group.cells 里（alive=false）**：镜头在死亡演出期间要跟着
// 死球的位置定格，消费方（质量/排行/分裂/绘制）一律按 alive 过滤。
//
// 事件走 onEvent 回调（不直接调 hud）：World 只报告发生了什么，怎么演（慢放/结算/
// 红闪）是表现层的事。事件形状：
//   { type: 'eaten',   ownerId, mass, rank, by }  —— 某组被全灭（mass 是死亡瞬间的质量）
//   { type: 'crowned', ownerId }                  —— 某组质量达标且当前第一
export class World {
    constructor(options = {}) {
        this.world = { width: WORLD.width, height: WORLD.height };
        this.time = 0; // 世界时间（秒）：AI 重生倒计时、分裂冷却、出生保护都用它
        this.foodList = [];
        this.ai = []; // 全部 AI（含已死等待重生的）
        this.groups = new Map(); // ownerId -> 玩家组
        this.balls = []; // 碰撞列表 = 各组存活分身 + 全部 AI，每帧遍历这一份

        // 出生点「优先避开视野」要用视口：Game 传相机视口，服务端不传（= 不挑剔）。
        // 提成可选依赖而不是参数，是为了让 update() 的调用方不用每帧传一堆东西。
        this.getViewRect = options.getViewRect || null;
        this.onEvent = options.onEvent || (() => {});
        // AI 分裂总开关（开局界面的「AI 分裂」开关）：默认开。
        // ⚠ 这是玩家偏好、**不是 config 数值**——进 config.js 会被算进 configHash，
        // 单机玩过的偏好会让联机 join 时两端哈希不一致、被自己人拒绝。
        // 联机服务端不传这个参数，恒为开。
        this.aiSplit = options.aiSplit !== false;
        this.syncTimer = 0;
        // roster 变更标记（AI 出生/重生改名/超编移除、玩家改名）：联机服务端读完清掉，
        // 随下一快照周期广播一次 roster。纯逻辑层只管置位，不碰网络。
        this.rosterDirty = false;

        this.seedFood();
    }

    // ---------- 玩家组 ----------

    // 加一个玩家组：落一个安全出生点（不与任何球重叠，且尽量挑人少的位置）。
    // **不发出生保护**——保护从「真正进场」那一刻起算（单机是 begin()/respawnPlayer()，
    // 联机是服务端放行时），调用方拿到返回的组后自己 grantShield。
    addGroup(ownerId, name) {
        const pos = this.safeSpawnPosition(PLAYER.radius, SPAWN.edgeGap, false, true);
        const cell = new Player(name, ownerId);
        cell.x = pos.x;
        cell.y = pos.y;
        const group = {
            ownerId,
            name,
            cells: [cell],
            input: { speedX: 0, speedY: 0 }, // 输入向量由外部写进来（摇杆/键盘/网络）
            lastSplitAt: -Infinity,
            stats: { playTime: 0, foodEaten: 0, kills: 0 },
        };
        this.groups.set(ownerId, group);
        this.rebuildBalls();
        return group;
    }

    // 重生一个组：全新细胞、安全出生点、质量/分身/冷却/统计全部清零。
    // 同样不发出生保护（调用方发）。名字不传就沿用旧名。
    respawnGroup(ownerId, name) {
        const group = this.groups.get(ownerId);
        if (!group) {
            return null;
        }
        if (name) {
            group.name = name;
            this.rosterDirty = true; // 联机：改名要随下一快照周期广播 roster
        }
        // 稀疏优先：重生挑离所有球都远的位置（联机真机反馈"重生在少人的地方"）
        const pos = this.safeSpawnPosition(PLAYER.radius, SPAWN.edgeGap, false, true);
        const cell = new Player(group.name, ownerId);
        cell.x = pos.x;
        cell.y = pos.y;
        group.cells = [cell];
        group.lastSplitAt = -Infinity;
        group.input.speedX = 0;
        group.input.speedY = 0;
        group.stats = { playTime: 0, foodEaten: 0, kills: 0 };
        this.rebuildBalls();
        return group;
    }

    renameGroup(ownerId, name) {
        const group = this.groups.get(ownerId);
        if (!group || !name) {
            return;
        }
        group.name = name;
        for (const cell of group.cells) {
            cell.name = name;
        }
    }

    // 移除一个玩家组（联机：玩家断线）。细胞随之从碰撞列表消失，AI 重新补位由
    // syncAiCount 按「剩余最大人类体型」自然收敛，不需要额外处理。
    removeGroup(ownerId) {
        if (!this.groups.delete(ownerId)) {
            return false;
        }
        this.rebuildBalls();
        return true;
    }

    // 人类阵营的「发展水平」：整组质量开根成等价半径。**不能用最大分身的半径**——
    // 分裂是质量守恒的，最大分身会瞬间减半；拿它当口径的话，一次分裂就让
    // targetAiCount 跨过下档边界、超编机制当场永久移除最大的 AI——玩家在追的
    // 人机追着追着就消失了（真机反馈 + 无头复现：分裂后 9→8）。
    // 整组质量分裂不变、死亡归零（死后 AI 按新出生体型重新平衡），正是想要的语义。
    developmentRadius() {
        let best = 0;
        for (const group of this.groups.values()) {
            best = Math.max(best, Math.sqrt(groupMass(group.cells)));
        }
        return best || PLAYER.radius;
    }

    // 分身/组增减后要重建碰撞列表（数量很少，直接重算最不容易出错）
    rebuildBalls() {
        const cells = [];
        for (const group of this.groups.values()) {
            for (const cell of group.cells) {
                if (cell.alive) {
                    cells.push(cell);
                }
            }
        }
        this.balls = [...cells, ...this.ai];
    }

    // 请求分裂：冷却 / 门槛 / 分身上限的完整把关在这里（rules.splitStatus），
    // 服务端对每个 split 消息都走这一个入口，不存在"忘了查就烧掉冷却"的路径。
    // 返回 false = 没分成（球太小 / 冷却中 / 已达上限 / 组不存在），调用方无需重复判断。
    requestSplit(ownerId) {
        const group = this.groups.get(ownerId);
        if (!group) {
            return false;
        }
        if (!splitStatus(group.cells, this.time, group.lastSplitAt).canSplit) {
            return false;
        }
        const { speedX, speedY } = group.input;
        group.cells = splitCells(group.cells, speedX, speedY, (x, y, r, from) => {
            const cell = new Player(group.name, ownerId);
            cell.x = x;
            cell.y = y;
            cell.r = r;
            cell.bColor = from.bColor;
            cell.mergeAfter = this.time + SPLIT.mergeCooldown;
            return cell;
        });
        group.lastSplitAt = this.time;
        for (const cell of group.cells) {
            cell.mergeAfter = this.time + SPLIT.mergeCooldown;
        }
        this.rebuildBalls();
        return true;
    }

    // ---------- 出生与生成 ----------

    // 地图内随机一点（带边距）
    randomPosition(margin) {
        return {
            x: margin + randomInt(this.world.width - margin * 2),
            y: margin + randomInt(this.world.height - margin * 2),
        };
    }

    // 找一个不会「一出生就被吃掉」的空位：判定交给 rules.isSpawnClear，
    // 这里只负责多试几次；margin 还要让出生点远离世界边缘，
    // 否则相机会被钳在边上、球偏在屏幕一角。
    // preferOffscreen=true 时优先挑视口之外的点——AI 在你眼前凭空出现会很像"闪现"。
    // preferSparse=true 时不取第一个空位，而是在候选里挑「离最近存活球的边缘最远」的：
    // 玩家重生/进场用——同样的安全，但天然落在人少的位置（真机反馈）。
    safeSpawnPosition(radius, edgeGap = SPAWN.edgeGap, preferOffscreen = false, preferSparse = false) {
        const margin = radius + 8 + edgeGap;
        // 视口只在真的要"避开视野"时才取——构造早期（相机还没建）玩家组落子会走到这里，
        // 无条件取就会炸；服务端不传 getViewRect，这里天然是 null。
        const view = preferOffscreen && this.getViewRect ? this.getViewRect() : null;
        let fallback = null;
        let best = null;
        let bestClearance = -Infinity;
        for (let attempt = 0; attempt < 60; attempt += 1) {
            const pos = this.randomPosition(margin);
            if (fallback === null) {
                fallback = pos;
            }
            if (!isSpawnClear(pos, radius, this.balls)) {
                continue;
            }
            if (preferOffscreen && attempt < 40 && !isOutsideView(pos, view, SPAWN.edgeGap)) {
                continue; // 前 40 次都在找屏幕外的位置
            }
            if (!preferSparse) {
                return pos;
            }
            let clearance = Infinity;
            for (const ball of this.balls) {
                if (!ball.alive) {
                    continue;
                }
                const d = distance(pos.x, pos.y, ball.x, ball.y) - ball.r;
                if (d < clearance) {
                    clearance = d;
                }
            }
            if (clearance > bestClearance) {
                bestClearance = clearance;
                best = pos;
            }
        }
        if (preferSparse && best) {
            return best;
        }
        return fallback || this.randomPosition(margin);
    }

    // 造一颗食物（位置/颜色由调用方决定）：带上各自的绘制半径抖动，见 config.FOOD.radiusJitter
    makeFood(x, y, color) {
        return {
            x: clamp(x, FOOD.radius + 2, this.world.width - FOOD.radius - 2),
            y: clamp(y, FOOD.radius + 2, this.world.height - FOOD.radius - 2),
            color,
            radius: FOOD.radius * (1 + randomFloat(-FOOD.radiusJitter, FOOD.radiusJitter)),
        };
    }

    // 找一个避开所有球的簇心（远离球身 foodGap 以上）；重试 8 次后放弃挑剔
    foodClusterCenter() {
        const margin = FOOD.radius + 4 + FOOD.clusterRadius;
        let center = this.randomPosition(margin);
        for (let attempt = 0; attempt < 8; attempt += 1) {
            center = this.randomPosition(margin);
            let clear = true;
            for (const ball of this.balls) {
                if (ball.alive && distance(center.x, center.y, ball.x, ball.y) < ball.r + FOOD.avoidGap) {
                    clear = false;
                    break;
                }
            }
            if (clear) {
                break;
            }
        }
        return center;
    }

    // 生成一簇食物：整簇共享簇心与颜色，每颗落在簇半径内。
    // 同簇一个颜色，「成片」才扫得出来——逐颗随机色（旧行为）糊成彩屑，手机上尤其明显。
    spawnCluster(count) {
        const center = this.foodClusterCenter();
        const color = randomItem(COLORS);
        const foods = [];
        for (let i = 0; i < count; i += 1) {
            const offset = clusterOffset(FOOD.clusterRadius);
            foods.push(this.makeFood(center.x + offset.dx, center.y + offset.dy, color));
        }
        return foods;
    }

    // 被吃掉的单颗重生：默认贴着一颗幸存食物落子并继承它的颜色——
    // 簇被吃掉一部分后能从邻居「长回来」，而不是退化成随机散点（颜色一杂成片感就没了）。
    // 但纯邻居锚定有个盲区：某片区域被吃光后就永远没有锚点，区域会永久空掉
    // （实测 8 个 AI 吃 6 分钟，96% 的格子空掉、食物堆进一两个格子）。
    // 所以按 FOOD.emptyRegionBias 的概率把重生改投「当前最空的格子」——给空区播种，
    // 播下去的种子之后又能被邻居锚定长成簇。
    spawnFood() {
        if (Math.random() < FOOD.emptyRegionBias) {
            const pos = this.sparsestFoodPosition();
            return this.makeFood(pos.x, pos.y, randomItem(COLORS));
        }
        const anchor = this.foodList.length > 0 ? randomItem(this.foodList) : null;
        if (!anchor) {
            return this.spawnCluster(1)[0];
        }
        const offset = clusterOffset(FOOD.clusterRadius);
        return this.makeFood(anchor.x + offset.dx, anchor.y + offset.dy, anchor.color);
    }

    // 8×8 粗网格数一遍当前食物分布，返回「食物最少的格子」里随机一点。
    // 每次重生都全量数一遍（747 次循环）在重生频率（每秒十几颗）下可忽略。
    sparsestFoodPosition() {
        const G = 8;
        const cellW = this.world.width / G;
        const cellH = this.world.height / G;
        const counts = new Array(G * G).fill(0);
        for (const food of this.foodList) {
            const gx = Math.min(G - 1, Math.floor(food.x / cellW));
            const gy = Math.min(G - 1, Math.floor(food.y / cellH));
            counts[gy * G + gx] += 1;
        }
        let min = Infinity;
        for (const c of counts) {
            min = Math.min(min, c);
        }
        const empties = [];
        for (let i = 0; i < counts.length; i += 1) {
            if (counts[i] === min) {
                empties.push(i);
            }
        }
        const pick = empties[randomInt(empties.length)];
        return {
            x: (pick % G) * cellW + randomFloat(0, cellW),
            y: Math.floor(pick / G) * cellH + randomFloat(0, cellH),
        };
    }

    // 开局铺场：按簇铺满 FOOD.count，最后一簇不足额就少放几颗
    seedFood() {
        this.foodList = [];
        while (this.foodList.length < FOOD.count) {
            const n = Math.min(FOOD.clusterSize, FOOD.count - this.foodList.length);
            this.foodList.push(...this.spawnCluster(n));
        }
    }

    // 抽一个当前没人用的昵称（同屏出现两个同名会让玩家分不清，规则见 rules.pickFreeName）。
    // 真人的名字也算"已占用"：AI 叫得跟场上玩家一样，玩家分不清谁是谁。
    pickAiName() {
        const used = [];
        for (const group of this.groups.values()) {
            used.push(group.name);
        }
        for (const ai of this.ai) {
            if (ai.alive) {
                used.push(ai.name);
            }
        }
        return pickFreeName(used, NAMES);
    }

    // AI 出生半径：跟着场上最大的人类细胞取样（单机就是玩家；分裂后取最大的分身，
    // 否则会被低估）
    // AI 出生半径：跟着场上人类的发展水平取样（整组质量口径，分裂不变；
    // 分裂后取样的 AI 不会突然变小）
    aiSpawnRadius(ratio) {
        const min = PLAYER.radius * AI.spawnRadiusMin;
        const max = Math.max(min, Math.min(PLAYER.radius * AI.spawnRadiusMax, this.developmentRadius() * ratio));
        return randomFloat(min, max);
    }

    spawnAi(count = 1) {
        for (let i = 0; i < count; i += 1) {
            const r = this.aiSpawnRadius(AI.spawnRadiusRatio);
            const pos = this.safeSpawnPosition(r, SPAWN.edgeGap, true);
            const ai = new AiPlayer(pos.x, pos.y, r, randomItem(COLORS), this.pickAiName());
            ai.foodGain = AI.foodGain;
            this.ai.push(ai);
            this.balls.push(ai);
            this.rosterDirty = true;
        }
    }

    // AI 数量随场上人类的发展水平动态调整：人越大对手越多，但不超过 AI.count
    // （公式见 rules.js；口径是 developmentRadius——整组质量，分裂不变）
    targetAiCount() {
        return targetAiCount(this.developmentRadius());
    }

    syncAiCount() {
        // 数量口径是「实体」不是「细胞」：分裂分身不算新 AI，
        // 否则一个刚分裂的 AI 会被当成两个对手、超编机制马上踢人。
        const alive = this.ai.filter((ai) => ai.alive && !ai.leader);
        const target = this.targetAiCount();

        // 不足就补（补到 AI.count 为上限）。上限口径也是实体：数主脑
        // （含等重生的），分身不占名额——否则「6 个实体各分 4 颗 = 24 细胞」
        // 会把补给卡死，场上实体永远补不齐。
        let total = this.ai.filter((ai) => !ai.leader).length;
        let missing = target - alive.length;
        while (missing > 0 && total < AI.count) {
            this.spawnAi(1);
            total += 1;
            missing -= 1;
        }

        // 超编就悄悄收掉最大的那几个实体（永久移除，不再重生）。
        // 分裂实体的分身跟着主脑一起走——玩家眼里这是一个球，不能拆散。
        const removed = excessToRemove(alive, target);
        if (removed.length > 0) {
            log('数量', `超编永久移除 ${removed.length} 个 AI（不是被吃）：`
                + removed.map((v) => `${v.name} r=${v.r.toFixed(0)}`).join('、'), 'warn');
        }
        for (const victim of removed) {
            for (const cell of this.ai) {
                if (cell.ownerId === victim.ownerId) {
                    cell.alive = false;
                    cell.respawnAt = Infinity;
                }
            }
            this.ai = this.ai.filter((ai) => ai.ownerId !== victim.ownerId);
            this.balls = this.balls.filter((ball) => ball.ownerId !== victim.ownerId);
            this.rosterDirty = true;
        }
    }

    respawnAi(ai) {
        const r = this.aiSpawnRadius(AI.respawnRadiusRatio);
        const pos = this.safeSpawnPosition(r, SPAWN.edgeGap, true);
        ai.reset(pos.x, pos.y, r, randomItem(COLORS));
        ai.foodGain = AI.foodGain;
        ai.name = this.pickAiName();
        ai.targetBall = null;
        ai.targetFood = null;
        ai.escapeFood = null;
        // 重生成全新实体：回到单细胞主脑，分裂冷却清零（与玩家组 respawnGroup 同语义）
        ai.leader = null;
        ai.lastSplitAt = -Infinity;
        ai.splitWish = false;
        ai.grantShield(AI.respawnShield, this.time);
        this.rosterDirty = true; // 重生改名，联机要广播 roster
    }

    updateRespawn() {
        for (const ai of dueRespawns(this.ai, this.time)) {
            this.respawnAi(ai);
        }
    }

    // 重开一局 = 全新一局：AI 全部拉回出生体型、食物重新铺一遍。
    //
    // 不重置的话：玩家回到 100kg，而 AI 还留着几百 kg —— 场上每个球都吃得掉玩家、
    // 玩家却吃不掉任何一个（ai.r > player.r × 1.15 对每个 AI 都成立），
    // 2.5s 出生保护一过就是必死。实测世界跑 4 分钟后，玩家连续 8 次重生
    // 分别只活 3/5/7/7/5/6/4/8 秒。「再来一局」在玩家看来应该是新的一局，
    // 那就得连世界一起重置。
    //
    // 顺带解决：syncAiCount 只在"数量超编"时踢人，6 个 AI / 目标 6 个时一个都不踢，
    // 于是最大的那几个永远留在场上（AI 体型跨玩家死亡保留就是这么来的）。
    //
    // 玩家组不在重置范围里（位置/体型是 respawnGroup 的事，单机在 Game 里排在
    // reset() 之前/之后各有语义）；世界时间也不清——重生倒计时和冷却都以它为基准。
    reset() {
        this.ai = [];
        this.spawnAi(this.targetAiCount());
        this.seedFood();
        this.rebuildBalls();
    }

    // AI 实体视图：一个「AI 实体」= 同一 ownerId 的全部存活细胞（主脑 + 分裂分身）。
    // 排行榜/名次/称王判定都按实体聚合——与玩家组「整组质量折成一条」同口径，
    // 否则一个分裂的 AI 会占两行、名次也算重。
    aiEntities() {
        const byOwner = new Map();
        for (const ai of this.ai) {
            if (!ai.alive) {
                continue;
            }
            let entity = byOwner.get(ai.ownerId);
            if (!entity) {
                entity = { name: ai.name, mass: 0, alive: true };
                byOwner.set(ai.ownerId, entity);
            }
            entity.mass += ai.mass;
        }
        return [...byOwner.values()];
    }

    // 排行榜：每个玩家组建一行，"我"由 localOwnerId 标注（高亮用）
    leaderboard(localOwnerId) {
        const rows = [];
        for (const group of this.groups.values()) {
            if (group.cells.some((cell) => cell.alive)) {
                rows.push({
                    name: group.cells[0].name,
                    weight: groupMass(group.cells),
                    isPlayer: group.ownerId === localOwnerId,
                });
            }
        }
        return leaderboardEntries(rows, this.aiEntities());
    }

    // ---------- 逻辑更新（固定步长，dt = 1/60） ----------

    update(dt) {
        this.time += dt;

        // 输入 → 细胞：同组分身共享一个方向，各自按自己的体积算速度
        for (const group of this.groups.values()) {
            let anyAlive = false;
            for (const cell of group.cells) {
                if (!cell.alive) {
                    continue;
                }
                anyAlive = true;
                cell.speedX = group.input.speedX;
                cell.speedY = group.input.speedY;
                cell.update(dt, this.world);
            }
            if (anyAlive) {
                group.stats.playTime += dt;
            }
        }
        // 先主脑后分身：分身 update 里镜像主脑这一帧的输入，顺序反过来会用到上一帧的。
        for (const ai of this.ai) {
            if (ai.alive && !ai.leader) {
                ai.update(dt, this.world, this.balls, this.foodList, this.time);
            }
        }
        for (const ai of this.ai) {
            if (ai.alive && ai.leader) {
                ai.update(dt, this.world, this.balls, this.foodList, this.time);
            }
        }
        // 消费分裂请求：aiTrySplit 内部有完整把关（冷却/最小半径/实体分身上限），
        // 这里只管"想分了就来试一次"，成功与否都清掉愿望（下次思考周期会重新评估）。
        for (const ai of this.ai) {
            if (ai.alive && !ai.leader && ai.splitWish) {
                ai.splitWish = false;
                this.aiTrySplit(ai);
            }
        }

        this.eatFood();
        this.eatBalls();
        this.separateBalls();
        this.mergePlayerCells();
        this.mergeAiCells();

        this.updateRespawn();
        this.syncTimer -= dt;
        if (this.syncTimer <= 0) {
            this.syncTimer = AI.syncInterval;
            this.syncAiCount();
        }

        // 单局终点：称王。放最后，保证同帧里刚吃到的质量、刚排好的名次都算进去。
        // 只判玩家组（AI 再大也只是"被 AI 卡住"，不结束对局）。
        for (const group of this.groups.values()) {
            if (group.cells.some((cell) => cell.alive)
                && isCrowned(groupMass(group.cells), this.aiEntities())) {
                this.onEvent({ type: 'crowned', ownerId: group.ownerId });
            }
        }
    }

    // 软碰撞：吃不掉彼此的球互相挤开，避免视觉穿模（"AI 直接撞到我却没反应"）
    separateBalls() {
        resolveOverlaps(this.balls, this.time);
    }

    // 分身靠拢到一定距离后自动合并回一个
    mergePlayerCells() {
        let dirty = false;
        for (const group of this.groups.values()) {
            const result = mergeCells(group.cells, this.time);
            if (result.merged > 0) {
                group.cells = result.cells;
                dirty = true;
            }
        }
        if (dirty) {
            this.rebuildBalls();
        }
    }

    // 吃食物：任何球吃到都立刻补一颗（原位替换，判定在 rules.resolveFoodEating）
    eatFood() {
        const result = resolveFoodEating(this.foodList, this.balls, () => this.spawnFood());
        this.foodList = result.foodList;
        for (const group of this.groups.values()) {
            for (const cell of group.cells) {
                group.stats.foodEaten += result.eaten.get(cell) || 0;
            }
        }
    }

    // 互吃：大的吃小的（判定在 rules.resolveEatings），这里只安排死亡结算与重生。
    // 组的细胞被吃后**不移出数组**（alive=false 留在原地）：死亡演出期间镜头要跟着
    // 死球位置定格，所有消费方按 alive 过滤（groupMass / 排行榜 / 分裂 / 绘制）。
    eatBalls() {
        // 结算要用的质量必须在裁定「之前」取：resolveEatings 会把被吃的细胞
        // 标成 alive=false，之后 groupMass 就不会把它算进去（结算会显示 0kg）
        const massBefore = new Map();
        const aliveBefore = new Map();
        for (const group of this.groups.values()) {
            massBefore.set(group.ownerId, groupMass(group.cells));
            aliveBefore.set(group.ownerId, group.cells.some((cell) => cell.alive));
        }

        const { victims, eaten, by } = resolveEatings(this.balls, this.time);
        for (const group of this.groups.values()) {
            for (const cell of group.cells) {
                group.stats.kills += eaten.get(cell) || 0;
            }
        }
        this.settleAiDeaths(victims);
        this.rebuildBalls();

        // 全灭的组：广播事件（要不要进演出/结算由表现层定）
        for (const group of this.groups.values()) {
            if (aliveBefore.get(group.ownerId) && !group.cells.some((cell) => cell.alive)) {
                const killer = by.get(group.cells.find((cell) => !cell.alive));
                this.onEvent({
                    type: 'eaten',
                    ownerId: group.ownerId,
                    mass: massBefore.get(group.ownerId),
                    rank: rankOfGroup(massBefore.get(group.ownerId), this.aiEntities()),
                    by: killer || null,
                });
            }
        }
    }

    // AI 的死亡结算。AI 是「实体」（主脑 + 分裂分身），与单球时代不同：
    //   · 只死一颗分身、实体还有活人 → 死细胞直接移出列表（不排队重生——重生的
    //     是实体，不是某颗细胞）；
    //   · 主脑死了但分身还在   → 分身递补成主脑（立即重新决策，分裂冷却延续）；
    //   · 整组死绝             → 只排**一次**重生（用主脑当载体；同帧被吃的其他
    //     细胞直接消失，否则两颗死细胞各自重生 = 实体凭空翻倍）。
    // 按 ownerId 分组结算，因为同一实体的多颗细胞可能同帧被吃。
    settleAiDeaths(victims) {
        const aiVictims = victims.filter((victim) => !this.groups.has(victim.ownerId));
        const byOwner = new Map();
        for (const victim of aiVictims) {
            const list = byOwner.get(victim.ownerId);
            if (list) {
                list.push(victim);
            } else {
                byOwner.set(victim.ownerId, [victim]);
            }
        }
        for (const [ownerId, list] of byOwner) {
            const survivors = this.ai.filter((ai) => ai.alive && ai.ownerId === ownerId);
            if (survivors.length > 0) {
                const fallenPrimary = list.find((victim) => !victim.leader);
                if (fallenPrimary) {
                    this.promoteAi(survivors[0], fallenPrimary);
                }
                this.ai = this.ai.filter((ai) => !list.includes(ai));
                continue;
            }
            // 整组死绝：主脑当重生载体，其余死细胞当场移除
            const carrier = list.find((victim) => !victim.leader) || list[0];
            carrier.leader = null;
            carrier.respawnAt = this.time + AI.respawnDelay;
            this.ai = this.ai.filter((ai) => ai === carrier || !list.includes(ai));
        }
    }

    // 分身递补成主脑：继承分裂冷却（lastSplitAt），决策状态不搬——
    // thinkTimer 清零让它下一帧立刻重新决策（分身本来就没有大脑，旧目标是主脑的遗物）。
    promoteAi(survivor, fallen) {
        survivor.leader = null;
        survivor.lastSplitAt = fallen.lastSplitAt;
        survivor.thinkTimer = 0;
        survivor.splitWish = false;
    }

    // AI 分裂捕猎的执行入口（决策在 AiPlayer.think，几何判定在 rules.aiSplitWindow）。
    // 与玩家 requestSplit 同一套把关（rules.splitStatus），差异只有三点：
    //   · 上限用 AI.maxCells（比玩家的 SPLIT.maxCells 小，见 config）；
    //   · 分开轴正对猎物：splitCells 朝 dir 的垂直方向分开，这里传「指向猎物的
    //     垂直向量」，于是靠猎物那半相当于扑出去（玩家是垂直于移动方向，纯手感）；
    //   · 切出的新细胞是「分身」（leader = 主脑），不独立决策、镜像主脑输入。
    aiTrySplit(ai) {
        if (!this.aiSplit) {
            return false; // 开局界面关了「AI 分裂」：只挡执行，决策层照常（开销可忽略）
        }
        if (ai.leader) {
            return false;
        }
        const prey = ai.targetBall;
        if (!prey || !prey.alive) {
            return false;
        }
        const cells = this.ai.filter((cell) => cell.alive && cell.ownerId === ai.ownerId);
        if (!splitStatus(cells, this.time, ai.lastSplitAt, AI.maxCells).canSplit) {
            return false;
        }
        const dx = prey.x - ai.x;
        const dy = prey.y - ai.y;
        const len = Math.hypot(dx, dy) || 1;
        // splitCells 的分开方向 = (dirX, dirY) 的垂直方向 → 传垂直向量，分开轴就是猎物方向
        const dirX = -dy / len;
        const dirY = dx / len;
        const out = splitCells(cells, dirX, dirY, (x, y, r, from) => {
            const cell = new AiPlayer(x, y, r, from.bColor, ai.name);
            cell.ownerId = ai.ownerId;
            cell.leader = ai;
            cell.foodGain = ai.foodGain;
            cell.eatBonus = ai.eatBonus;
            return cell;
        });
        const fresh = out.filter((cell) => !cells.includes(cell));
        for (const cell of out) {
            cell.mergeAfter = this.time + SPLIT.mergeCooldown;
            cell.lastSplitAt = this.time;
        }
        this.ai.push(...fresh);
        this.rebuildBalls();
        log('分裂', `${ai.name} 分裂捕猎（→ ${prey.name || '无名'}）：`
            + `${cells.length} → ${out.length} 颗细胞，主脑 r=${ai.r.toFixed(0)}`);
        return true;
    }

    // 分身靠拢后自动合并回主脑（玩家组的 mergePlayerCells 同款，按 ownerId 分组）。
    // 主脑永远排在组首：mergeCells 保留先出现的细胞，主脑必须活下来——
    // 它持有决策状态，被并掉的话实体就成了没脑子的分身集群。
    mergeAiCells() {
        let dirty = false;
        const byOwner = new Map();
        for (const ai of this.ai) {
            if (!ai.alive) {
                continue;
            }
            const list = byOwner.get(ai.ownerId);
            if (list) {
                list.push(ai);
            } else {
                byOwner.set(ai.ownerId, [ai]);
            }
        }
        for (const list of byOwner.values()) {
            if (list.length < 2) {
                continue;
            }
            list.sort((a, b) => (a.leader ? 1 : 0) - (b.leader ? 1 : 0));
            const result = mergeCells(list, this.time);
            if (result.merged === 0) {
                continue;
            }
            const gone = list.filter((cell) => !result.cells.includes(cell));
            for (const cell of gone) {
                cell.alive = false; // 被并掉：不进重生队列
            }
            this.ai = this.ai.filter((cell) => !gone.includes(cell));
            dirty = true;
        }
        if (dirty) {
            this.rebuildBalls();
        }
    }
}
