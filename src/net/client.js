// 联机客户端（TODO.md 第二阶段 M1）。
//
// 世界在服务端跑，客户端只做两件事：把输入发上去、把快照渲染出来。
// NetSession 管连接与动作；NetWorld 把快照变成 Game 能直接画的形状——
// 刻意和 core/World 鸭子类型同构（foodList / ai / groups / time），
// Game 的渲染与 HUD 代码不感知数据来自网络还是本地模拟。
//
// 渲染口径：所有球（含自己的）都按「快照时间 - 100ms」在两帧快照间插值，
// 这是 M1 的诚实做法；本地预测是 M3 的事（TODO.md），不要在这里偷偷加。
import { COLORS, FOOD, NET, SPLIT, WORLD } from '../config.js';
import { Ball } from '../core/ball.js';
import { configHash } from '../core/config-hash.js';
import { aiKey, cellKey, decodeBall } from '../core/protocol.js';
import { groupMass } from '../core/rules.js';

const INTERP_DELAY = 0.1; // 远程球渲染滞后于服务端 100ms（5 帧 @20Hz），足够吃掉局域网抖动
const INPUT_EVERY_FRAMES = 2; // 输入最多 30Hz（按游戏帧计，变化才发，松手必发）
const RECONCILE_PER_SNAPSHOT = 0.15; // 对账：每次快照把预测误差拉回 15%（≈0.3s 收敛）
const SNAP_ERROR_RATIO = 1; // 误差超过「半径 × 1」直接吸附（被吃/被挤开/传送，预测错了就认）
const SNAP_TIMEOUT_MS = 5000;
const RESUME_STORAGE_KEY = 'superpop:resumeToken';

// socket.io 的浏览器端由服务端托管（/socket.io/socket.io.js），
// 按需注入 <script>：单机玩家不付这份请求。
function loadSocketIo() {
    if (window.io) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/socket.io/socket.io.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('socket.io 客户端脚本加载失败'));
        document.head.appendChild(script);
    });
}

export class NetSession {
    constructor() {
        this.socket = null;
        this.world = null; // welcome 之后是 NetWorld
        this.onEvent = () => {}; // Game 注入: eaten / crowned / left / netdown / resumed / disconnected
        this.inputFrames = 0; // 游戏帧计数（sendInput 的节流基准）
        this.lastSentFrame = 0;
        this.lastInput = { x: NaN, y: NaN };
        // 断线重连要用回来的东西：名字、视口、上次拿到的认领令牌
        this.name = '';
        this.viewport = null;
        this.token = '';
        this.death = null; // 重连时服务端告知"宽限期内你被吃光了"的死亡瞬间数据
        // 断线后为 true：本地预测与输入上行都停（服务端那边输入已清零，
        // 还按老样子推的话球会在本地继续漂，重连后又被吸附回去，看着像抽搐）
        this.suspended = false;
        this.reconnecting = false;
        this.closed = false; // disconnect() 是我们自己主动断的，别触发重连
    }

    // 连接 + join + 等 welcome。失败抛错（房间满 / 版本不一致 / 连不上），
    // 调用方把错误显示给玩家。
    // token 非空时走「认领」路径：服务端会用原 ownerId 与原细胞把组还回来。
    async join({ name, viewport, token = '' }) {
        await loadSocketIo();
        // 直连 websocket：默认的轮询回退会在弱网/防火墙下反复升降级，表现为卡顿。
        // reconnection 关掉：自动重连由 NetSession.resume 自己管（要拿令牌认领、
        // 要控制退避、还要在恢复后重挂一遍监听），交给 socket.io 就管不了这些。
        const socket = window.io({ transports: ['websocket'], timeout: SNAP_TIMEOUT_MS, reconnection: false });
        this.socket = socket;
        this.closed = false;
        let welcome;

        try {
            welcome = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => finish(new Error('连接超时（房主开服了吗？）')), SNAP_TIMEOUT_MS);
                const finish = (errOrWelcome) => {
                    clearTimeout(timer);
                    socket.off('connect'); // join 已完成/已失败：重连复活时不能再发一次 join
                    socket.off('welcome');
                    socket.off('rejected');
                    socket.off('connect_error');
                    if (errOrWelcome instanceof Error) {
                        socket.disconnect();
                        reject(errOrWelcome);
                    } else {
                        resolve(errOrWelcome);
                    }
                };
                socket.on('connect', () => socket.emit('join', { name, viewport, token }));
                socket.on('welcome', (w) => {
                    if (w.configHash !== configHash()) {
                        finish(new Error('两端版本不一致：请刷新页面（Ctrl+F5）后重进'));
                        return;
                    }
                    finish(w);
                });
                socket.on('rejected', (r) => finish(new Error(r.reason || '被服务器拒绝')));
                socket.on('connect_error', () => finish(new Error('连不上服务器（房主需运行 npm run server）')));
            });
        } catch (err) {
            this.socket = null;
            throw err;
        }

        this.name = welcome.resumed ? this.name : name;
        this.viewport = viewport;
        this.token = welcome.resumeToken || '';
        this.death = welcome.death || null;
        this.rememberToken();

        // welcome 不含场上实体的快照帧（food/roster/board 除外），等第一帧 snapshot
        // 把球补齐再开始渲染，避免"先看到空世界再突然出现一群球"。
        this.world = new NetWorld(welcome, await this.firstSnapshot());
        this.attachHandlers(socket);
        return this.world;
    }

    // snapshot / roster / 各类事件的监听：**每次 join（含重连）都要重挂一遍**。
    // 只写处理器不绑监听是本项目踩过的坑（事件静默丢失、状态卡死）。
    attachHandlers(socket) {
        socket.on('snapshot', (snap) => this.world.applySnapshot(snap));
        // roster 广播的载荷是 { entries }（join/离开时服务端发的），welcome 里才是裸数组
        socket.on('roster', (payload) => this.world.applyRoster(payload.entries));
        socket.on('eaten', (payload) => this.onEvent({ type: 'eaten', ...payload }));
        socket.on('crowned', (payload) => this.onEvent({ type: 'crowned', ...payload }));
        socket.on('newRound', (payload) => this.onEvent({ type: 'newRound', ...payload }));
        socket.on('left', (payload) => this.onEvent({ type: 'left', ...payload }));
        socket.on('disconnect', () => this.handleDisconnect());
    }

    // 断线：自己退避重连，而不是立刻回菜单。
    // 为什么不是直接 disconnected：手机上锁屏、切 Wi-Fi、进电梯都会断一下就回来，
    // 一次断线就把玩家踢出对局、还要重新起名，太粗。服务端有 NET.graceSeconds 的
    // 宽限期在等着认领原细胞（server/index.js）。
    // 重试全失败（或压根没有令牌可认领）才报 disconnected 交回菜单。
    handleDisconnect() {
        if (this.closed) {
            return; // disconnect() 主动断的，调用方自己处理
        }
        this.suspended = true;
        if (!this.token) {
            this.onEvent({ type: 'disconnected' });
            return;
        }
        this.onEvent({ type: 'netdown' });
        this.resume();
    }

    // 退避重连：重连成功 = 认领回原来的细胞（同 ownerId / 同 cid，ghost 不瞬移）。
    // 重试窗口要略大于服务端宽限期（NET 注释里有推导），否则会出现
    // "客户端还在重试、服务端已经把人删了" → 认领失败、退化成新人进场的空档。
    async resume() {
        if (this.reconnecting) {
            return false;
        }
        this.reconnecting = true;
        let delay = NET.reconnectDelayMs;
        try {
            for (let attempt = 0; attempt < NET.reconnectTries; attempt += 1) {
                try {
                    await this.join({ name: this.name, viewport: this.viewport, token: this.token });
                    this.suspended = false;
                    this.onEvent({ type: 'resumed', death: this.death });
                    return true;
                } catch {
                    // 认领失败（房主没开、退避期间 socket 一直没建起来）就等下一拍
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    delay = Math.min(NET.reconnectMaxDelayMs, delay * NET.reconnectBackoff);
                }
            }
        } finally {
            this.reconnecting = false;
        }
        // 退避用尽：服务端那边多半也已经过了宽限期（组被移除），认不回来了
        this.onEvent({ type: 'disconnected' });
        return false;
    }

    // 令牌放 sessionStorage：手机上进后台被系统回收页面、或手动刷新之后回来，
    // 还能认领回同一颗球而不是变成场上的另一个人。
    rememberToken() {
        try {
            if (this.token) {
                window.sessionStorage.setItem(RESUME_STORAGE_KEY, this.token);
            } else {
                window.sessionStorage.removeItem(RESUME_STORAGE_KEY);
            }
        } catch {
            // 隐私模式下 sessionStorage 可能抛异常。存不下只是少了一条认领路径，
            // 不影响正常联机，所以这里不往上抛（抛了会挡住整局进场）。
        }
    }

    // 上次留存的认领令牌（页面刷新/重新进场后想认领同一颗球时用）
    static savedToken() {
        try {
            return window.sessionStorage.getItem(RESUME_STORAGE_KEY) || '';
        } catch {
            return '';
        }
    }

    // 等第一帧 snapshot（welcome 与它之间只有几毫秒；错过一帧最多多等 50ms）
    firstSnapshot() {
        return new Promise((resolve) => {
            const handler = (snap) => {
                this.socket.off('snapshot', handler);
                resolve(snap);
            };
            this.socket.on('snapshot', handler);
        });
    }

    // 输入节流：变化才发、按游戏帧计最多 20Hz。**不能用真实时钟**——泵帧/高刷/卡顿
    // 恢复时几十帧挤在几毫秒真实时间里，真实时钟节流会把方向变化整段吞掉
    //（实测：机器人整个觅食期只有头 2 个包发出去，球原地不动）。
    // TCP 不丢包，服务器持有最后一份输入，不需要心跳。值取两位小数，砍掉浮点噪声。
    sendInput(x, y) {
        if (!this.socket || this.suspended) {
            return;
        }
        this.inputFrames += 1;
        const rx = Math.round(x * 100) / 100;
        const ry = Math.round(y * 100) / 100;
        const changed = rx !== this.lastInput.x || ry !== this.lastInput.y;
        if (!changed || this.inputFrames - this.lastSentFrame < INPUT_EVERY_FRAMES) {
            return;
        }
        this.lastSentFrame = this.inputFrames;
        this.lastInput = { x: rx, y: ry };
        this.socket.emit('input', { x: rx, y: ry });
    }

    requestSplit() {
        if (this.socket) {
            this.socket.emit('split');
        }
    }

    again(name) {
        if (this.socket) {
            this.socket.emit('again', { name });
        }
    }

    sendViewport(w, h) {
        if (this.socket) {
            this.socket.emit('viewport', { w, h });
        }
    }

    disconnect() {
        this.closed = true;
        this.suspended = false;
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.world = null;
        this.token = '';
        this.death = null;
        try {
            window.sessionStorage.removeItem(RESUME_STORAGE_KEY);
        } catch {
            // 存不进去无所谓（见 rememberToken 的说明）
        }
    }
}

// 服务端量化解码：坐标 ×2、颜色按 COLORS 下标、食物半径由 id 确定性生成
//（抖动是纯视觉，客户端自己重造即可，不必占带宽）。
function decodeFood(id, qx, qy, colorIdx) {
    const frac = Math.sin(id * 127.1) * 43758.5453;
    const jitter = (frac - Math.floor(frac)) * 2 - 1; // [-1, 1)
    return {
        id,
        x: qx / 2,
        y: qy / 2,
        color: COLORS[colorIdx] || COLORS[0],
        radius: FOOD.radius * (1 + jitter * FOOD.radiusJitter),
    };
}

// 在两帧采样间插值出 t 时刻的位置
function sampleAt(samples, t) {
    if (samples.length === 0) {
        return null;
    }
    if (samples.length === 1 || t <= samples[0].t) {
        return samples[0];
    }
    if (t >= samples[1].t) {
        return samples[1];
    }
    const [a, b] = samples;
    const k = (t - a.t) / (b.t - a.t);
    return {
        x: a.x + (b.x - a.x) * k,
        y: a.y + (b.y - a.y) * k,
        r: a.r + (b.r - a.r) * k,
    };
}

// 把快照流翻译成 Game 可渲染的世界（与 core/World 消费面同构）。
// 组/球列表每帧快照整体重建（≤30 个实体，便宜），ghost Ball 按 key 复用，
// displayR 逐帧平滑——半径跳变（吃食物/吞球）在 20Hz 快照下会台阶化，平滑掉。
// 导出是为了能在 node 里单测（rules-test.js），它不依赖 DOM。
export class NetWorld {
    // welcome 带食物全量/花名册/榜单，第一帧快照带场上实体——两者拼起来才是开局画面
    constructor(welcome, snap) {
        this.world = { width: WORLD.width, height: WORLD.height };
        this.time = snap.t / 1000;
        this.myOwnerId = welcome.selfId;
        this.groups = new Map(); // ownerId -> { ownerId, name, cells, stats, lastSplitAt }
        this.ai = [];
        this.balls = [];
        this.foodList = [];
        this.board = welcome.board || [];
        this.roster = new Map();
        this.myName = '';
        this.renderTime = this.time;
        // 本地时钟（秒）：估"服务端当前时间"用。提成实例字段是为了单测能注入假时钟
        this.now = () => performance.now() / 1000;
        // 服务端时间 − 本地时间 的偏移估计。取近来各快照偏移的**最大值**（min 在途延迟
        // 滤波：最快的那帧快照最接近真实时钟差），普通快照的对账年龄 = 它比最快帧多花
        // 的在途时间。若每帧都用当前快照的偏移，age 恒为 0——"按快照年龄外推"就是死代码
        //（样本时间戳来自 this.time，而 this.time 刚被设为同一帧的 snap.t）
        this.offsetWindow = []; // 近来 20 帧（≈1s）快照的 服务端时间−本地时间
        this.serverOffset = 0;
        this.arrivedAt = 0; // 最近一帧快照到达的本地时刻（本帧对账的时间基准）
        this.samples = new Map(); // key -> [{t,x,y,r}, ≤2]
        this.ghosts = new Map(); // key -> Ball
        this.predictedCells = []; // 自己组的预测细胞（与 groups 里的 ghost 是同一批对象）
        this.roundRemaining = welcome.roundRemaining || 0; // >0：进场时正处结算倒计时
        // 快照/花名册在 socket 事件里到达（update 之外）：置脏让 Game 空帧也重画，
        // 否则 120Hz 屏上食物增减/名字变化要多等一拍才上屏
        this.dirty = true;
        for (const [id, qx, qy, ci] of welcome.food) {
            this.foodList.push(decodeFood(id, qx, qy, ci));
        }
        this.applyRoster(welcome.roster || []);
        this.applySnapshot(snap);
    }

    myGroup() {
        return this.groups.get(this.myOwnerId) || null;
    }

    // 自己的名次（全场按整组质量排，AI 也算）：称王全场结算用
    myRank() {
        const mine = this.myGroup();
        if (!mine) {
            return null;
        }
        const myMass = groupMass(mine.cells);
        let rank = 1;
        for (const group of this.groups.values()) {
            if (group.ownerId === this.myOwnerId) {
                continue;
            }
            if (groupMass(group.cells) > myMass) {
                rank += 1;
            }
        }
        for (const ai of this.ai) {
            if (ai.alive && ai.mass > myMass) {
                rank += 1;
            }
        }
        return rank;
    }

    applyRoster(entries) {
        this.roster = new Map(entries);
        this.dirty = true; // 名字变了，画布上的球名字要重画
        const mine = this.roster.get(this.myOwnerId);
        if (mine) {
            this.myName = mine;
        }
        for (const [key, ghost] of this.ghosts) {
            const name = this.roster.get(ghost.ownerId);
            if (name) {
                ghost.name = name;
            }
        }
    }

    applySnapshot(snap) {
        this.time = snap.t / 1000;
        this.dirty = true; // 食物增减/实体进出 AOI 立刻生效，不等下一个逻辑步
        // 时钟同步：记录到达时刻并刷新偏移估计（窗口取最大值 = min 在途延迟滤波）。
        // 对账在同一调用内同步发生，统一用 arrivedAt 作基准——再取一次时钟的 µs 差
        // 会让"恰好吸附到服务端位置"漂出浮点误差
        this.arrivedAt = this.now();
        this.offsetWindow.push(this.time - this.arrivedAt);
        if (this.offsetWindow.length > 20) {
            this.offsetWindow.shift();
        }
        this.serverOffset = Math.max(...this.offsetWindow);

        // 食物增量
        const eaten = snap.food.e;
        const added = snap.food.a;
        if (eaten.length > 0) {
            const gone = new Set(eaten);
            this.foodList = this.foodList.filter((food) => !gone.has(food.id));
        }
        for (const [id, qx, qy, ci] of added) {
            this.foodList.push(decodeFood(id, qx, qy, ci));
        }

        // 采样：key = cellKey(ownerId, cid)，cid 是细胞的稳定身份（core/protocol.js）。
        // ⚠ 不要退回 `ownerId#index`：index 是组内数组位置，被吃一颗中间分身、或两个分身
        // 合并，都会让后面的细胞索引前移一格 —— key 复用到了别的球上，对端就看到 ghost
        // 瞬移一帧。cid 与数组位置无关：分裂时原球保留 cid、新半球拿新 cid。
        const seen = new Set();
        const cellsByOwner = new Map();
        for (const row of snap.cells) {
            const c = decodeBall(row);
            const list = cellsByOwner.get(c.ownerId) || [];
            list.push(c);
            cellsByOwner.set(c.ownerId, list);
        }
        const takeSample = (key, x, y, r) => {
            seen.add(key);
            let list = this.samples.get(key);
            if (!list) {
                list = [];
                this.samples.set(key, list);
            }
            list.push({ t: this.time, x, y, r });
            if (list.length > 2) {
                list.shift();
            }
        };

        for (const [ownerId, list] of cellsByOwner) {
            for (const c of list) {
                takeSample(cellKey(ownerId, c.cid), c.x, c.y, c.r);
            }
        }
        for (const row of snap.ai) {
            const c = decodeBall(row);
            takeSample(aiKey(c.cid), c.x, c.y, c.r);
        }

        // 消失的实体（被吃 / 离开 AOI / 断线）：样本与 ghost 一起清掉
        for (const key of [...this.samples.keys()]) {
            if (!seen.has(key)) {
                this.samples.delete(key);
                this.ghosts.delete(key);
            }
        }

        // 重建组与 AI 列表（Game.draw 的消费面）
        this.groups = new Map();
        this.ai = [];
        for (const [ownerId, list] of cellsByOwner) {
            const cells = list.map((c) => {
                const ghost = this.ghostFor(cellKey(ownerId, c.cid), ownerId, COLORS[c.colorIndex]);
                // ghost 是本地 new Ball 出来的，本来带一个**本地** cid；换成服务端的，
                // 这样"幽灵身上写的是谁的细胞"和 key 永远一致，将来谁都不会拿混。
                ghost.cid = c.cid;
                ghost.shielded = c.shielded;
                return ghost;
            });
            const group = {
                ownerId,
                name: this.roster.get(ownerId) || `?${ownerId}`,
                cells,
                stats: { playTime: 0, foodEaten: 0, kills: 0 },
                lastSplitAt: -Infinity,
            };
            this.groups.set(ownerId, group);
            if (ownerId === this.myOwnerId) {
                this.myName = group.name;
            }
        }
        for (const row of snap.ai) {
            const c = decodeBall(row);
            const ghost = this.ghostFor(aiKey(c.cid), c.ownerId, COLORS[c.colorIndex]);
            ghost.cid = c.cid;
            this.ai.push(ghost);
        }
        this.balls = [...this.ai];
        for (const group of this.groups.values()) {
            this.balls.push(...group.cells);
        }

        // 自己组的权威数据
        const mine = this.groups.get(this.myOwnerId);
        if (mine) {
            mine.stats = snap.my.stats;
            mine.lastSplitAt = snap.my.lastSplitAt;
        }
        if (snap.board) {
            this.board = snap.board;
        }
        this.detectMyMerge(mine);
        this.reconcileMine(mine);
    }

    // 合并反馈：自己这一帧活细胞变少、又没全灭 → 一定是两个分身合并了（本地补一次顿挫）。
    //
    // 服务端不下发这个量（纯表现，白占带宽），客户端由「细胞数变化」推断。
    // **只判自己这一组**：别人的组少一颗也可能是离开 AOI（不是死、不是合并），
    // 拿合并去演会演出一段根本不存在的顿挫。
    detectMyMerge(mine) {
        if (!mine) {
            return;
        }
        let alive = 0;
        let best = null;
        for (const cell of mine.cells) {
            if (cell.alive) {
                alive += 1;
                if (!best || cell.r > best.r) {
                    best = cell;
                }
            }
        }
        const shrunk = this.prevAliveCells !== undefined
            && this.prevAliveCells > alive
            && alive > 0; // 全灭是"被吃"，由 eaten 事件演死亡，不演合并
        if (shrunk && best) {
            best.mergeStun = SPLIT.mergeStunSeconds;
            best.mergeWobble = SPLIT.mergeStunWobble;
        }
        this.prevAliveCells = alive;
    }

    // 自己组的预测对账。本地模拟与服务端是同一套 Ball.update，误差主要来自
    // 输入在途（发包→服务端生效→快照回程约 20~80ms）与软碰撞/互吃推挤：
    //   · 结构变化（分裂/合并/重生/死亡，细胞数变了）：预测模型作废，吸附服务端布局
    //   · 参考点先按快照年龄外推（服务端看到的是几十 ms 前的位置，直接对账会
    //     让预测恒定超前 equilibrium = 在途位移 ÷ 拉回比例，实测口径下能差 30 单位）
    //   · 小误差每次快照拉回 15%（≈0.3s 收敛）；大误差（>半径）直接吸附
    reconcileMine(mine) {
        if (!mine) {
            this.predictedCells = [];
            return;
        }
        const prev = this.predictedCells;
        // 参考点按**细胞的 cid** 取，不按索引：索引只在数量不变时才对得上，
        // 而 split/merge 恰恰会改数组形状（结构变化分支本身就是按数量分派的）。
        const myKey = (cell) => cellKey(this.myOwnerId, cell.cid);
        if (prev.length !== mine.cells.length) {
            for (let i = 0; i < mine.cells.length; i += 1) {
                const s = this.referenceSample(myKey(mine.cells[i]));
                if (s) {
                    mine.cells[i].x = s.x;
                    mine.cells[i].y = s.y;
                    mine.cells[i].r = s.r;
                    mine.cells[i].displayR = s.r;
                }
            }
        } else {
            for (let i = 0; i < mine.cells.length; i += 1) {
                const s = this.referenceSample(myKey(mine.cells[i]));
                const cell = mine.cells[i];
                if (!s) {
                    continue;
                }
                const dx = s.x - cell.x;
                const dy = s.y - cell.y;
                if (Math.hypot(dx, dy) > Math.max(SNAP_ERROR_RATIO * cell.r, 30)) {
                    cell.x = s.x;
                    cell.y = s.y;
                } else {
                    cell.x += dx * RECONCILE_PER_SNAPSHOT;
                    cell.y += dy * RECONCILE_PER_SNAPSHOT;
                }
                cell.r = s.r; // 半径以服务端为准（成长/被吃不走本地预测）
            }
        }
        this.predictedCells = mine.cells.slice();
    }

    isMine(key) {
        return key.startsWith(`${this.myOwnerId}#`);
    }

    // 某实体最新的插值参考点：把最新采样按快照年龄外推到"现在"，
    // 消掉与服务端权威位置之间的在途延迟（速度取最近两帧采样的差商）。
    // 快照年龄 = 估计的服务端当前时间 − 最新采样时刻（不能拿 this.time 减：
    // 采样时间戳就是它写入的，减出来恒为 0，外推从未生效过）
    referenceSample(key) {
        const samples = this.samples.get(key);
        if (!samples || samples.length === 0) {
            return null;
        }
        const last = samples[samples.length - 1];
        if (samples.length === 1) {
            return last;
        }
        const prev = samples[samples.length - 2];
        const dt = last.t - prev.t;
        if (dt <= 0) {
            return last;
        }
        const serverNow = this.arrivedAt + this.serverOffset;
        const age = Math.min(Math.max(serverNow - last.t, 0), 0.25); // 外推不超过 250ms
        return {
            x: last.x + ((last.x - prev.x) / dt) * age,
            y: last.y + ((last.y - prev.y) / dt) * age,
            r: last.r,
        };
    }

    ghostFor(key, ownerId, color) {
        let ghost = this.ghosts.get(key);
        if (!ghost) {
            ghost = new Ball(0, 0, 1, color, '', ownerId);
            // 出生即定位到最新采样：不等第一帧 tick（后台页 tick 可能迟迟不跑，
            // 不这么做会看到球从 (0,0) 闪现过来）
            const samples = this.samples.get(key);
            if (samples && samples.length > 0) {
                const last = samples[samples.length - 1];
                ghost.x = last.x;
                ghost.y = last.y;
                ghost.r = last.r;
                ghost.displayR = last.r;
            }
            this.ghosts.set(key, ghost);
        }
        const name = this.roster.get(ownerId);
        if (name) {
            ghost.name = name;
        }
        if (ghost.bColor !== color) {
            ghost.bColor = color; // 重生换色
        }
        return ghost;
    }

    // 每渲染帧调用：推进插值时钟（远程球），并用本地输入推进自己的细胞（预测）。
    // localInput 传 Game.input——自己的球要的是"零延迟响应"，不是插值。
    // frozen=true（断线重连期间）：整个世界**冻住**。服务端那边输入已清零、
    // 快照也没人发，本地再按旧输入推只会让球自己漂一小段，重连后又吸附回去——
    // 玩家看到的是"球自己动了又被拽回来"，比冻住更让人以为游戏出 bug。
    tick(dt, localInput, frozen = false) {
        if (frozen) {
            return;
        }
        this.renderTime += dt;
        const target = this.time - INTERP_DELAY;
        // 落后太多（切后台/卡顿）就 4 倍速追：硬跳会让所有远程球瞬移一帧，看起来像卡顿；
        // 不许跑到服务器时间前面。
        if (this.renderTime < target - 0.25) {
            this.renderTime = Math.min(target, this.renderTime + dt * 4);
        } else if (this.renderTime > this.time) {
            this.renderTime = this.time;
        }
        const smooth = Math.min(1, dt * 12);
        for (const [key, samples] of this.samples) {
            if (this.isMine(key)) {
                continue; // 自己的细胞由本地预测驱动（见下），不插值
            }
            const ghost = this.ghosts.get(key);
            const pos = sampleAt(samples, this.renderTime);
            if (!ghost || !pos) {
                continue;
            }
            ghost.x = pos.x;
            ghost.y = pos.y;
            ghost.r = pos.r;
            ghost.alive = true;
            ghost.displayR += (ghost.r - ghost.displayR) * smooth;
        }
        // 本地预测：自己的细胞用与服务端完全同一套 Ball.update 按本地输入推进。
        // 输入到画面的延迟从 ~200ms（发包→服务端 tick→快照回程→插值延迟）降到 1 帧。
        // 分裂/合并/被吃不做预测（结构变化由对账吸附，见 reconcileMine）。
        const mine = this.myGroup();
        if (mine && localInput) {
            for (const cell of mine.cells) {
                cell.speedX = localInput.speedX;
                cell.speedY = localInput.speedY;
                cell.update(dt, this.world);
            }
        }
    }
}
