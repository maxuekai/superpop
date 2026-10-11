import {
    AI,
    DEFAULT_DIFFICULTY,
    DEATH,
    DIFFICULTY,
    FOOD,
    NICKNAME,
    PLAYER,
    PLAYER_OWNER,
    TICK,
    VIEW,
    WORLD,
} from '../config.js';
import { Camera } from './camera.js';
// 改名导入：原本叫 Map 的话，本文件里就不能再用全局的 Map（会遮蔽）
import { Map as GameMap } from './map.js';
import {
    groupMass,
    rankOfGroup,
    splitStatus,
} from './rules.js';
import { clamp, smoothTowards, zoomTarget } from './utils.js';
import { log, logSnapshot } from './log.js';
import { World } from './world.js';

// 游戏主循环：逻辑按固定步长推进（update），渲染跟随屏幕刷新率（draw）。
// 状态流转：menu（开局界面，逻辑暂停）→ playing → dying（被吃演出：世界慢放+红闪）
//          → dead（结算界面，逻辑暂停）→ playing；playing → crowned（称王结算）
//
// Game 只是「状态机 + 调度 + 渲染 + 输入」的壳：全部玩法逻辑（食物/AI/互吃/分裂/
// 重生/称王判定）在 core/world.js 的无头世界里，联机服务端跑的就是同一份。
// 世界事件（被吃/称王）通过 onEvent 回调进来，这里只负责决定"怎么演"。
export class Game {
    constructor(canvas, hud) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');
        this.hud = hud;

        this.state = 'menu';
        this.dyingTimer = 0; // >0 时处于死亡演出（dying）倒计时
        this.settlementStats = null; // 死亡瞬间的结算数据，演出结束后才展示

        // 输入层：摇杆/键盘写这里，再同步给世界里的玩家组
        this.input = { speedX: 0, speedY: 0 };

        // 相机先于世界：AI 出生"避开视野"要读相机视口（World.getViewRect 回调）
        this.camera = new Camera(0, 0, 0, 0, WORLD.width, WORLD.height, VIEW.cameraDeadZone);

        this.world = new World({
            getViewRect: () => this.viewRect(),
            onEvent: (event) => this.onWorldEvent(event),
        });
        this.group = this.world.addGroup(PLAYER_OWNER, NICKNAME.defaultName);
        // 开局按「当前体型对应的目标数量」放 AI，而不是一把放满 AI.count：
        // 目标数量会随玩家体型从 minCount 涨到 count，开局满屏对手容易被围
        this.world.spawnAi(this.world.targetAiCount());

        this.map = new GameMap(WORLD.width, WORLD.height);

        // 世界单位 → CSS 像素的缩放；resize()/updateViewScale() 里计算
        this.scale = 1;
        this.cssWidth = 0;
        this.cssHeight = 0;
        this.fitScale = 1;
        // 用户手动缩放系数（滚轮 / +、- 键 / 双指捏合写它）。是乘在自动缩放上的偏好而非
        // 游戏状态，重开一局不清——玩家特意调的视野不该被「再来一局」悄悄改回去。
        this.userZoom = 1;

        this.accumulator = 0;
        this.lastTime = 0;

        this.resize = this.resize.bind(this);
        this.loop = this.loop.bind(this);
        this.resize();

        this.camera.follow(this.largestCell());
    }

    // ---------- 本地玩家（一个玩家组的薄封装） ----------

    // 最大的存活分身：镜头、视野缩放都用它（最稳，不会因为分身分散而乱跳）。
    // 全灭后回落到死细胞本身——死亡演出期间镜头要停在原地。
    largestCell() {
        let best = null;
        for (const cell of this.group.cells) {
            if (cell.alive && (best === null || cell.r > best.r)) {
                best = cell;
            }
        }
        return best || this.group.cells[0];
    }

    // 玩家整组质量（体重面板/排行榜口径）
    playerMass() {
        return groupMass(this.group.cells);
    }

    // 分裂状态：给 HUD（按钮是否可点、冷却还剩几秒、为什么不能点）。
    // 判定本身在 rules.splitStatus（纯函数、可单测），这里只补上"是否在局内"这一层。
    splitState() {
        const status = splitStatus(this.group.cells, this.world.time, this.group.lastSplitAt);
        const playing = this.state === 'playing';
        return {
            canSplit: playing && status.canSplit,
            cooldownLeft: status.cooldownLeft,
            atCellLimit: playing && status.atCellLimit,
        };
    }

    requestSplit() {
        // 冷却/门槛/上限由 world.requestSplit 把关（联机服务端走同一入口），这里只把关局内
        if (this.state !== 'playing') {
            return false;
        }
        return this.world.requestSplit(PLAYER_OWNER);
    }

    // 当前相机视口（世界坐标），供出生位置判断用
    viewRect() {
        return { x: this.camera.xView, y: this.camera.yView, w: this.camera.wView, h: this.camera.hView };
    }

    // ---------- 生命周期 ----------

    // 从开局界面进入游戏
    begin(name, difficulty) {
        this.setDifficulty(difficulty);
        if (name) {
            this.world.renameGroup(PLAYER_OWNER, name);
        }
        this.world.reset();
        this.state = 'playing';
        // 保护从真正开局那一刻开始算（菜单界面里世界时间也在走，不能在构造时发）
        this.group.cells[0].grantShield(PLAYER.spawnShield, this.world.time);
        this.updateViewScale(0, true); // 重开一局视野立刻就位，不该慢慢推
        this.camera.snapTo(this.largestCell());
        this.hud.hideStart();
    }

    // 难度只覆写 AI 的"决策质量"参数，不动速度（理由见 config.DIFFICULTY 注释）。
    // 必须在 world.reset() 之前调用：AI 是那时候才批量生成的。
    // 已经存在的 AI 也要同步——eatBonus 是在构造函数里抓进实例的，改 config 不影响存量球。
    setDifficulty(level) {
        const preset = DIFFICULTY[level] || DIFFICULTY[DEFAULT_DIFFICULTY];
        this.difficulty = DIFFICULTY[level] ? level : DEFAULT_DIFFICULTY;
        log('难度', `切换到 ${preset.label}（${this.difficulty}）`);
        for (const key of Object.keys(preset)) {
            if (key === 'label') {
                continue;
            }
            AI[key] = preset[key];
        }
        for (const ai of this.world.ai) {
            ai.eatBonus = AI.eatBonus;
            ai.foodGain = AI.foodGain;
        }
        return this.difficulty;
    }

    // 结算界面「再来一局」
    respawnPlayer(name) {
        this.world.respawnGroup(PLAYER_OWNER, name);
        this.world.reset();
        this.state = 'playing';
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.group.cells[0].grantShield(PLAYER.spawnShield, this.world.time);
        this.updateViewScale(0, true); // 重开一局视野立刻就位，不该慢慢推
        this.camera.snapTo(this.largestCell());
        this.hud.hideSettlement();
    }

    // 左下角「菜单」：结束本局，回到开局界面。
    // state 置回 'menu' 就会停掉 world.update（世界冻结），跟开局界面一致；
    // 分身/质量/冷却全部由 respawnGroup 清干净，不会带着上一局的巨大体型继续。
    quitToMenu() {
        this.state = 'menu';
        this.world.respawnGroup(PLAYER_OWNER);
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.updateViewScale(0, true); // 重开一局视野立刻就位，不该慢慢推
        this.camera.snapTo(this.largestCell());
        this.hud.showStart();
    }

    // 世界事件 → 表现层。只处理本地玩家组的事；联机时服务端用同一个回调
    // 处理所有组的事件（这是 World 不直接调 hud 的原因）。
    onWorldEvent(event) {
        if (event.type === 'eaten' && event.ownerId === PLAYER_OWNER && this.state === 'playing') {
            this.onPlayerEaten(event.mass, event.rank, event.by);
        } else if (event.type === 'crowned' && event.ownerId === PLAYER_OWNER && this.state === 'playing') {
            this.onCrowned();
        }
    }

    // 整组玩家细胞都被吃光才算死。finalMass 是「死亡瞬间」的质量：
    // World 在裁定之前取好随事件带来，结算不会显示成 0kg。
    // 死亡不立刻弹结算：先进 'dying' 演出（世界慢放 + 红闪），让玩家看清
    // "是谁、在哪里吃掉了我"，播完由 finishDeath 弹结算。数据在死亡瞬间定格。
    onPlayerEaten(finalMass, rank, killer) {
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.state = 'dying';
        this.dyingTimer = DEATH.cueSeconds;
        log('被吃', `${killer ? `${killer.name} 在 ` : ''}最终 ${Math.round(finalMass)}kg，`
            + `存活 ${this.group.stats.playTime.toFixed(1)}s`, 'warn');
        this.hud.showDeathFlash();
        this.settlementStats = {
            weight: Math.round(finalMass),
            rank,
            time: this.group.stats.playTime,
            food: this.group.stats.foodEaten,
            kills: this.group.stats.kills,
            name: this.group.name,
            crowned: false,
        };
    }

    // 死亡演出结束：此刻才冻结世界、弹结算层
    finishDeath() {
        this.state = 'dead';
        this.hud.showSettlement(this.settlementStats);
    }

    // 称王：单局的终点（质量达标 + 当前第一），与死亡一样把世界冻住。
    onCrowned() {
        const mass = this.playerMass();
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.state = 'crowned';
        log('称王', `${Math.round(mass)}kg，存活 ${this.group.stats.playTime.toFixed(1)}s`, 'warn');
        this.hud.showSettlement({
            weight: Math.round(mass),
            rank: 1,
            time: this.group.stats.playTime,
            food: this.group.stats.foodEaten,
            kills: this.group.stats.kills,
            name: this.group.name,
            crowned: true,
        });
    }

    // 排行榜数据（本地玩家按整组质量算一条）
    leaderboard() {
        return this.world.leaderboard(PLAYER_OWNER);
    }

    // ---------- 逻辑更新 ----------

    update(dt) {
        // 本地输入交给自己的组；世界只在 playing/dying 推进
        if (this.state === 'playing') {
            this.group.input.speedX = this.input.speedX;
            this.group.input.speedY = this.input.speedY;
            this.world.update(dt);
        } else if (this.state === 'dying') {
            // 死亡演出：世界按 DEATH.slowMoScale 慢放（世界时间跟着走，
            // 否则 AI 重生倒计时会相对世界提前），演出计时用真实秒。
            const scaled = dt * DEATH.slowMoScale;
            this.group.input.speedX = this.input.speedX;
            this.group.input.speedY = this.input.speedY;
            this.world.update(scaled);
            this.dyingTimer -= dt;
            if (this.dyingTimer <= 0) {
                this.finishDeath();
            }
        }
        // 出生保护标记：给 draw 画光环用
        for (const ball of this.world.balls) {
            ball.shielded = ball.alive && ball.isProtected(this.world.time);
        }
        this.updateViewScale(dt);
        this.camera.follow(this.largestCell());
        this.camera.update();
        this.hud.update(dt, this);
        this.tickDiagnostics(dt);
    }

    // 每秒记一次快照 + 帧耗时：出事后回头查日志时，光有"某球消失"是查不出
    // 它旁边站着谁的，得有一条时间线把当时场上什么情况钉住。
    // 关着日志时这里只多一次 timer 比较，开销可忽略。
    tickDiagnostics(dt) {
        this.frameMs = this.frameMs === undefined ? dt * 1000 : this.frameMs * 0.9 + dt * 1000 * 0.1;
        this.snapshotTimer = (this.snapshotTimer || 0) + dt;
        if (this.snapshotTimer < 1) {
            return;
        }
        this.snapshotTimer = 0;
        let top = 0;
        for (const ai of this.world.ai) {
            if (ai.alive && ai.mass > top) {
                top = ai.mass;
            }
        }
        logSnapshot(() => ({
            mass: Math.round(this.playerMass()),
            rank: this.group.cells.some((cell) => cell.alive)
                ? rankOfGroup(this.playerMass(), this.world.ai)
                : '-',
            alive: this.world.ai.filter((ai) => ai.alive).length,
            topAi: Math.round(top),
            fps: Math.round(1 / dt),
            frameMs: this.frameMs.toFixed(1),
        }));
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
        this.fitScale = Math.max(cssWidth / WORLD.width, cssHeight / WORLD.height) / VIEW.maxZoomOut;
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
        const auto = Math.max(
            this.fitScale,
            Math.max(this.cssWidth, this.cssHeight) / (VIEW.longEdgeWorld * sizeZoom),
        );
        return zoomTarget(auto, this.fitScale, this.userZoom, VIEW.userZoomMax);
    }

    // 用户缩放入口（滚轮 / +、- 键 / 双指捏合都走这里）：只改系数。
    // 画面的平滑交给 updateViewScale——系数一变目标就变，scale 按既定速率逼近，不会硬跳。
    zoomBy(factor) {
        this.userZoom = clamp(this.userZoom * factor, VIEW.userZoomMin, VIEW.userZoomMax);
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
        // 裁剪边距按抖动后的半径上限算，不然视口边缘的大颗会凭空消失
        const pad = FOOD.radius * (1 + FOOD.radiusJitter);
        const viewLeft = this.camera.xView - pad;
        const viewRight = this.camera.xView + this.camera.wView + pad;
        const viewTop = this.camera.yView - pad;
        const viewBottom = this.camera.yView + this.camera.hView + pad;

        for (const food of this.world.foodList) {
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
                // 先 moveTo 才能让同一路径里每颗食物都是独立子路径；
                // 半径按颗取（抖动只影响绘制，不进吃判定）
                context.moveTo(food.x + food.radius, food.y);
                context.arc(food.x, food.y, food.radius, 0, Math.PI * 2);
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
        for (const ai of this.world.ai) {
            if (ai.alive) {
                ai.draw(context);
            }
        }
        for (const cell of this.group.cells) {
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
