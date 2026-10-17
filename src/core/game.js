import {
    AI,
    DEFAULT_DIFFICULTY,
    DEATH,
    DIFFICULTY,
    FOOD,
    NET,
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

// drawFood 的颜色桶常驻复用：颜色就 COLORS 那几种，帧首把桶清空而不是每帧
// 新建 Map + 每色一个新数组（747 颗食物 × 高刷屏，纯垃圾回收压力）。
const foodBuckets = new Map(); // color -> food[]

// 游戏主循环：逻辑按固定步长推进（update），渲染跟随屏幕刷新率（draw）。
// 状态流转：menu（开局界面，逻辑暂停）→ playing → dying（被吃演出：世界慢放+红闪）
//          → dead（结算界面，逻辑暂停）→ playing；playing → crowned（称王结算）
//
// Game 只是「状态机 + 调度 + 渲染 + 输入」的壳：全部玩法逻辑（食物/AI/互吃/分裂/
// 重生/称王判定）在 core/world.js 的无头世界里，联机服务端跑的就是同一份。
// 世界事件（被吃/称王）通过 onEvent 回调进来，这里只负责决定"怎么演"。
export class Game {
    // online=true 时不在本地建世界（世界在服务端，attachNet() 注入 NetWorld 渲染），
    // 其余（相机/渲染/输入/HUD）与单机完全共用。
    constructor(canvas, hud, { online = false } = {}) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');
        this.hud = hud;

        this.state = 'menu';
        this.dyingTimer = 0; // >0 时处于死亡演出（dying）倒计时
        this.settlementStats = null; // 死亡瞬间的结算数据，演出结束后才展示

        // 输入层：摇杆/键盘写这里，再同步给世界（单机写进玩家组，联机发给服务器）
        this.input = { speedX: 0, speedY: 0 };

        this.net = null; // NetSession（联机），attachNet() 注入
        this.netHadCells = false; // 联机：自己的细胞从无到有的瞬间镜头要 snap
        this.roundCountdown = 0; // 称王终局后的开新局倒计时（联机）
        this.roundInfo = null;
        this.world = null;
        this.group = null;

        // 相机先于世界：AI 出生"避开视野"要读相机视口（World.getViewRect 回调）
        this.camera = new Camera(0, 0, 0, 0, WORLD.width, WORLD.height, VIEW.cameraDeadZone);

        if (!online) {
            this.initLocalWorld();
        }

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
        // 高刷屏空帧跳过重绘：steps===0 时世界/相机/缩放都没动，画面逐像素不变就不画。
        // 凡是在 update 之外改动画面的路径（resize 清屏、场外事件）都要把它置回 true。
        this.needsRedraw = true;

        this.resize = this.resize.bind(this);
        this.loop = this.loop.bind(this);
        this.resize();

        if (this.group) {
            this.camera.follow(this.largestCell());
        }
    }

    // 本地无头世界（单机模式）。联机退出后想再玩单机，begin() 也会现调一次。
    initLocalWorld() {
        this.world = new World({
            getViewRect: () => this.viewRect(),
            onEvent: (event) => this.onWorldEvent(event),
        });
        this.group = this.world.addGroup(PLAYER_OWNER, NICKNAME.defaultName);
        // 开局按「当前体型对应的目标数量」放 AI，而不是一把放满 AI.count：
        // 目标数量会随玩家体型从 minCount 涨到 count，开局满屏对手容易被围
        this.world.spawnAi(this.world.targetAiCount());
        this.camera.follow(this.largestCell());
    }

    // ---------- 本地玩家（单机 = 本地组；联机 = 快照里自己的组） ----------

    myGroup() {
        if (this.net) {
            return this.net.world.myGroup();
        }
        return this.group;
    }

    myCells() {
        const group = this.myGroup();
        return group ? group.cells : [];
    }

    // 最大的存活分身：镜头、视野缩放都用它（最稳，不会因为分身分散而乱跳）。
    // 全灭后回落到死细胞本身——死亡演出期间镜头要停在原地。
    // 联机下组短暂缺失（死亡/未收到快照）时退到世界中心的占位球，等下一帧快照。
    largestCell() {
        let best = null;
        const cells = this.myCells();
        for (const cell of cells) {
            if (cell.alive && (best === null || cell.r > best.r)) {
                best = cell;
            }
        }
        return best || cells[0] || { x: WORLD.width / 2, y: WORLD.height / 2, r: PLAYER.radius };
    }

    // 玩家整组质量（体重面板/排行榜口径）
    playerMass() {
        return groupMass(this.myCells());
    }

    // 分裂状态：给 HUD（按钮是否可点、冷却还剩几秒、为什么不能点）。
    // 判定本身在 rules.splitStatus（纯函数、可单测），这里只补上"是否在局内"这一层。
    splitState() {
        const time = this.net ? this.net.world.time : this.world.time;
        const group = this.myGroup();
        const status = splitStatus(this.myCells(), time, group ? group.lastSplitAt : -Infinity);
        const playing = this.state === 'playing';
        return {
            canSplit: playing && status.canSplit,
            cooldownLeft: status.cooldownLeft,
            atCellLimit: playing && status.atCellLimit,
        };
    }

    requestSplit() {
        // 冷却/门槛/上限由把关方负责（单机 world.requestSplit，联机服务端同一入口），
        // 这里只把关局内。返回值表示"请求已受理"，分裂本身等服务端/世界结算。
        if (this.state !== 'playing') {
            return false;
        }
        if (this.net) {
            this.net.requestSplit();
            return true;
        }
        const ok = this.world.requestSplit(PLAYER_OWNER);
        if (ok) {
            this.needsRedraw = true; // 单机分裂立刻改了细胞布局，不等下一个逻辑步
        }
        return ok;
    }

    // ---------- 联机（NetSession 注入，见 src/net/client.js） ----------

    attachNet(session) {
        this.net = session;
        session.onEvent = (event) => this.onNetEvent(event);
    }

    // 从开局界面进入联机对局（session.join() 已完成、NetWorld 已就位）
    beginOnline() {
        this.state = 'playing';
        this.netHadCells = false; // 第一帧快照里细胞出现时 snap 镜头
        this.netViewportTimer = 0;
        this.net.sendViewport(this.cssWidth, this.cssHeight); // join 时量的尺寸可能还没就绪
        this.updateViewScale(0, true);
        this.needsRedraw = true;
        this.hud.hideStart();
        // 进场时正处上一局的结算倒计时：直接进全场结算界面，等 newRound 开新局
        if (this.net.world.roundRemaining > 0) {
            this.onRoundEnded({ ownerId: null, name: null, countdown: this.net.world.roundRemaining });
        }
    }

    onNetEvent(event) {
        // socket 事件发生在 update 之外（状态/结算层变化），空帧也要重画
        this.needsRedraw = true;
        if (event.type === 'eaten') {
            // 服务端权威：结算数据随事件带来（本地路径则是从 myGroup.stats 取）
            if (this.state === 'playing') {
                this.onPlayerEaten(event.mass, event.rank, event.by, event.stats);
            }
        } else if (event.type === 'crowned') {
            // 称王即终局：全场结算 + 倒计时自动开新局（M2 定稿，2026-10-11）
            this.onRoundEnded(event);
        } else if (event.type === 'newRound') {
            this.onNewRound();
        } else if (event.type === 'netdown') {
            // 断线但还在重连窗口内：清输入 + 世界冻住（NetWorld.tick 的 frozen），
            // 提示条说清楚"正在重连"而不是直接把人丢回菜单（见 NetSession.handleDisconnect）
            this.input.speedX = 0;
            this.input.speedY = 0;
            this.hud.showNetError(`连接中断，正在重连…（${NET.graceSeconds} 秒内可回到原球）`);
        } else if (event.type === 'resumed') {
            this.onResumed(event.death);
        } else if (event.type === 'disconnected') {
            this.state = 'menu';
            this.net.disconnect();
            this.net = null;
            this.hud.showStart();
            this.hud.showNetError('与服务器的连接已断开');
        }
    }

    // 重连成功：世界重新对上了（新的 NetWorld，细胞位置以服务端为准）。
    // ① 清掉提示；② 镜头 snap 到当前最大的分身——重连期间画面是冻住的，
    //    恢复后不 snap 的话镜头会从旧位置慢慢飘过去，看着像"球瞬移"；
    // ③ 宽限期内被 AI 吃光的话直接进结算（玩家点"重新上场"走 again 重生）。
    onResumed(death) {
        this.hud.showNetError('');
        this.netHadCells = false;
        this.camera.snapTo(this.largestCell());
        this.updateViewScale(0, true);
        this.needsRedraw = true;
        if (death) {
            const stats = (this.myGroup() && this.myGroup().stats) || { playTime: 0, foodEaten: 0, kills: 0 };
            this.onPlayerEaten(death.mass, death.rank, null, stats);
        }
    }

    // 称王即终局：所有人（含称王者）进全场结算，倒计时到点服务端重开新局。
    // 不需要点任何按钮——结算界面的重生按钮会藏起来。
    onRoundEnded(event) {
        if (this.state !== 'playing' && this.state !== 'dying') {
            return;
        }
        const isMe = event.ownerId === this.net.world.myOwnerId;
        const me = this.net.world.myGroup();
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.state = 'crowned'; // 冻结本地输入上行；世界本身已由服务端冻结
        this.roundCountdown = event.countdown;
        this.roundInfo = {
            isMe,
            winnerName: event.name || null,
            rank: this.net.world.myRank(),
        };
        log(isMe ? '称王' : '本局结束', isMe
            ? `${Math.round(this.playerMass())}kg，存活 ${me.stats.playTime.toFixed(1)}s`
            : `${event.name} 称王，我排第 ${this.roundInfo.rank}`, 'warn');
        this.hud.showSettlement({
            weight: Math.round(this.playerMass()),
            rank: this.roundInfo.rank,
            time: me.stats.playTime,
            food: me.stats.foodEaten,
            kills: me.stats.kills,
            name: this.net.world.myName,
            crowned: isMe,
            winnerName: event.name || null,
            roundSeconds: event.countdown,
        });
    }

    // 服务端倒计时到点：全新一局开始（所有人已由服务端重置并发放保护）
    onNewRound() {
        this.roundCountdown = 0;
        this.state = 'playing';
        this.netHadCells = false; // 新出生的细胞出现时 snap 镜头
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.hud.hideSettlement();
    }

    // 当前相机视口（世界坐标），供出生位置判断用
    viewRect() {
        return { x: this.camera.xView, y: this.camera.yView, w: this.camera.wView, h: this.camera.hView };
    }

    // 世界坐标 → CSS 像素。scale 是「世界单位 → CSS 像素」，所以视口左上角为原点。
    // 鼠标操控要的就是这个换算（球在屏幕上的位置 vs 光标位置）。
    // ⚠ 别乘 devicePixelRatio：画布内部是 dpr 倍，但事件坐标（clientX/Y）永远是 CSS 像素。
    worldToScreen(x, y) {
        return { x: (x - this.camera.xView) * this.scale, y: (y - this.camera.yView) * this.scale };
    }

    // 自己的球在屏幕上的位置（鼠标操控的参照点；与镜头跟随的是同一颗最大的分身）
    ballScreen() {
        const cell = this.largestCell();
        return this.worldToScreen(cell.x, cell.y);
    }

    // ---------- 生命周期 ----------

    // 从开局界面进入游戏（单机）
    begin(name, difficulty) {
        if (!this.world) {
            this.initLocalWorld(); // 联机退出后回来玩单机：现建本地世界
        }
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
        this.needsRedraw = true; // 相机 snap 发生在 update 之外，空帧也要立刻重画
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
        this.input.speedX = 0;
        this.input.speedY = 0;
        if (this.net) {
            // 联机：不 reset 世界（别人还在玩），重生进正在进行的对局；
            // 镜头在新细胞出现时 snap（update 里的 netHadCells 转换）
            this.net.again(name);
            this.state = 'playing';
            this.netHadCells = false;
            this.hud.hideSettlement();
            return;
        }
        this.world.respawnGroup(PLAYER_OWNER, name);
        this.world.reset();
        this.state = 'playing';
        this.group.cells[0].grantShield(PLAYER.spawnShield, this.world.time);
        this.updateViewScale(0, true); // 重开一局视野立刻就位，不该慢慢推
        this.camera.snapTo(this.largestCell());
        this.needsRedraw = true;
        this.hud.hideSettlement();
    }

    // 左下角「菜单」：结束本局，回到开局界面。
    // state 置回 'menu' 就会停掉 world.update（世界冻结），跟开局界面一致；
    // 单机的分身/质量/冷却由 respawnGroup 清干净，不会带着上一局的巨大体型继续。
    quitToMenu() {
        this.state = 'menu';
        if (this.net) {
            this.net.disconnect();
            this.net = null;
            this.world = null;
            this.group = null;
        } else {
            this.world.respawnGroup(PLAYER_OWNER);
        }
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.updateViewScale(0, true); // 重开一局视野立刻就位，不该慢慢推
        this.camera.snapTo(this.largestCell());
        this.needsRedraw = true;
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
    // 单机由 World 在裁定之前取好随事件带来，联机由服务端发来，结算不会显示成 0kg。
    // statsOverride：联机时服务端随事件带来的权威统计（本地路径从 myGroup.stats 取）。
    // 死亡不立刻弹结算：先进 'dying' 演出（世界慢放 + 红闪），让玩家看清
    // "是谁、在哪里吃掉了我"，播完由 finishDeath 弹结算。数据在死亡瞬间定格。
    onPlayerEaten(finalMass, rank, killer, statsOverride = null) {
        const stats = statsOverride || (this.myGroup() ? this.myGroup().stats : { playTime: 0, foodEaten: 0, kills: 0 });
        const killerName = killer === null || killer === undefined
            ? null
            : (typeof killer === 'string' ? killer : killer.name);
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.state = 'dying';
        this.dyingTimer = DEATH.cueSeconds;
        log('被吃', `${killerName ? `${killerName} 在 ` : ''}最终 ${Math.round(finalMass)}kg，`
            + `存活 ${stats.playTime.toFixed(1)}s`, 'warn');
        this.hud.showDeathFlash();
        this.settlementStats = {
            weight: Math.round(finalMass),
            rank,
            time: stats.playTime,
            food: stats.foodEaten,
            kills: stats.kills,
            name: this.net ? this.net.world.myName : this.group.name,
            crowned: false,
            online: !!this.net, // 联机：对局不会因你死亡重开，文案要如实（HUD 换按钮文案）
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
        const stats = this.myGroup() ? this.myGroup().stats : { playTime: 0, foodEaten: 0, kills: 0 };
        this.input.speedX = 0;
        this.input.speedY = 0;
        this.state = 'crowned';
        log('称王', `${Math.round(mass)}kg，存活 ${stats.playTime.toFixed(1)}s`, 'warn');
        this.hud.showSettlement({
            weight: Math.round(mass),
            rank: 1,
            time: stats.playTime,
            food: stats.foodEaten,
            kills: stats.kills,
            name: this.net ? this.net.world.myName : this.group.name,
            crowned: true,
            online: !!this.net,
        });
    }

    // 排行榜数据：单机本地算；联机用服务端 1Hz 下发的榜（isPlayer 已按自己标注）
    leaderboard() {
        if (this.net) {
            return this.net.world.board;
        }
        return this.world.leaderboard(PLAYER_OWNER);
    }

    // ---------- 逻辑更新 ----------

    update(dt) {
        if (this.net) {
            // 联机：世界在服务端。远程球走插值；自己的细胞走本地预测（零输入延迟），
            // 快照到达时平滑对账。结算弹层期间（dead/crowned）世界照常走——你能看着对局继续。
            // 断线重连窗口内 frozen：输入清零、世界冻住（服务端那边也是这样）。
            this.net.world.tick(dt, this.input, this.net.suspended);
            if (this.state === 'playing' && !this.net.suspended) {
                this.net.sendInput(this.input.speedX, this.input.speedY);
            }
            // 自己的细胞从无到有（进场/重生）：镜头立刻就位，别从死亡点慢慢飘过去
            const aliveNow = this.myCells().some((cell) => cell.alive);
            if (aliveNow && !this.netHadCells) {
                this.camera.snapTo(this.largestCell());
            }
            this.netHadCells = aliveNow;
            // 视口尺寸周期性重报：resize 事件可能被错过（转屏/地址栏收放/加载期量到 0），
            // AOI 错了玩家会"看不见被谁吃"，这份保险很便宜（3s 一次）
            this.netViewportTimer = (this.netViewportTimer || 0) + dt;
            if (this.netViewportTimer >= 3) {
                this.netViewportTimer = 0;
                this.net.sendViewport(this.cssWidth, this.cssHeight);
            }
            // 死亡演出计时照走（世界本身在服务端，不受慢放影响——联机先看个意思，M3 再对齐）
            if (this.state === 'dying') {
                this.dyingTimer -= dt;
                if (this.dyingTimer <= 0) {
                    this.finishDeath();
                }
            }
        } else if (this.state === 'playing') {
            // 本地输入交给自己的组；世界只在 playing/dying 推进
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
        if (!this.net) {
            // 出生保护标记：给 draw 画光环用（联机的 sh 位由服务端随快照下发）
            for (const ball of this.world.balls) {
                ball.shielded = ball.alive && ball.isProtected(this.world.time);
            }
        }
        // 称王终局的倒计时：每帧递减，整数秒变化时刷新结算界面文案
        if (this.roundCountdown > 0) {
            this.roundCountdown = Math.max(0, this.roundCountdown - dt);
            this.hud.updateRoundCountdown(Math.ceil(this.roundCountdown), this.roundInfo);
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
        const world = this.net ? this.net.world : this.world;
        if (!world) {
            return; // 联机尚未 attach 时没有可记录的世界
        }
        this.frameMs = this.frameMs === undefined ? dt * 1000 : this.frameMs * 0.9 + dt * 1000 * 0.1;
        this.snapshotTimer = (this.snapshotTimer || 0) + dt;
        if (this.snapshotTimer < 1) {
            return;
        }
        this.snapshotTimer = 0;
        let top = 0;
        for (const ai of world.ai) {
            if (ai.alive && ai.mass > top) {
                top = ai.mass;
            }
        }
        logSnapshot(() => ({
            mass: Math.round(this.playerMass()),
            rank: this.myCells().some((cell) => cell.alive)
                ? rankOfGroup(this.playerMass(), world.ai)
                : '-',
            alive: world.ai.filter((ai) => ai.alive).length,
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
        this.needsRedraw = true; // 重设 canvas 尺寸会清屏，下一帧必须重画（哪怕 steps===0）

        // 保证视口不大于整个世界（否则相机会被钳制出负坐标）。
        // 允许比世界大 VIEW.maxZoomOut 倍：Camera.clampView 在视口超过世界时是"居中"，
        // 所以露出一点世界外区域也不会让镜头跑到负坐标或左右横跳。
        // 不放开的话竖屏手机的缩放只活到 r≈12 就死了，"球越大看得越远"从没发生过。
        this.fitScale = Math.max(cssWidth / WORLD.width, cssHeight / WORLD.height) / VIEW.maxZoomOut;
        // 注意：这里**不**直接 snap。除了首次布局外都交给 update(dt) 平滑逼近——
        // 手机地址栏收放会高频触发 resize，硬赋值就是"视角突然扩大"的元凶。
        this.updateViewScale(0, !this.viewReady);
        // 联机：视口尺寸变了要告诉服务端（AOI 按同一套公式算每个玩家的视野）
        if (this.net) {
            this.net.sendViewport(this.cssWidth, this.cssHeight);
        }
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
    drawFood(context, world) {
        // 常驻桶帧首清空（桶数量 = 颜色数，很小；清空已存在的桶即可）
        for (const bucket of foodBuckets.values()) {
            bucket.length = 0;
        }
        // 裁剪边距按抖动后的半径上限算，不然视口边缘的大颗会凭空消失
        const pad = FOOD.radius * (1 + FOOD.radiusJitter);
        const viewLeft = this.camera.xView - pad;
        const viewRight = this.camera.xView + this.camera.wView + pad;
        const viewTop = this.camera.yView - pad;
        const viewBottom = this.camera.yView + this.camera.hView + pad;

        for (const food of world.foodList) {
            if (food.x < viewLeft || food.x > viewRight || food.y < viewTop || food.y > viewBottom) {
                continue;
            }
            let bucket = foodBuckets.get(food.color);
            if (bucket === undefined) {
                bucket = [];
                foodBuckets.set(food.color, bucket);
            }
            bucket.push(food);
        }

        context.lineWidth = 1;
        for (const [color, list] of foodBuckets) {
            if (list.length === 0) {
                continue;
            }
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
        // 球名字的文本对齐每帧设一次（Ball.draw 里不再逐球设置）；整个渲染面只有球名字用文字
        context.textAlign = 'center';
        context.textBaseline = 'bottom';

        map.draw(context, camera);

        // 球的来源：单机是本地 World，联机是快照驱动的 NetWorld（消费面同构）。
        // 绘制顺序：AI → 远端玩家的组 → 自己的组，保证自己的球始终在最上层。
        const world = this.net ? this.net.world : this.world;
        if (world) {
            // 食物（按视口裁剪 + 按颜色合批）
            this.drawFood(context, world);

            for (const ai of world.ai) {
                if (ai.alive && this.inView(ai)) {
                    ai.draw(context);
                }
            }
            const myId = this.net ? this.net.world.myOwnerId : PLAYER_OWNER;
            for (const group of world.groups.values()) {
                if (group.ownerId === myId) {
                    continue;
                }
                for (const cell of group.cells) {
                    if (cell.alive && this.inView(cell)) {
                        cell.draw(context);
                    }
                }
            }
            for (const cell of this.myCells()) {
                if (cell.alive && this.inView(cell)) {
                    cell.draw(context);
                }
            }
        }

        context.restore();
    }

    // 圆-视口相交判断：屏外的球不画。余量要盖住超出圆本体的部分——
    // 保护光环（1.28r + 线宽）与名字文字（最高约 0.7r + 4），取 0.8r + 8 世界单位。
    inView(ball) {
        const r = ball.displayR;
        const pad = r * 0.8 + 8;
        return ball.x + r + pad >= this.camera.xView
            && ball.x - r - pad <= this.camera.xView + this.camera.wView
            && ball.y + r + pad >= this.camera.yView
            && ball.y - r - pad <= this.camera.yView + this.camera.hView;
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

        // 高刷屏空帧跳过重绘：固定步长 60Hz 下，120Hz 设备一半的 rAF 帧 steps===0，
        // 此时世界/相机/缩放都没动过——联机插值也在 NetWorld.tick 里随 update 推进，
        // 不在 draw 路径上——画面逐像素不变，重画纯属浪费。例外：resize 清过屏
        // （needsRedraw），或场外事件改了要画的东西（联机快照到达置 world.dirty）。
        const netDirty = this.net && this.net.world ? this.net.world.dirty : false;
        if (steps > 0 || this.needsRedraw || netDirty) {
            this.draw();
            this.needsRedraw = false;
            if (netDirty) {
                this.net.world.dirty = false;
            }
        }
        window.requestAnimationFrame(this.loop);
    }

    start() {
        this.lastTime = performance.now();
        this.hud.updateWeight(this.playerMass());
        window.requestAnimationFrame(this.loop);
    }
}
