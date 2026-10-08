import {
    AI,
    COLORS,
    DEFAULT_DIFFICULTY,
    DIFFICULTY,
    FOOD,
    NAMES,
    PLAYER,
    PLAYER_OWNER,
    SPAWN,
    SPLIT,
    TICK,
    VIEW,
    WORLD,
} from '../config.js';
import { AiPlayer } from './ai.js';
import { Camera } from './camera.js';
// 改名导入：原本叫 Map 的话，本文件里就不能再用全局的 Map（会遮蔽）
import { Map as GameMap } from './map.js';
import { Player } from './player.js';
import {
    canSplit,
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
import { clamp, clusterOffset, distance, randomFloat, randomInt, randomItem, smoothTowards } from './utils.js';

// 游戏主循环：逻辑按固定步长推进（update），渲染跟随屏幕刷新率（draw）。
// 状态流转：menu（开局界面，逻辑暂停）→ playing → dead（结算界面，逻辑暂停）→ playing
export class Game {
    constructor(canvas, hud) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');
        this.hud = hud;

        this.world = { width: WORLD.width, height: WORLD.height };
        this.state = 'menu';
        this.time = 0; // 世界时间（秒）：AI 重生倒计时用
        this.playTime = 0; // 本局存活时长（秒）
        this.foodEaten = 0; // 本局吃掉的食物数
        this.kills = 0; // 本局吃掉的其他球数

        // 玩家 + 全部 AI（含已死等待重生的）+ 玩家的每一个分身，碰撞检测遍历这一份
        this.player = new Player();
        this.playerCells = [this.player];
        this.playerName = this.player.name;
        this.ai = [];
        this.balls = [this.player];

        this.foodList = [];
        for (let i = 0; i < FOOD.count; i += 1) {
            this.foodList.push(this.spawnFood());
        }

        this.map = new GameMap(this.world.width, this.world.height);

        // 世界单位 → CSS 像素的缩放；resize()/updateViewScale() 里计算
        this.scale = 1;
        this.cssWidth = 0;
        this.cssHeight = 0;
        this.fitScale = 1;

        this.accumulator = 0;
        this.lastTime = 0;
        this.syncTimer = 0;
        this.lastSplitAt = -Infinity;

        // 输入层：摇杆/键盘写这里，再同步给每一个玩家分身
        // （分身不是一个球，共享同一个方向；不共用对象的话输入只会作用在其中一个上）
        this.input = { speedX: 0, speedY: 0 };

        this.camera = new Camera(0, 0, 0, 0, this.world.width, this.world.height, VIEW.cameraDeadZone);
        this.camera.follow(this.largestCell());

        this.resize = this.resize.bind(this);
        this.loop = this.loop.bind(this);
        this.resize();

        this.resetPlayer();
        // 开局按「当前体型对应的目标数量」放 AI，而不是一把放满 AI.count：
        // 目标数量会随玩家体型从 minCount 涨到 count，开局满屏对手容易被围
        this.spawnAi(this.targetAiCount());
        this.camera.follow(this.largestCell());
    }

    // ---------- 玩家分身 ----------

    // 最大的存活分身：镜头、视野缩放都用它（最稳，不会因为分身分散而乱跳）
    largestCell() {
        let best = null;
        for (const cell of this.playerCells) {
            if (cell.alive && (best === null || cell.r > best.r)) {
                best = cell;
            }
        }
        return best || this.playerCells[0] || this.player;
    }

    // 玩家整组质量（体重面板/排行榜口径）
    playerMass() {
        return groupMass(this.playerCells);
    }

    // 分身增减后要重建碰撞列表（数量很少，直接重算最不容易出错）
    rebuildBalls() {
        this.balls = [...this.playerCells.filter((cell) => cell.alive), ...this.ai];
    }

    // 分裂状态：给 HUD（按钮是否可点、冷却还剩几秒、为什么不能点）。
    // 判定本身在 rules.splitStatus（纯函数、可单测），这里只补上"是否在局内"这一层。
    splitState() {
        const status = splitStatus(this.playerCells, this.time, this.lastSplitAt);
        const playing = this.state === 'playing';
        return {
            canSplit: playing && status.canSplit,
            cooldownLeft: status.cooldownLeft,
            atCellLimit: playing && status.atCellLimit,
        };
    }

    requestSplit() {
        if (!this.splitState().canSplit) {
            return false;
        }
        const { speedX, speedY } = this.input;
        this.playerCells = splitCells(this.playerCells, speedX, speedY, (x, y, r, from) => {
            const cell = new Player(this.playerName);
            cell.x = x;
            cell.y = y;
            cell.r = r;
            cell.bColor = from.bColor;
            cell.mergeAfter = this.time + SPLIT.mergeCooldown;
            return cell;
        });
        this.lastSplitAt = this.time;
        for (const cell of this.playerCells) {
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
    // preferOffscreen=true 时优先挑相机视口之外的点——AI 在你眼前凭空出现会很像"闪现"。
    safeSpawnPosition(radius, edgeGap = SPAWN.edgeGap, preferOffscreen = false) {
        const margin = radius + 8 + edgeGap;
        let fallback = null;
        for (let attempt = 0; attempt < 60; attempt += 1) {
            const pos = this.randomPosition(margin);
            fallback = pos;
            if (!isSpawnClear(pos, radius, this.balls)) {
                continue;
            }
            if (preferOffscreen && attempt < 40 && !isOutsideView(pos, this.viewRect(), SPAWN.edgeGap)) {
                continue; // 前 40 次都在找屏幕外的位置
            }
            return pos;
        }
        return fallback || this.randomPosition(margin);
    }

    // 当前相机视口（世界坐标），供出生位置判断用
    viewRect() {
        return { x: this.camera.xView, y: this.camera.yView, w: this.camera.wView, h: this.camera.hView };
    }

    // 生成一颗食物：先找一个避开所有球的簇心，再让这颗落在簇内（成簇更好找）
    spawnFood() {
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
        const offset = clusterOffset(FOOD.clusterRadius);
        return {
            x: clamp(center.x + offset.dx, FOOD.radius + 2, this.world.width - FOOD.radius - 2),
            y: clamp(center.y + offset.dy, FOOD.radius + 2, this.world.height - FOOD.radius - 2),
            color: randomItem(COLORS),
        };
    }

    // 抽一个当前没人用的昵称（同屏出现两个同名会让玩家分不清，规则见 rules.pickFreeName）
    pickAiName() {
        const used = this.ai.filter((ai) => ai.alive).map((ai) => ai.name);
        return pickFreeName(used, NAMES);
    }

    // AI 出生半径：跟着玩家体型取样（用整组里最大的分身，否则分裂后会被低估）
    aiSpawnRadius(ratio) {
        const min = PLAYER.radius * AI.spawnRadiusMin;
        const max = Math.max(min, Math.min(PLAYER.radius * AI.spawnRadiusMax, this.largestCell().r * ratio));
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
        }
    }

    // AI 数量随玩家体型动态调整：玩家越大场上对手越多，但不超过 AI.count（公式见 rules.js）
    targetAiCount() {
        return targetAiCount(this.largestCell().r);
    }

    syncAiCount() {
        const alive = this.ai.filter((ai) => ai.alive);
        const target = this.targetAiCount();

        // 不足就补（补到 AI.count 为上限）
        let missing = target - alive.length;
        while (missing > 0 && this.ai.length < AI.count) {
            this.spawnAi(1);
            missing -= 1;
        }

        // 超编就悄悄收掉最大的那几个（永久移除，不再重生）
        for (const victim of excessToRemove(alive, target)) {
            victim.alive = false;
            victim.respawnAt = Infinity;
            this.ai = this.ai.filter((ai) => ai !== victim);
            this.balls = this.balls.filter((ball) => ball !== victim);
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
        ai.grantShield(AI.respawnShield, this.time);
    }

    updateRespawn() {
        for (const ai of dueRespawns(this.ai, this.time)) {
            this.respawnAi(ai);
        }
    }

    // ---------- 生命周期 ----------

    resetPlayer(name) {
        const pos = this.safeSpawnPosition(PLAYER.radius);
        this.player.reset(pos.x, pos.y, PLAYER.radius, randomItem(COLORS));
        if (name) {
            this.playerName = name;
        }
        this.player.name = this.playerName;
        // 重生回到单个细胞；质量、分身、冷却全部重置
        this.playerCells = [this.player];
        this.lastSplitAt = -Infinity;
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.playTime = 0;
        this.foodEaten = 0;
        this.kills = 0;
        this.rebuildBalls();
    }

    // 从开局界面进入游戏
    begin(name, difficulty) {
        if (name) {
            this.playerName = name;
            this.player.name = name;
        }
        this.setDifficulty(difficulty);
        this.restartWorld();
        this.state = 'playing';
        // 保护从真正开局那一刻开始算（菜单界面里世界时间也在走，不能在构造时发）
        this.player.grantShield(PLAYER.spawnShield, this.time);
        this.updateViewScale(0, true); // 重开一局视野立刻就位，不该慢慢推
        this.camera.snapTo(this.largestCell());
        this.hud.hideStart();
    }

    // 难度只覆写 AI 的"决策质量"参数，不动速度（理由见 config.DIFFICULTY 注释）。
    // 必须在 restartWorld() 之前调用：AI 是那时候才批量生成的。
    // 已经存在的 AI 也要同步——eatBonus 是在构造函数里抓进实例的，改 config 不影响存量球。
    setDifficulty(level) {
        const preset = DIFFICULTY[level] || DIFFICULTY[DEFAULT_DIFFICULTY];
        this.difficulty = DIFFICULTY[level] ? level : DEFAULT_DIFFICULTY;
        for (const key of Object.keys(preset)) {
            if (key === 'label') {
                continue;
            }
            AI[key] = preset[key];
        }
        for (const ai of this.ai) {
            ai.eatBonus = AI.eatBonus;
            ai.foodGain = AI.foodGain;
        }
        return this.difficulty;
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
    restartWorld() {
        this.ai = [];
        this.rebuildBalls();
        this.spawnAi(this.targetAiCount());
        this.foodList = [];
        for (let i = 0; i < FOOD.count; i += 1) {
            this.foodList.push(this.spawnFood());
        }
        this.rebuildBalls();
    }

    // 结算界面「再来一局」
    respawnPlayer(name) {
        this.resetPlayer(name);
        this.restartWorld();
        this.state = 'playing';
        this.player.grantShield(PLAYER.spawnShield, this.time);
        this.updateViewScale(0, true); // 重开一局视野立刻就位，不该慢慢推
        this.camera.snapTo(this.largestCell());
        this.hud.hideSettlement();
    }

    // 左下角「菜单」：结束本局，回到开局界面。
    // state 置回 'menu' 就会停掉 updateWorld（世界冻结），跟开局界面一致；
    // 分身/质量/冷却全部由 resetPlayer 清干净，不会带着上一局的巨大体型继续。
    quitToMenu() {
        this.state = 'menu';
        this.resetPlayer();
        this.updateViewScale(0, true); // 重开一局视野立刻就位，不该慢慢推
        this.camera.snapTo(this.largestCell());
        this.hud.showStart();
    }

    // 整组玩家细胞都被吃光才算死。finalMass 要传「死亡瞬间」的质量：
    // 走到这里时细胞已经被移出数组，playerMass() 已经是 0，结算会显示成 0kg。
    onPlayerEaten(finalMass) {
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.state = 'dead';
        this.hud.showSettlement({
            weight: Math.round(finalMass),
            rank: rankOfGroup(finalMass, this.ai),
            time: this.playTime,
            food: this.foodEaten,
            kills: this.kills,
            name: this.playerName,
            crowned: false,
        });
    }

    // 称王：单局的终点（质量达标 + 当前第一），与死亡一样把世界冻住。
    onCrowned() {
        const mass = this.playerMass();
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.state = 'crowned';
        this.hud.showSettlement({
            weight: Math.round(mass),
            rank: 1,
            time: this.playTime,
            food: this.foodEaten,
            kills: this.kills,
            name: this.playerName,
            crowned: true,
        });
    }

    // 排行榜数据（玩家按整组质量算一条）
    leaderboard() {
        return leaderboardEntries(this.playerCells, this.ai);
    }

    // ---------- 逻辑更新 ----------

    update(dt) {
        this.time += dt;
        if (this.state === 'playing') {
            this.updateWorld(dt);
        }
        // 出生保护标记：给 draw 画光环用
        for (const ball of this.balls) {
            ball.shielded = ball.alive && ball.isProtected(this.time);
        }
        this.updateViewScale(dt);
        this.camera.follow(this.largestCell());
        this.camera.update();
        this.hud.update(dt, this);
    }

    updateWorld(dt) {
        this.playTime += dt;

        // 输入同步到每一个分身：它们共享同一个方向，各自按自己的体积算速度
        for (const cell of this.playerCells) {
            if (!cell.alive) {
                continue;
            }
            cell.speedX = this.input.speedX;
            cell.speedY = this.input.speedY;
            cell.update(dt, this.world);
        }
        for (const ai of this.ai) {
            if (ai.alive) {
                ai.update(dt, this.world, this.balls, this.foodList);
            }
        }

        this.eatFood();
        this.eatBalls();
        this.separateBalls();
        this.mergePlayerCells();

        this.updateRespawn();
        this.syncTimer -= dt;
        if (this.syncTimer <= 0) {
            this.syncTimer = AI.syncInterval;
            this.syncAiCount();
        }

        // 单局终点：称王。放最后，保证同帧里刚吃到的质量、刚排好的名次都算进去。
        if (isCrowned(this.playerMass(), this.ai)) {
            this.onCrowned();
        }
    }

    // 软碰撞：吃不掉彼此的球互相挤开，避免视觉穿模（"AI 直接撞到我却没反应"）
    separateBalls() {
        resolveOverlaps(this.balls, this.time);
    }

    // 分身靠拢到一定距离后自动合并回一个
    mergePlayerCells() {
        const result = mergeCells(this.playerCells, this.time);
        if (result.merged > 0) {
            this.playerCells = result.cells;
            this.rebuildBalls();
        }
    }

    // 吃食物：任何球吃到都立刻在别处补一颗（判定在 rules.resolveFoodEating）
    eatFood() {
        const result = resolveFoodEating(this.foodList, this.balls, () => this.spawnFood());
        this.foodList = result.foodList;
        for (const cell of this.playerCells) {
            this.foodEaten += result.eaten.get(cell) || 0;
        }
    }

    // 互吃：大的吃小的（判定在 rules.resolveEatings），这里只安排死亡结算与重生
    eatBalls() {
        // 结算要用的质量必须在裁定「之前」取：resolveEatings 会把被吃的细胞
        // 标成 alive=false，之后 groupMass 就不会把它算进去（结算会显示 0kg）
        const massBefore = this.playerMass();
        const { victims, eaten } = resolveEatings(this.balls, this.time);
        for (const cell of this.playerCells) {
            this.kills += eaten.get(cell) || 0;
        }
        for (const victim of victims) {
            if (victim.ownerId === PLAYER_OWNER) {
                // 分身被吃掉只是损失那份质量；全都吃光才结算死亡
                this.playerCells = this.playerCells.filter((cell) => cell !== victim);
                continue;
            }
            victim.respawnAt = this.time + AI.respawnDelay;
        }
        this.rebuildBalls();
        if (this.state === 'playing' && this.playerCells.length === 0) {
            this.onPlayerEaten(massBefore);
        }
    }

    // ---------- 渲染 ----------

    // 画布铺满窗口，并按 devicePixelRatio 渲染保证手机清晰度
    resize() {
        const dpr = window.devicePixelRatio || 1;
        // 必须量画布自己的盒子，而不是 window.innerWidth/innerHeight：
        // 手机上 CSS 的 100vh 是「地址栏收起时的最大高度」，而 window.innerHeight 是
        // 「地址栏展开时的当前高度」，两者不一致 → 像素尺寸与显示尺寸不等比 → 球被拉成椭圆，
        // 同时相机视口也按错尺寸算，画面和镜头以为的位置对不上（表现为镜头不跟、球跑丢）。
        const rect = this.canvas.getBoundingClientRect();
        const cssWidth = Math.round(rect.width) || window.innerWidth;
        const cssHeight = Math.round(rect.height) || window.innerHeight;

        this.cssWidth = cssWidth;
        this.cssHeight = cssHeight;
        this.canvas.width = Math.round(cssWidth * dpr);
        this.canvas.height = Math.round(cssHeight * dpr);

        // 保证视口不大于整个世界（否则相机会被钳制出负坐标）。
        // 允许比世界大 VIEW.maxZoomOut 倍：Camera.clampView 在视口超过世界时是"居中"，
        // 所以露出一点世界外区域也不会让镜头跑到负坐标或左右横跳。
        // 不放开的话竖屏手机的缩放只活到 r≈12 就死了，"球越大看得越远"从没发生过。
        this.fitScale = Math.max(cssWidth / this.world.width, cssHeight / this.world.height) / VIEW.maxZoomOut;
        // 注意：这里**不**直接 snap。除了首次布局外都交给 update(dt) 平滑逼近——
        // 手机地址栏收放会高频触发 resize，硬赋值就是"视角突然扩大"的元凶。
        this.updateViewScale(0, !this.viewReady);
    }

    // 视野缩放：屏幕长边锚定 VIEW.longEdgeWorld 个世界单位，并随体型放大视距。
    // 体型口径取「最大的分身」：分身分散时视野不会来回跳。
    //
    // ⚠ scale 必须是**平滑逼近**目标值的，不能直接赋值。目标缩放的来源全是硬跳变：
    // 手机地址栏收放（visualViewport.resize，实测摆动 100px 让视口宽度一帧跳 12~15%）、
    // 转屏、吃人（质量吸收）、分身合并（largestCell 变成 √2 r）。
    // 直接赋值 = "视角突然扩大"。smoothTowards 的单帧变化幅度只跟"还差多少"成比例，
    // 与跳变本身多大无关，所以再大的跳变也看不出来了。
    // snap=true 用于首次布局与重开一局——那种情况本来就该立刻就位。
    targetScale() {
        const sizeZoom = Math.pow(this.largestCell().r / PLAYER.radius, VIEW.zoomExponent);
        return Math.max(
            this.fitScale,
            Math.max(this.cssWidth, this.cssHeight) / (VIEW.longEdgeWorld * sizeZoom),
        );
    }

    updateViewScale(dt, snap = false) {
        if (snap || !this.viewReady) {
            this.scale = this.targetScale();
            this.viewReady = true;
        } else {
            this.scale = smoothTowards(this.scale, this.targetScale(), VIEW.zoomLerp, dt);
        }
        this.camera.setViewSize(this.cssWidth / this.scale, this.cssHeight / this.scale);
    }

    // 食物不烤进地图：按视口动态绘制，并按颜色合批
    // （逐颗 beginPath+fill 在 360 颗时会有上千次绘制调用，合批后只调用几次）
    drawFood(context) {
        const byColor = new Map();
        const viewLeft = this.camera.xView - FOOD.radius;
        const viewRight = this.camera.xView + this.camera.wView + FOOD.radius;
        const viewTop = this.camera.yView - FOOD.radius;
        const viewBottom = this.camera.yView + this.camera.hView + FOOD.radius;

        for (const food of this.foodList) {
            if (food.x < viewLeft || food.x > viewRight || food.y < viewTop || food.y > viewBottom) {
                continue;
            }
            let bucket = byColor.get(food.color);
            if (bucket === undefined) {
                bucket = [];
                byColor.set(food.color, bucket);
            }
            bucket.push(food);
        }

        context.lineWidth = 1;
        for (const [color, list] of byColor) {
            context.beginPath();
            for (const food of list) {
                // 先 moveTo 才能让同一路径里每颗食物都是独立子路径
                context.moveTo(food.x + FOOD.radius, food.y);
                context.arc(food.x, food.y, FOOD.radius, 0, Math.PI * 2);
            }
            context.closePath();
            context.fillStyle = color;
            context.fill();
            context.strokeStyle = color;
            context.stroke();
        }
    }

    draw() {
        const { context, camera, map } = this;
        const dpr = window.devicePixelRatio || 1;

        // 每帧重置变换：按 DPR × 世界缩放 渲染，再平移到相机视口
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        context.save();
        context.scale(dpr * this.scale, dpr * this.scale);
        context.translate(-camera.xView, -camera.yView);

        map.draw(context, camera);

        // 食物（按视口裁剪 + 按颜色合批）
        this.drawFood(context);

        // 球：先画 AI 再画玩家分身，保证玩家始终在最上层
        for (const ai of this.ai) {
            if (ai.alive) {
                ai.draw(context);
            }
        }
        for (const cell of this.playerCells) {
            if (cell.alive) {
                cell.draw(context);
            }
        }

        context.restore();
    }

    // ---------- 主循环 ----------

    loop(now) {
        const frame = typeof now === 'number' ? now : performance.now();
        let frameTime = (frame - this.lastTime) / 1000;
        this.lastTime = frame;
        // 切后台回来时可能有几秒的空档，钳一下避免一次补上几百步
        frameTime = Math.min(Math.max(frameTime, 0), 0.25);

        this.accumulator += frameTime;
        const step = 1 / TICK.fps;
        let steps = 0;
        while (this.accumulator >= step && steps < TICK.maxSteps) {
            this.update(step);
            this.accumulator -= step;
            steps += 1;
        }
        // 追不上就丢弃积压，宁可慢放也不让物理炸开
        if (steps >= TICK.maxSteps) {
            this.accumulator = 0;
        }

        this.draw();
        window.requestAnimationFrame(this.loop);
    }

    start() {
        this.lastTime = performance.now();
        this.hud.updateWeight(this.playerMass());
        window.requestAnimationFrame(this.loop);
    }
}