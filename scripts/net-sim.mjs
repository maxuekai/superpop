// 联机仿真：真实 socket.io + 注入延迟的三客户端对局。
//
// 为什么要有这个：联机版的预测/对账、互吃一致性、带宽，到现在只在 **LAN 直连（≈0ms）**
// 的浏览器里手测过一次（预测误差 4 单位）。0 毫秒下所有网络问题都不存在，
// 于是"150ms 延迟下预测会不会飘、带宽会不会爆"就一直是没有证据的假设。
//
// 它验证四件事（对应 TODO.md M3/M4 的验收线）：
//   ① 预测误差：自己的球按本地输入即时推进（输入→画面 1 帧），快照到达后对账。
//      验收：平均误差 < 视口宽 2%，且输入突变后 500ms 内收敛回阈值内。
//   ② 互吃两端一致：用服务端 debug:place 钩子确定性造一次互吃，断言被吃方收到 eaten、
//      自己的视图知道死了、旁观端的视图里那颗球消失且吃球方质量对得上——四处一致才算。
//   ③ 带宽预算与快照频率：按 TCP 代理实测的每端下行字节数算 B/s。
//   ④ 断线重连：宽限期内重连要**认领回原来的细胞**（同 ownerId、同 cid），
//      宽限期满则被真正移除并广播 left。真实宽限是 10s，这里用 SUPERPOP_GRACE_MS
//      把它压到 1.2s——断言要的是语义（认领成功 / 到期移除），不是那个具体秒数。
//
// 延迟是用 **TCP 代理**注入的（不是改 socket.io 的内部计时器）：传输层无关、
// 不会因为 socket.io 换传输方式就失效。注入的是**单向**延迟，RTT = 2 倍。
//
// 用法：
//   npm run sim:net                     默认跑 80ms / 150ms 两档
//   npm run sim:net -- --latency 200    只跑一档
//   npm run sim:net -- --seconds 20     加长每个档位的观测时长（带宽样本更稳）
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { io } from 'socket.io-client';

import { EAT, PLAYER, VIEW, WORLD } from '../src/config.js';
import { configHash } from '../src/core/config-hash.js';
import { cellKey } from '../src/core/protocol.js';
import { groupMass } from '../src/core/rules.js';
import { NetWorld } from '../src/net/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function flag(name, fallback) {
    const argv = process.argv.slice(2);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : fallback;
}

// ---------- 验收阈值（口径写在这里，方便有人质疑时先看这里）----------
const PREDICT_RATIO = 0.02;        // 预测误差 ≤ 视口宽的 2%
const CONVERGE_MS = 500;           // 输入突变后多久要收敛回阈值内
const BANDWIDTH_BUDGET = 10 * 1024; // 每端 10 KB/s（TODO.md M1 的预算）
const SNAPSHOT_MIN_HZ = 15;        // 20Hz 发射，掉到这个数以下说明插值缓冲会被打穿

const STEP = 1 / 60;

// ---------- 起服务端 ----------
function startServer(port) {
    const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
        env: {
            ...process.env,
            PORT: String(port),
            SUPERPOP_DEBUG: '1',
            // 断线宽限期压到 1.2s：真机值是 10s，仿真里等 10s 只为验一个语义不划算
            SUPERPOP_GRACE_MS: '1200',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            if (/http:\/\/localhost:(\d+)/.test(out)) {
                clearInterval(timer);
                resolve({ child });
            }
        }, 100);
        child.on('exit', (code) => {
            clearInterval(timer);
            reject(new Error(`服务端提前退出（code ${code}）：\n${out}`));
        });
        setTimeout(() => {
            clearInterval(timer);
            reject(new Error(`服务端 15 秒没起来：\n${out}`));
        }, 15000);
    });
}

// ---------- 延迟注入：TCP 代理 ----------
// 每个连接单独计数下行/上行字节——带宽预算按"每端"算，必须分得开谁是谁。
function startProxy(targetPort, delayMs) {
    const counters = [];
    const server = net.createServer((client) => {
        const upstream = net.connect(targetPort, '127.0.0.1');
        const counter = { down: 0, up: 0 };
        counters.push(counter);
        const forward = (from, to, key) => {
            from.on('data', (chunk) => {
                counter[key] += chunk.length;
                // 每个 chunk 延迟 delayMs：转发是顺序排队的，不会乱序，等价于单向延迟
                setTimeout(() => {
                    if (!to.destroyed) {
                        to.write(chunk);
                    }
                }, delayMs);
            });
        };
        forward(client, upstream, 'down');
        forward(upstream, client, 'up');
        client.on('error', () => {});
        upstream.on('error', () => {});
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, counters, port: server.address().port }));
    });
}

// ---------- 仿真客户端 ----------
class SimClient {
    constructor(label, name, viewport) {
        this.label = label;
        this.name = name;
        this.viewport = viewport;
        this.events = [];
        this.snapshots = 0;
        this.snapAt = [];
        this.input = { x: 0, y: 0 };
        this.net = null;
        this.ownerId = null;
        this.token = null; // welcome.resumeToken：断线重连的认领凭证
    }

    // token 传入 = 走「认领」路径（断线后重连）。传空 = 新玩家进场。
    connect(url, { token = '' } = {}) {
        return new Promise((resolve, reject) => {
            const socket = io(url, {
                transports: ['websocket'],
                forceNew: true,
                reconnection: false,
            });
            this.socket = socket;
            let welcome = null;
            const timer = setTimeout(() => reject(new Error(`${this.label} 连接超时`)), 15000);

            socket.on('connect', () => {
                socket.emit('join', { name: this.name, viewport: this.viewport, token });
            });
            socket.on('welcome', (w) => {
                // 与真实客户端同一道关：两端 configHash 不一致当场拒绝，不带着错位的值进游戏
                if (w.configHash !== configHash()) {
                    clearTimeout(timer);
                    reject(new Error(`${this.label} configHash 不一致：服务端 ${w.configHash} / 本地 ${configHash()}`));
                    return;
                }
                welcome = w;
                this.ownerId = w.selfId;
                this.token = w.resumeToken;
                this.welcome = w;
            });
            socket.on('snapshot', (snap) => {
                this.snapshots += 1;
                this.snapAt.push(Date.now());
                if (!this.net) {
                    if (!welcome) {
                        return;
                    }
                    this.net = new NetWorld(welcome, snap); // 与 NetSession.connect 同一条路径
                    clearTimeout(timer);
                    resolve(this);
                } else {
                    this.net.applySnapshot(snap);
                }
            });
            for (const ev of ['eaten', 'crowned', 'newRound', 'left']) {
                socket.on(ev, (payload) => this.events.push({ type: ev, payload, at: Date.now() }));
            }
            socket.on('rejected', (r) => {
                clearTimeout(timer);
                reject(new Error(`${this.label} 被拒绝：${r.reason}`));
            });
            socket.on('connect_error', (e) => {
                clearTimeout(timer);
                reject(new Error(`${this.label} 连不上：${e.message}`));
            });
        });
    }

    tick(dt) {
        // ⚠ 形状：线上协议是 input{x,y}，但 NetWorld.tick 要的是 **Game.input 口径**
        // 的 {speedX, speedY}（Game 也是这么调的）。传错形状不会报错，只会让球算出
        // NaN 位置——量预测误差时表现为误差恒为 NaN，非常难查。
        this.net?.tick(dt, { speedX: this.input.x, speedY: this.input.y });
    }

    sendInput() {
        this.socket.emit('input', this.input);
    }

    place(payload) {
        this.socket.emit('debug:place', payload);
    }

    ownMass() {
        const mine = this.net?.myGroup();
        return mine ? groupMass(mine.cells) : 0;
    }

    aliveCells() {
        const mine = this.net?.myGroup();
        return mine ? mine.cells.filter((c) => c.alive).length : 0;
    }

    // 预测误差：本地预测的位置 vs 客户端自己外推出来的"服务端认为我现在在哪"。
    // 用 referenceSample（已按快照年龄外推）是公平口径——直接拿最新原始快照样本比，
    // 量到的是在途延迟本身，不是预测的锅。
    predictionError() {
        const net = this.net;
        const mine = net?.myGroup();
        if (!mine || mine.cells.length === 0) {
            return null;
        }
        let worst = 0;
        for (const cell of mine.cells) {
            const ref = net.referenceSample(cellKey(net.myOwnerId, cell.cid));
            if (!ref) {
                return null;
            }
            worst = Math.max(worst, Math.hypot(cell.x - ref.x, cell.y - ref.y));
        }
        return worst;
    }

    close() {
        this.socket?.close();
    }
}

// 与服务端 aoiRect / 客户端 updateViewScale 同一套 VIEW 公式，算出视口宽（世界单位）
function viewportWidthWorld(viewport, radius) {
    const { w, h } = viewport;
    const fitScale = Math.max(w / WORLD.width, h / WORLD.height) / VIEW.maxZoomOut;
    const sizeZoom = Math.pow(radius / PLAYER.radius, VIEW.zoomExponent);
    const scale = Math.max(fitScale, Math.max(w, h) / (VIEW.longEdgeWorld * sizeZoom));
    return w / scale;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 让所有客户端按 60Hz 推进 ms 毫秒（同时按 ~30Hz 发输入，和真实客户端同频）
async function pump(clients, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        for (const c of clients) {
            c.tick(STEP);
            if (Math.random() < 0.5) {
                c.sendInput();
            }
        }
        await sleep(STEP * 1000);
    }
}

// 摆位之后**轮询等客户端确认**，而不是"等固定一秒就取值"。
// 固定等待读到的是摆位前的陈旧值：摆位把 r 设成 10（100kg），客户端视图里却还是
// 阶段 1 长出来的 144kg，于是"被吃质量 = 吃前质量"会随机地挂——一条时好时坏的断言
// 比没有断言更坏，它会让人怀疑代码而不是怀疑口径。
async function waitFor(clients, fn, timeoutMs, label, client = null) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (fn()) {
            return true;
        }
        await pump(clients, 100);
    }
    // 超时要把真实状态打出来：摆位没生效有太多可能（没活细胞 / 被 AI 吃了 / 位置被推走），
    // 只说"超时"的话排查只能靠猜。
    const mine = client?.net?.myGroup();
    const cells = mine ? mine.cells.map((c) => ({
        cid: c.cid,
        alive: c.alive,
        r: c.r,
        x: Math.round(c.x),
        y: Math.round(c.y),
        ref: client.net.referenceSample(cellKey(client.net.myOwnerId, c.cid)),
    })) : null;
    throw new Error(`等待「${label}」超时（${timeoutMs}ms）：`
        + `活细胞 ${client ? client.aliveCells() : '?'}，视图 ${JSON.stringify(cells)}，`
        + `事件 ${client ? client.events.map((e) => e.type).join(',') : ''}`);
}

// 客户端视图是否已经跟上服务端：位置到了附近、半径不小于摆的目标值太多。
// ⚠ 半径只能用**相对**容差，且**只卡下界**：球在持续吃食物长大，摆完位 r=40 的球
// 几秒就长到 41.5，卡死容差（±0.6）的话这条永远等不到，会被误判成"摆位没生效"。
// ⚠ 上界也必须放宽到很松（r × 3）：摆完位球是**静止**的，r=15 的球吃几秒食物就长到 19，
// 半径单调增长 —— 上界卡得紧就等于"永远等不到"，于是这条断言在食物多的布局下必挂，
// 而且挂的时候会让人以为服务端没生效。上界只留一个粗 sanity（认得出是同一颗量级的球）。
// ⚠ 位置必须取 referenceSample（快照里的服务端权威值，已按快照年龄外推），
// **不能直接取 cell.x**：自己的球在客户端是本地预测的，每帧都在按输入移动，
// 摆完位还会继续漂，拿它判"到位没"会永远等不到。
function cellSeenAt(client, x, y, r) {
    const net = client.net;
    const mine = net?.myGroup();
    if (!mine) {
        return false;
    }
    const cell = mine.cells.find((c) => c.alive);
    if (!cell) {
        return false;
    }
    const ref = net.referenceSample(cellKey(net.myOwnerId, cell.cid));
    if (!ref) {
        return false;
    }
    return ref.r >= r - 0.6 && ref.r <= r * 3 && Math.hypot(ref.x - x, ref.y - y) <= 6;
}

// 确保这端活着，必要时重生。
// ⚠ 必须重试：死亡要经过一个往返才到服务端，客户端看到自己死了就发 again 的话，
// 服务端那边可能还认为它活着——again 是带"还有活细胞就拒绝"校验的，于是这次重生
// 被静默丢掉，后面所有摆位都变成 no-op，最后表现为"等待摆位生效超时"。
async function ensureAlive(client, clients) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        if (client.aliveCells() > 0) {
            return true;
        }
        client.socket.emit('again', { name: client.name });
        await pump(clients, 500);
    }
    return client.aliveCells() > 0;
}

// ---------- 跑一档延迟 ----------
async function runOne(delayMs, seconds) {
    const serverPort = 3400 + Math.floor(Math.random() * 90);
    const server = await startServer(serverPort);
    const proxy = await startProxy(serverPort, delayMs);
    const url = `http://127.0.0.1:${proxy.port}`;
    const viewport = { w: 800, h: 600 };

    const hunter = new SimClient('甲(吃球方)', '甲', viewport);
    const prey = new SimClient('乙(被吃方)', '乙', viewport);
    const observer = new SimClient('丙(旁观)', '丙', { w: 1280, h: 720 });
    const clients = [hunter, prey, observer];
    try {
        await Promise.all(clients.map((c) => c.connect(url)));
        // 三端一进场就挂上覆盖全程的护盾，让整场仿真**确定化**。
        // 为什么可行：出生保护只挡"被吃"不挡"吃人"——resolveEatings 只在受害者侧查
        // isProtected。所以挂着护盾的球吃不掉别人，但自己也死不了。
        // 不这么做的话：阶段 1 里满舵乱跑的球有概率被 AI 吃掉，于是要重生、
        // 重生又可能因为"死亡还没传播到服务端"被 again 的校验拒掉，摆位变 no-op，
        // 整场仿真随机失败——一条偶发失败的断言等于没有断言。
        for (const c of clients) {
            c.place({ shield: seconds + 40 });
        }
        await sleep(600); // 等一拍快照，建立样本缓冲

        // ---------- 阶段 1：预测误差 + 收敛 ----------
        hunter.input = { x: 70, y: 0 };
        prey.input = { x: -50, y: 40 };

        let errSum = 0;
        let errCount = 0;
        let errWorst = 0;
        let threshold = 0;
        const flipAtMs = seconds * 500; // 跑到一半把输入反向，制造一次"突变"
        let flipped = false;
        let convergedAt = null;
        const t0 = Date.now();

        while ((Date.now() - t0) / 1000 < seconds) {
            const elapsed = Date.now() - t0;
            if (!flipped && elapsed >= flipAtMs) {
                flipped = true;
                hunter.input = { x: -70, y: 0 }; // 反向：立刻产生一个远大于阈值的偏差
            }
            for (const c of clients) {
                c.tick(STEP);
                if (Math.random() < 0.5) {
                    c.sendInput(); // ~30Hz，和真实客户端一样
                }
            }
            if (hunter.aliveCells() > 0) {
                const cell = hunter.net.myGroup().cells[0];
                threshold = viewportWidthWorld(viewport, cell.r) * PREDICT_RATIO;
                const e = hunter.predictionError();
                if (e !== null) {
                    errSum += e;
                    errCount += 1;
                    errWorst = Math.max(errWorst, e);
                    if (flipped && e <= threshold && convergedAt === null) {
                        convergedAt = elapsed - flipAtMs; // 突变后第一次回到阈值内 = 收敛时刻
                    }
                }
            }
            await sleep(STEP * 1000);
        }
        const meanError = errCount ? errSum / errCount : NaN;

        // ---------- 阶段 2：确定性互吃 ----------
        // 三个前置条件，缺一个就会"看起来没触发"，而且都不会报错：
        //  ① 先把输入归零并等它生效——否则摆完位球还在以 ~87 单位/秒漂走，两者根本碰不上；
        //  ② 各端都得活着——阶段 1 里追着跑的球很可能把旁观者吃了，
        //     而 debug:place 对没有活细胞的组是静默 no-op；
        //  ③ 摆位与测量要分开两步并等确认，否则量到的是服务端还没生效的陈旧数字。
        for (const c of clients) {
            c.input = { x: 0, y: 0 };
            c.sendInput();
        }
        await pump(clients, 400);

        const revived = [];
        for (const c of clients) {
            if (c.aliveCells() === 0) {
                revived.push(c.label);
                await ensureAlive(c, clients);
            }
        }
        if (revived.length > 0) {
            // 进场就挂了全程护盾，正常不该走到这里。真发生了说明护盾没生效，
            // 继续跑下去拿到的数据不可信，所以直接停。
            throw new Error(`有端在全程护盾下还是死了：${revived.join('、')}——护盾或结算有问题`);
        }
        // 摆位后还要等快照传下来（最多好几秒），护盾就是这几秒的保险
        hunter.place({ x: 300, y: 300, r: 40, shield: 60 });
        observer.place({ x: 350, y: 470, r: 15, shield: 60 });
        prey.place({ x: 780, y: 300, r: 10, shield: 60 });
        // 只认"摆位之后"的事件：阶段 1 里这端可能已被 AI 吃过一次又重生，旧事件会留在
        // 数组里，find() 会取到上一次死亡（凶手是别人、质量是那次的）。
        const eventMark = prey.events.length;
        await waitFor(clients, () => cellSeenAt(hunter, 300, 300, 40), 4000, '吃球方摆位生效', hunter);
        await waitFor(clients, () => cellSeenAt(observer, 350, 470, 15), 4000, '旁观方摆位生效', observer);
        await waitFor(clients, () => cellSeenAt(prey, 780, 300, 10), 4000, '被吃方摆位生效', prey);

        const preyMassBefore = prey.ownMass();
        const hunterMassBefore = hunter.ownMass();
        // 最后一步才让它们接触：r=40 与 r=10、中心距 30 < 50（半径和），必吃。
        // 只撤被吃方的护盾——出生保护只挡"被吃"，吃球方带着护盾照样吃得掉它。
        prey.place({ x: 330, y: 300, r: 10, unshield: true });
        // 0.8s 足够（快照 50ms + 单向延迟 + 余量）。等太久吃球方会顺手吃路边的食物，
        // 那部分质量混进"吃了多少"的差值里，断言就成了在噪声上比大小。
        await pump(clients, 800);

        const eatenEvt = prey.events.slice(eventMark).find((e) => e.type === 'eaten');
        const hunterMassAfter = hunter.ownMass();
        const expectedGain = preyMassBefore * EAT.absorb;
        // 旁观端视图：被吃方要消失，吃球方质量要对得上
        const observerView = observer.net.groups.get(prey.ownerId);
        const observerPreyGone = !observerView || observerView.cells.length === 0;
        const observerHunter = observer.net.groups.get(hunter.ownerId);
        const observerHunterMass = observerHunter ? groupMass(observerHunter.cells) : 0;

        // ---------- 稳态指标：只量阶段 1~2 这段"全员在线"的时间 ----------
        // ⚠ 必须在阶段 4（断线重连）**之前**算完：阶段 4 里旁观端会断线、
        // 还会多出一个只活了 1.5s 的重连端，把它们算进平均值就是拿
        // "断线期间没收到包"去稀释快照频率——量出来 12.7Hz 然后去查一个根本没坏的问题。
        // 同理带宽：断线期间下行是 0，算进去只会让预算断言变松。
        const elapsed = (Date.now() - t0) / 1000;
        const snapHz = clients.map((c) => {
            const gaps = [];
            for (let i = 1; i < c.snapAt.length; i += 1) {
                gaps.push(c.snapAt[i] - c.snapAt[i - 1]);
            }
            gaps.sort((a, b) => a - b);
            return {
                label: c.label,
                hz: c.snapshots / elapsed,
                p95: gaps[Math.floor(gaps.length * 0.95)] || 0,
            };
        });
        const bandwidth = proxy.counters.slice(0, clients.length).map((c, i) => ({
            label: clients[i].label,
            bps: c.down / elapsed,
        }));
        const hunterKills = hunter.net.myGroup().stats.kills;

        // ---------- 阶段 4：断线重连（M4 宽限期） ----------
        // 用**旁观端**当重连主角：阶段 2 之后 prey 已经被吃光（组里没有活细胞），
        // 拿它验不了"认领回原细胞"，只能验"重连后发现被吃了"。旁观端有全程护盾，
        // 断线期间那颗球确实还活着，正好验两条路径：
        //   a) 断线 → 细胞**留在场上**（别的端仍看得见），期内带令牌重连能认领回
        //      **同一个 ownerId、同一个 cid**（cid 不变是关键：变了就是"换了个新人"，
        //      客户端 ghost 会全部重画）；
        //   b) 断了不回来 → 宽限期满被真正移除并广播 left。
        const rejoinOwner = observer.ownerId;
        const rejoinToken = observer.token;
        const rejoinCids = observer.net.myGroup().cells.map((c) => c.cid).sort((a, b) => a - b);
        observer.close();
        await pump([hunter, prey], 300);
        const hunterStillSees = (() => {
            const g = hunter.net.groups.get(rejoinOwner);
            return Boolean(g) && g.cells.length > 0;
        })();

        const rejoin = new SimClient('丙(重连)', '丙', { w: 1280, h: 720 });
        clients.push(rejoin);
        await rejoin.connect(url, { token: rejoinToken });
        const reclaimedOwner = rejoin.ownerId === rejoinOwner;
        const reclaimedCids = JSON.stringify(rejoin.net.myGroup().cells.map((c) => c.cid).sort((a, b) => a - b))
            === JSON.stringify(rejoinCids);
        const rejoinAlive = rejoin.aliveCells();

        // 这次不认领了：让宽限期走完，断言"到期移除 + 广播 left"。
        // ⚠ 等的是**视图里真的消失**，不是"left 事件到了"：服务端在同一个 tick 里
        // 先 removeGroup 再广播 left、再发下一帧快照，客户端是先收到事件、
        // 隔一帧快照（50ms + 单向延迟，150ms 档约 250ms）才把组从 NetWorld 里剔掉。
        // 事件一到就读视图，读到的必然还是旧状态——这个坑在 80ms 档不一定复现。
        const leftMark = hunter.events.length;
        rejoin.close();
        await waitFor([hunter, prey], () => !hunter.net.groups.has(rejoinOwner),
            6000, '宽限期满后从旁观端视图消失', hunter);
        const removedFromHunter = !hunter.net.groups.has(rejoinOwner);
        const leftBroadcast = hunter.events.slice(leftMark)
            .some((e) => e.type === 'left' && e.payload.id === rejoinOwner);

        return {
            delayMs,
            threshold,
            meanError,
            errWorst,
            convergedAt,
            preyMassBefore,
            hunterMassBefore,
            hunterMassAfter,
            expectedGain,
            eatenEvt: eatenEvt ? eatenEvt.payload : null,
            preyAliveAfter: prey.aliveCells(),
            observerPreyGone,
            observerHunterMass,
            snapHz,
            bandwidth,
            revived,
            hunterKills,
            hunterStillSees,
            reclaimedOwner,
            reclaimedCids,
            rejoinAlive,
            rejoinOwner,
            removedFromHunter,
            leftBroadcast,
        };
    } finally {
        for (const c of clients) {
            c.close();
        }
        await sleep(150);
        proxy.server.close();
        server.child.kill();
    }
}

// ---------- 判定 ----------
// judge 把结果**收进 verdicts**，收尾的 exit code 直接由它派生。
// 曾经收尾处另写了一份条件，于是出现过"中间打了 ✗、最后却说全部通过"——
// 判定和汇总是同一份事实，不能维护两遍。
const verdicts = [];
function judge(name, ok, detail) {
    verdicts.push({ name, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${name}：${detail}`);
    return ok;
}

const latencies = process.argv.includes('--latency') ? [flag('latency', 80)] : [80, 150];
const seconds = flag('seconds', 12);

for (const d of latencies) {
    console.log(`\n【单向 ${d}ms（RTT ${d * 2}ms）】每端 ${seconds} 秒`);
    const r = await runOne(d, seconds);
    if (r.revived.length > 0) {
        console.log(`  （阶段 2 前把死掉的端重生了：${r.revived.join('、')}）`);
    }
    judge('① 预测平均误差 < 视口宽 2%', Number.isFinite(r.meanError) && r.meanError < r.threshold,
        `${r.meanError.toFixed(1)} / ${r.threshold.toFixed(1)} 世界单位（最差 ${r.errWorst.toFixed(1)}）`);
    judge('① 输入突变后 500ms 内收敛', r.convergedAt !== null && r.convergedAt <= CONVERGE_MS,
        r.convergedAt === null ? '没测到（球中途死了？）' : `${r.convergedAt}ms`);
    judge('② 被吃方收到 eaten 事件且凶手正确', r.eatenEvt !== null && r.eatenEvt.by === '甲',
        r.eatenEvt ? `by=${r.eatenEvt.by} mass=${Math.round(r.eatenEvt.mass)}` : '没收到');
    judge('② 被吃方自己也知道死了（本地视图 0 颗活细胞）', r.preyAliveAfter === 0, `${r.preyAliveAfter} 颗`);
    judge('② eaten 事件里的死亡质量 = 吃之前的质量（两端对同一个数）',
        r.eatenEvt !== null && Math.abs(r.eatenEvt.mass - r.preyMassBefore) <= r.preyMassBefore * 0.15 + 20,
        `事件 ${Math.round(r.eatenEvt?.mass ?? NaN)} / 实测前 ${Math.round(r.preyMassBefore)}`);
    // 吃球方质量按 EAT.absorb 增长（服务端裁定生效）。
    // ⚠ 上界根本卡不了：增量会被两件事污染——① 摆完位吃球方站在原地，路过的 AI 会
    // 自己撞上来被一起吃（kills > 1）；② 它同时在吃食物，r=40 站着几秒就是 +2 半径
    // （≈ +200kg）。于是"增量必须正好等于 preyMass × absorb"在这条路径上不可测：
    // 写死上界就是在赌 AI 路过没路过、食物稠不稠（同一份代码 150ms 档 +267、80ms 档 +85）。
    // 服务端有没有真的执行 absorb 由下限保证（absorb 失效时增量≈0，跑不掉）；
    // 精确算式由 `npm test` 的「absorb：质量按 r² 累加后开方」守着；
    // "两端对同一个数"由下面那条「旁观端看到的吃球方质量与吃球方一致」守着。
    {
        const gain = r.hunterMassAfter - r.hunterMassBefore;
        judge('② 吃球方质量至少按 EAT.absorb 增长（服务端裁定生效）',
            r.hunterKills >= 1 && gain >= r.expectedGain * 0.7,
            `实际 +${Math.round(gain)} / 期望 +${Math.round(r.expectedGain)}`
            + `（吃球方 kills=${r.hunterKills}${r.hunterKills > 1 ? '，混进了路过的 AI' : ''}）`);
    }
    judge('② 旁观端视图里被吃方已消失', r.observerPreyGone, r.observerPreyGone ? '一致' : '旁观端还看得见');
    judge('② 旁观端看到的吃球方质量与吃球方一致（±15%）',
        Math.abs(r.observerHunterMass - r.hunterMassAfter) <= r.hunterMassAfter * 0.15,
        `旁观 ${Math.round(r.observerHunterMass)} / 本人 ${Math.round(r.hunterMassAfter)}`);
    for (const s of r.snapHz) {
        judge(`③ 快照频率 ≥ ${SNAPSHOT_MIN_HZ}Hz（${s.label}）`, s.hz >= SNAPSHOT_MIN_HZ,
            `${s.hz.toFixed(1)}Hz，p95 间隔 ${s.p95}ms`);
    }
    for (const b of r.bandwidth) {
        judge(`③ 每端下行 < ${BANDWIDTH_BUDGET / 1024}KB/s（${b.label}）`, b.bps < BANDWIDTH_BUDGET,
            `${(b.bps / 1024).toFixed(1)} KB/s`);
    }
    // ④ 断线重连（M4）
    judge('④ 断线后细胞留在宽限期内（别的端仍看得见那颗球）', r.hunterStillSees,
        r.hunterStillSees ? '一致' : '断线即消失 = 没进宽限期');
    judge('④ 宽限期内带令牌重连 → 认领回同一个 ownerId', r.reclaimedOwner,
        r.reclaimedOwner ? r.rejoinOwner : '换了 ownerId（= 变成了另一个人）');
    judge('④ 重连后细胞 cid 不变（ghost 不会被当成新球重画）', r.reclaimedCids,
        r.reclaimedCids ? 'cid 一致' : 'cid 变了');
    judge('④ 重连回来还能动（有活细胞）', r.rejoinAlive > 0, `${r.rejoinAlive} 颗活细胞`);
    judge('④ 宽限期满被真正移除（旁观端视图里那颗球消失）', r.removedFromHunter,
        r.removedFromHunter ? '一致' : '还在场上');
    judge('④ 移除时广播了 left（对端花名册能摘掉这个名字）', r.leftBroadcast,
        r.leftBroadcast ? '已广播' : '没收到 left');
}

const bad = verdicts.filter((v) => !v.ok);
console.log(`\n${bad.length === 0 ? '✓ 全部验收项通过' : `✗ ${bad.length} 项验收不通过：`}`);
for (const v of bad) {
    console.log(`  - ${v.name}`);
}
process.exit(bad.length === 0 ? 0 : 1);
