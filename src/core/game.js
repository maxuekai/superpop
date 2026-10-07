import { AI, COLORS, FOOD, NAMES, PLAYER, SPAWN, TICK, VIEW, WORLD } from '../config.js';
import { AiPlayer } from './ai.js';
import { Camera } from './camera.js';
// 改名导入：原本叫 Map 的话，本文件里就不能再用全局的 Map（会遮蔽）
import { Map as GameMap } from './map.js';
import { Player } from './player.js';
import {
    dueRespawns,
    excessToRemove,
    isSpawnClear,
    leaderboardEntries,
    rankOf,
    resolveEatings,
    resolveFoodEating,
    targetAiCount,
} from './rules.js';
import { clamp, clusterOffset, distance, randomFloat, randomInt, randomItem } from './utils.js';

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

        // 玩家 + 全部 AI（含已死等待重生的），碰撞检测遍历这一份
        this.player = new Player();
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

        this.camera = new Camera(0, 0, 0, 0, this.world.width, this.world.height);
        this.camera.follow(this.player);

        this.resize = this.resize.bind(this);
        this.loop = this.loop.bind(this);
        this.resize();

        this.resetPlayer();
        // 开局按「当前体型对应的目标数量」放 AI，而不是一把放满 AI.count：
        // 目标数量会随玩家体型从 minCount 涨到 count，开局满屏对手容易被围
        this.spawnAi(this.targetAiCount());
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
    // 否则相机会被钳在边上、球偏在屏幕一角
    safeSpawnPosition(radius, edgeGap = SPAWN.edgeGap) {
        const margin = radius + 8 + edgeGap;
        let fallback = null;
        for (let attempt = 0; attempt < 60; attempt += 1) {
            const pos = this.randomPosition(margin);
            fallback = pos;
            if (isSpawnClear(pos, radius, this.balls)) {
                return pos;
            }
        }
        return fallback || this.randomPosition(margin);
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

    // AI 出生半径：跟着玩家体型取样，既不会全顶在上限，也不会开局全是大佬
    aiSpawnRadius(ratio) {
        const min = PLAYER.radius * AI.spawnRadiusMin;
        const max = Math.max(min, Math.min(PLAYER.radius * AI.spawnRadiusMax, this.player.r * ratio));
        return randomFloat(min, max);
    }

    spawnAi(count = 1) {
        for (let i = 0; i < count; i += 1) {
            const r = this.aiSpawnRadius(AI.spawnRadiusRatio);
            const pos = this.safeSpawnPosition(r);
            const ai = new AiPlayer(pos.x, pos.y, r, randomItem(COLORS), randomItem(NAMES));
            ai.foodGain = AI.foodGain;
            this.ai.push(ai);
            this.balls.push(ai);
        }
    }

    // AI 数量随玩家体型动态调整：玩家越大场上对手越多，但不超过 AI.count（公式见 rules.js）
    targetAiCount() {
        return targetAiCount(this.player.r);
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
        const pos = this.safeSpawnPosition(r);
        ai.reset(pos.x, pos.y, r, randomItem(COLORS));
        ai.foodGain = AI.foodGain;
        ai.name = randomItem(NAMES);
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
            this.player.name = name;
        }
        this.playTime = 0;
        this.foodEaten = 0;
        this.kills = 0;
    }

    // 从开局界面进入游戏
    begin(name) {
        if (name) {
            this.player.name = name;
        }
        this.state = 'playing';
        // 保护从真正开局那一刻开始算（菜单界面里世界时间也在走，不能在构造时发）
        this.player.grantShield(PLAYER.spawnShield, this.time);
        this.camera.snapTo(this.player);
        this.hud.hideStart();
    }

    // 结算界面「再来一局」
    respawnPlayer(name) {
        this.resetPlayer(name);
        this.state = 'playing';
        this.player.grantShield(PLAYER.spawnShield, this.time);
        this.camera.snapTo(this.player);
        this.hud.hideSettlement();
    }

    onPlayerEaten() {
        this.player.alive = false;
        this.player.speedX = 0;
        this.player.speedY = 0;
        this.state = 'dead';
        this.hud.showSettlement({
            weight: Math.round(this.player.mass),
            rank: this.rankOf(this.player),
            time: this.playTime,
            food: this.foodEaten,
            kills: this.kills,
            name: this.player.name,
        });
    }

    // 玩家当前名次（存活的球里比它重的数量 + 1）
    rankOf(ball) {
        return rankOf(ball, this.balls);
    }

    // 排行榜数据（体重降序，取前 N）
    leaderboard() {
        return leaderboardEntries(this.balls, this.player);
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
        this.updateViewScale();
        this.camera.update();
        this.hud.update(dt, this);
    }

    updateWorld(dt) {
        this.playTime += dt;
        this.player.update(dt, this.world);
        for (const ai of this.ai) {
            if (ai.alive) {
                ai.update(dt, this.world, this.balls, this.foodList);
            }
        }

        this.eatFood();
        this.eatBalls();

        this.updateRespawn();
        this.syncTimer -= dt;
        if (this.syncTimer <= 0) {
            this.syncTimer = AI.syncInterval;
            this.syncAiCount();
        }
    }

    // 吃食物：任何球吃到都立刻在别处补一颗（判定在 rules.resolveFoodEating）
    eatFood() {
        const result = resolveFoodEating(this.foodList, this.balls, () => this.spawnFood());
        this.foodList = result.foodList;
        this.foodEaten += result.eaten.get(this.player) || 0;
    }

    // 互吃：大的吃小的（判定在 rules.resolveEatings），这里只安排死亡结算与重生
    eatBalls() {
        const { victims, eaten } = resolveEatings(this.balls, this.time);
        this.kills += eaten.get(this.player) || 0;
        for (const victim of victims) {
            if (victim === this.player) {
                this.onPlayerEaten();
            } else {
                victim.respawnAt = this.time + AI.respawnDelay;
            }
        }
    }

    // ---------- 渲染 ----------

    // 画布铺满窗口，并按 devicePixelRatio 渲染保证手机清晰度
    resize() {
        const dpr = window.devicePixelRatio || 1;
        this.cssWidth = window.innerWidth;
        this.cssHeight = window.innerHeight;
        this.canvas.width = Math.round(this.cssWidth * dpr);
        this.canvas.height = Math.round(this.cssHeight * dpr);

        // 保证视口不大于整个世界（否则相机会被钳制出负坐标）
        this.fitScale = Math.max(this.cssWidth / this.world.width, this.cssHeight / this.world.height);
        this.updateViewScale();
    }

    // 视野缩放：屏幕长边锚定 VIEW.longEdgeWorld 个世界单位，并随体型放大视距
    updateViewScale() {
        const sizeZoom = Math.pow(this.player.r / PLAYER.radius, VIEW.zoomExponent);
        this.scale = Math.max(
            this.fitScale,
            Math.max(this.cssWidth, this.cssHeight) / (VIEW.longEdgeWorld * sizeZoom),
        );
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

        // 球：先画活着的 AI 再画玩家，保证玩家始终在最上层
        for (const ball of this.balls) {
            if (ball.alive && ball !== this.player) {
                ball.draw(context);
            }
        }
        if (this.player.alive) {
            this.player.draw(context);
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
        this.hud.updateWeight(this.player);
        window.requestAnimationFrame(this.loop);
    }
}