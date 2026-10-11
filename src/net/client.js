// 联机客户端（TODO.md 第二阶段 M1）。
//
// 世界在服务端跑，客户端只做两件事：把输入发上去、把快照渲染出来。
// NetSession 管连接与动作；NetWorld 把快照变成 Game 能直接画的形状——
// 刻意和 core/World 鸭子类型同构（foodList / ai / groups / time），
// Game 的渲染与 HUD 代码不感知数据来自网络还是本地模拟。
//
// 渲染口径：所有球（含自己的）都按「快照时间 - 100ms」在两帧快照间插值，
// 这是 M1 的诚实做法；本地预测是 M3 的事（TODO.md），不要在这里偷偷加。
import { COLORS, FOOD, WORLD } from '../config.js';
import { Ball } from '../core/ball.js';
import { configHash } from '../core/config-hash.js';

const INTERP_DELAY = 0.1; // 远程球渲染滞后于服务端 100ms（5 帧 @20Hz），足够吃掉局域网抖动
const INPUT_EVERY_FRAMES = 2; // 输入最多 30Hz（按游戏帧计，变化才发，松手必发）
const RECONCILE_PER_SNAPSHOT = 0.15; // 对账：每次快照把预测误差拉回 15%（≈0.3s 收敛）
const SNAP_ERROR_RATIO = 1; // 误差超过「半径 × 1」直接吸附（被吃/被挤开/传送，预测错了就认）
const SNAP_TIMEOUT_MS = 5000;

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
        this.onEvent = () => {}; // Game 注入：eaten / crowned / left / disconnected
        this.inputFrames = 0; // 游戏帧计数（sendInput 的节流基准）
        this.lastSentFrame = 0;
        this.lastInput = { x: NaN, y: NaN };
    }

    // 连接 + join + 等 welcome。失败抛错（房间满 / 版本不一致 / 连不上），
    // 调用方把错误显示给玩家。
    async join({ name, viewport }) {
        await loadSocketIo();
        // 直连 websocket：默认的轮询回退会在弱网/防火墙下反复升降级，表现为卡顿
        const socket = window.io({ transports: ['websocket'], timeout: SNAP_TIMEOUT_MS });
        this.socket = socket;
        let welcome;

        try {
            welcome = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => finish(new Error('连接超时（房主开服了吗？）')), SNAP_TIMEOUT_MS);
                const finish = (errOrWelcome) => {
                    clearTimeout(timer);
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
                socket.on('connect', () => socket.emit('join', { name, viewport }));
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

        // welcome 不含场上实体的快照帧（food/roster/board 除外），等第一帧 snapshot
        // 把球补齐再开始渲染，避免"先看到空世界再突然出现一群球"。
        this.world = new NetWorld(welcome, await this.firstSnapshot());
        socket.on('snapshot', (snap) => this.world.applySnapshot(snap));
        // roster 广播的载荷是 { entries }（join/离开时服务端发的），welcome 里才是裸数组
        socket.on('roster', (payload) => this.world.applyRoster(payload.entries));
        socket.on('eaten', (payload) => this.onEvent({ type: 'eaten', ...payload }));
        socket.on('crowned', (payload) => this.onEvent({ type: 'crowned', ...payload }));
        socket.on('left', (payload) => this.onEvent({ type: 'left', ...payload }));
        socket.on('disconnect', () => this.onEvent({ type: 'disconnected' }));
        return this.world;
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
        if (!this.socket) {
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
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.world = null;
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
        this.samples = new Map(); // key -> [{t,x,y,r}, ≤2]
        this.ghosts = new Map(); // key -> Ball
        this.predictedCells = []; // 自己组的预测细胞（与 groups 里的 ghost 是同一批对象）
        for (const [id, qx, qy, ci] of welcome.food) {
            this.foodList.push(decodeFood(id, qx, qy, ci));
        }
        this.applyRoster(welcome.roster || []);
        this.applySnapshot(snap);
    }

    myGroup() {
        return this.groups.get(this.myOwnerId) || null;
    }

    applyRoster(entries) {
        this.roster = new Map(entries);
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

        // 采样：key = ownerId#index（组内顺序稳定：原球在前、分身按切出顺序追加）
        const seen = new Set();
        const cellsByOwner = new Map();
        for (const [ownerId, qx, qy, qr, sh, ci] of snap.cells) {
            const list = cellsByOwner.get(ownerId) || [];
            list.push([qx, qy, qr, sh, ci]);
            cellsByOwner.set(ownerId, list);
        }
        const takeSample = (key, qx, qy, qr) => {
            seen.add(key);
            let list = this.samples.get(key);
            if (!list) {
                list = [];
                this.samples.set(key, list);
            }
            list.push({ t: this.time, x: qx / 2, y: qy / 2, r: qr / 2 });
            if (list.length > 2) {
                list.shift();
            }
        };

        for (const [ownerId, list] of cellsByOwner) {
            list.forEach(([qx, qy, qr], index) => takeSample(`${ownerId}#${index}`, qx, qy, qr));
        }
        for (const [ownerId, qx, qy, qr] of snap.ai) {
            takeSample(`ai:${ownerId}`, qx, qy, qr);
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
            const cells = list.map(([qx, qy, qr, sh, ci], index) => {
                const ghost = this.ghostFor(`${ownerId}#${index}`, ownerId, COLORS[ci]);
                ghost.shielded = sh === 1;
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
        for (const [ownerId, qx, qy, qr, , ci] of snap.ai) {
            const ghost = this.ghostFor(`ai:${ownerId}`, ownerId, COLORS[ci]);
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
        this.reconcileMine(mine);
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
        if (prev.length !== mine.cells.length) {
            for (let i = 0; i < mine.cells.length; i += 1) {
                const s = this.referenceSample(`${this.myOwnerId}#${i}`);
                if (s) {
                    mine.cells[i].x = s.x;
                    mine.cells[i].y = s.y;
                    mine.cells[i].r = s.r;
                    mine.cells[i].displayR = s.r;
                }
            }
        } else {
            for (let i = 0; i < mine.cells.length; i += 1) {
                const s = this.referenceSample(`${this.myOwnerId}#${i}`);
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
    // 消掉与服务端权威位置之间的在途延迟（速度取最近两帧采样的差商）
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
        const age = Math.min(this.time - last.t, 0.25); // 外推不超过 250ms
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
    tick(dt, localInput) {
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
