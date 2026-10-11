// superpop 联机服务器（TODO.md 第二阶段 M1：局域网扫码即玩）
//
// 架构（规划定稿见 TODO.md「第二阶段」）：服务端权威 + 客户端渲染。
// - 同进程托管静态文件（白名单沿用 dev-server，已在真机验证过）+ socket.io（同端口 ws 升级）
// - 60Hz 固定步长跑 core/world.js——与单机 Game 完全同一份无头世界（M0 抽取的红利）
// - 20Hz 给每个客户端广播 AOI 快照：视口±边距内的球 + 食物增量（量化坐标）
//
// 事件协议（唯一权威定义，改动需两端同步并更新 AGENTS.md）：
//   C→S  join{name,viewport{w,h}} / input{x,y} / split / again{name} / viewport{w,h}
//   S→C  welcome{selfId,time,configHash,world,food,roster,board}
//        snapshot{t,cells[],ai[],food{a[],e[]},board?,my{stats,lastSplitAt}}
//        roster{entries} / eaten{mass,rank,by,stats} / crowned{ownerId,name} / left{id}
//        rejected{reason}
// 旧 server 的 registe/create/enter/update（含拼写错误）一并废弃。

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

import { AI, COLORS, FOOD, JOYSTICK, KING, PLAYER, VIEW, WORLD } from '../src/config.js';
import { groupMass } from '../src/core/rules.js';
import { configHash } from '../src/core/config-hash.js';
import { World } from '../src/core/world.js';

const TICK_MS = 1000 / 60;
const SNAPSHOT_MS = 50; // 20Hz，按真实时间门控（见下方 lastSnapshotAt）
const ROUND_RESTART_SECONDS = 8; // 称王即终局：全场结算后倒计时多久开新局
const AOI_MARGIN_RATIO = 0.6; // AOI 边距：视口尺寸的 60%，盖住相机死区(35%)与插值余量
const MAX_PLAYERS = 8; // 人数上限（2026-10-11 产品决策，见 TODO.md M4）
const NICKNAME_MAX = 12;

// ---------- 静态文件（沿用 dev-server 的白名单方案） ----------

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = process.env.PORT || 3000;
const qrPath = join(root, 'qr.png');
const qrUrlCachePath = join(root, '.qr-last-url');

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

const allowedPrefixes = ['/src/', '/index.html', '/qr.png', '/favicon.ico', '/socket.io/'];

function isAllowed(pathname) {
    return allowedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

const server = http.createServer(async (req, res) => {
    try {
        let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname === '/') {
            pathname = '/index.html';
        }
        if (!isAllowed(pathname)) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        // socket.io 的客户端脚本由 socket.io 自己挂 /socket.io/ 前缀，这里只放行本地文件
        const filePath = resolve(root, '.' + pathname);
        if (filePath !== root && !filePath.startsWith(root + sep)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        const data = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream' });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const io = new Server(server); // 与静态文件同端口，ws 升级不受白名单影响

// ---------- configHash：两端配置一致性校验（算法与清单在 core/config-hash.js，两端共用） ----------

// ---------- 世界 ----------

const world = new World();

// 食物增量：给每颗食物一个稳定 id（吃掉 = id 消失，补种 = 新对象拿新 id）。
// World 每帧会替换被吃的食物对象，core 不用为此改形状——在服务端 diff 就行。
let nextFoodId = 1;
function assignFoodIds() {
    const map = new Map(); // id -> food
    const added = [];
    for (const food of world.foodList) {
        if (food.id === undefined) {
            food.id = nextFoodId;
            nextFoodId += 1;
            added.push(food);
        }
        map.set(food.id, food);
    }
    return { map, added };
}
let lastFoodMap = assignFoodIds().map;

// 量化：世界 1280 → ×2 后仍在 uint16 范围，精度 0.5 世界单位（球半径 ≥12，够用）
const q = (v) => Math.round(v * 2);
const colorIndex = (hex) => Math.max(0, COLORS.indexOf(hex));

const encodeFood = (food) => [food.id, q(food.x), q(food.y), colorIndex(food.color)];
// 细胞/球编码：[ownerId, x, y, r, shielded, colorIdx]。
// 颜色跟着球走（AI 重生、玩家重生都会换色），名字才走 roster。
const encodeBall = (ball) => [
    ball.ownerId,
    q(ball.x),
    q(ball.y),
    q(ball.r),
    ball.shielded ? 1 : 0,
    colorIndex(ball.bColor),
];

function largestCellOf(ownerId) {
    const group = world.groups.get(ownerId);
    let best = null;
    if (group) {
        for (const cell of group.cells) {
            if (cell.alive && (best === null || cell.r > best.r)) {
                best = cell;
            }
        }
        if (best) {
            return best;
        }
        if (group.cells.length > 0) {
            return group.cells[0]; // 全灭：AOI 以死细胞（镜头定格处）为中心
        }
    }
    return { x: WORLD.width / 2, y: WORLD.height / 2, r: PLAYER.radius };
}

// AOI 视口：按与客户端同一套 VIEW 公式算「自动缩放」下的视口。不乘 userZoom——
// 那是玩家的缩放偏好，只会让实际视口更小或钳在 fitScale，60% 边距兜得住；
// 相机死区偏移无法在服务端精确复算，也一并由边距盖住。
function aoiRect(session) {
    const cell = largestCellOf(session.ownerId);
    const cssW = session.viewport ? session.viewport.w : 1280;
    const cssH = session.viewport ? session.viewport.h : 720;
    const fitScale = Math.max(cssW / WORLD.width, cssH / WORLD.height) / VIEW.maxZoomOut;
    const sizeZoom = Math.pow(cell.r / PLAYER.radius, VIEW.zoomExponent);
    const scale = Math.max(fitScale, Math.max(cssW, cssH) / (VIEW.longEdgeWorld * sizeZoom));
    const w = (cssW / scale) * (1 + AOI_MARGIN_RATIO);
    const h = (cssH / scale) * (1 + AOI_MARGIN_RATIO);
    return { x: cell.x - w / 2, y: cell.y - h / 2, w, h };
}

function inRect(x, y, rect) {
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function buildRoster() {
    const entries = [];
    for (const group of world.groups.values()) {
        entries.push([group.ownerId, group.name]);
    }
    for (const ai of world.ai) {
        if (ai.alive) {
            entries.push([ai.ownerId, ai.name]);
        }
    }
    return entries;
}

function myPayload(ownerId) {
    const group = world.groups.get(ownerId);
    if (!group) {
        return { stats: { playTime: 0, foodEaten: 0, kills: 0 }, lastSplitAt: -Infinity };
    }
    return { stats: { ...group.stats }, lastSplitAt: group.lastSplitAt };
}

// ---------- 会话与消息 ----------

const sessions = new Map(); // socket.id -> { ownerId, viewport }
let nextOwnerId = 1;

function log(text) {
    console.log(`[${new Date().toLocaleTimeString()}] ${text}`);
}

function sanitizeName(name) {
    const text = String(name || '').trim().slice(0, NICKNAME_MAX);
    return text || `球球${nextOwnerId}`;
}

function findSocketIdByOwner(ownerId) {
    for (const [socketId, session] of sessions) {
        if (session.ownerId === ownerId) {
            return socketId;
        }
    }
    return null;
}

// ---------- 回合生命周期：称王即终局（2026-10-11 产品决策，见 TODO.md M2） ----------
// 有人称王 → 全场结算 + 倒计时 → 世界与所有玩家重开全新一局。
// 没有这套流程的话世界无限累积，后来者"一进去就发现别人已经称王"（真机反馈）。
let roundState = 'playing'; // 'playing' | 'ending'
let roundRestartAt = 0;

function roundRemainingSeconds() {
    return roundState === 'ending'
        ? Math.max(1, Math.ceil((roundRestartAt - Date.now()) / 1000))
        : 0;
}

function startNewRound() {
    roundState = 'playing';
    // 所有人先回出生体重、落在稀疏位置（此时大 AI 还在，safeSpawn 会避开它们），
    // 再重置世界——AI 按重置后的体型（最小档）重新铺场、食物重铺
    for (const ownerId of [...world.groups.keys()]) {
        const group = world.groups.get(ownerId);
        world.respawnGroup(ownerId);
        group.cells[0].grantShield(PLAYER.spawnShield, world.time);
    }
    world.reset();
    io.emit('newRound', { time: world.time });
    log(`新的一局开始（场上人类 ${sessions.size}/${MAX_PLAYERS}）`);
}

io.on('connection', (socket) => {
    let session = null;

    socket.on('join', (payload = {}) => {
        if (session) {
            return; // 重复 join 忽略
        }
        const humans = [...world.groups.keys()].filter((id) => String(id).startsWith('p')).length;
        if (humans >= MAX_PLAYERS) {
            socket.emit('rejected', { reason: `房间已满（上限 ${MAX_PLAYERS} 人）` });
            return;
        }
        const ownerId = `p${nextOwnerId}`;
        nextOwnerId += 1;
        const group = world.addGroup(ownerId, sanitizeName(payload.name));
        // 保护从真正进场算起（与单机 begin() 同一规则：World 不发保护，调用方发）
        group.cells[0].grantShield(PLAYER.spawnShield, world.time);
        session = { ownerId, viewport: payload.viewport || null };
        sessions.set(socket.id, session);

        socket.emit('welcome', {
            selfId: ownerId,
            time: world.time,
            configHash: configHash(), // 注意要调用：简写会把函数本身发出去（序列化成 undefined）
            world: { width: WORLD.width, height: WORLD.height },
            food: world.foodList.map(encodeFood),
            roster: buildRoster(),
            board: world.leaderboard(ownerId),
            roundRemaining: roundRemainingSeconds(), // 中途加入碰上结算期：客户端直接进倒计时
        });
        socket.broadcast.emit('roster', { entries: buildRoster() });
        log(`玩家加入 ${group.name}（${ownerId}），场上人类 ${humans + 1}/${MAX_PLAYERS}`);
    });

    socket.on('input', (payload = {}) => {
        if (!session) {
            return;
        }
        const group = world.groups.get(session.ownerId);
        if (!group) {
            return;
        }
        // 输入护栏：拒收非数值、钳到满舵+ε（防伪造输入瞬移）
        let { x, y } = payload;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        const cap = JOYSTICK.radius * 1.05;
        const len = Math.hypot(x, y);
        if (len > cap) {
            x = (x / len) * cap;
            y = (y / len) * cap;
        }
        group.input.speedX = x;
        group.input.speedY = y;
    });

    socket.on('split', () => {
        if (!session) {
            return;
        }
        // 门槛/冷却/上限都在 World.requestSplit 把关（服务端权威，天然防连点）
        world.requestSplit(session.ownerId);
    });

    socket.on('again', (payload = {}) => {
        if (!session) {
            return;
        }
        const group = world.respawnGroup(session.ownerId, sanitizeName(payload.name));
        if (group) {
            group.cells[0].grantShield(PLAYER.spawnShield, world.time);
            // 不 reset 世界：多人局里别人还在玩，重生进的是正在进行的对局。
            // 单机「再来一局 = 新的一局」的语义由客户端单机路径负责。
            log(`玩家重生 ${group.name}（${session.ownerId}）`);
        }
    });

    socket.on('viewport', (payload = {}) => {
        if (!session || !Number.isFinite(payload.w) || !Number.isFinite(payload.h)) {
            return;
        }
        // 下限 300：布局没就绪时客户端可能量到 0，AOI 太小玩家会"看不见被谁吃"
        session.viewport = {
            w: Math.min(4096, Math.max(300, payload.w)),
            h: Math.min(4096, Math.max(300, payload.h)),
        };
    });

    socket.on('disconnect', () => {
        if (!session) {
            return;
        }
        const group = world.groups.get(session.ownerId);
        world.removeGroup(session.ownerId);
        sessions.delete(socket.id);
        io.emit('left', { id: session.ownerId });
        io.emit('roster', { entries: buildRoster() });
        log(`玩家离开 ${group ? group.name : session.ownerId}，场上人类 ${sessions.size}/${MAX_PLAYERS}`);
    });

    // 测试钩子：把自己顶到称王线上，验证"称王即终局"全流程不用真打几分钟。
    // 仅 SUPERPOP_DEBUG=1 时注册，正常开服没有这条消息面。
    if (process.env.SUPERPOP_DEBUG === '1') {
        socket.on('debug:forceCrown', () => {
            if (!session) {
                return;
            }
            const group = world.groups.get(session.ownerId);
            if (group && group.cells[0].alive) {
                group.cells[0].r = Math.sqrt(KING.mass) + 1;
                log(`[debug] ${group.name} 触发称王判定`);
            }
        });
    }
});

// ---------- 世界事件 → 客户端 ----------

world.onEvent = (event) => {
    if (event.type === 'eaten') {
        const socketId = findSocketIdByOwner(event.ownerId);
        if (socketId) {
            io.to(socketId).emit('eaten', {
                mass: event.mass,
                rank: event.rank,
                by: event.by ? event.by.name : null,
                stats: myPayload(event.ownerId).stats,
            });
        }
    } else if (event.type === 'crowned' && roundState === 'playing') {
        // 称王即终局：全场结算 + 倒计时，倒计时到点由主循环 startNewRound
        roundState = 'ending';
        roundRestartAt = Date.now() + ROUND_RESTART_SECONDS * 1000;
        const group = world.groups.get(event.ownerId);
        io.emit('crowned', {
            ownerId: event.ownerId,
            name: group ? group.name : '?',
            mass: Math.round(group ? groupMass(group.cells) : 0),
            countdown: ROUND_RESTART_SECONDS,
        });
        log(`称王即终局：${group ? group.name : event.ownerId} 称王，${ROUND_RESTART_SECONDS}s 后开新局`);
    }
};

// ---------- 主循环：60Hz 固定步长 + 20Hz 快照 ----------

let tickCount = 0;
let lastTickAt = Date.now();
let accumulator = 0;
let lastSnapshotAt = 0;

setInterval(() => {
    const now = Date.now();
    // 结算倒计时到点：重开全新一局。结算期世界冻结，lastTickAt 照常刷新，
    // 重开后累加器不会一次补上一大截
    if (roundState === 'ending') {
        lastTickAt = now;
        if (now >= roundRestartAt) {
            startNewRound();
        }
        return;
    }
    accumulator += Math.min(now - lastTickAt, 250); // 挂起恢复：同 Game.loop，不补几百步
    lastTickAt = now;
    let steps = 0;
    while (accumulator >= TICK_MS && steps < 5) {
        world.update(TICK_MS / 1000);
        // 出生保护标记：快照的 sh 位从这里来（客户端不再自己算）
        for (const ball of world.balls) {
            ball.shielded = ball.alive && ball.isProtected(world.time);
        }
        accumulator -= TICK_MS;
        tickCount += 1;
        steps += 1;
    }
    // 快照按真实时间门控（20Hz）：Windows 上 setInterval 实测 ~29ms 才触发一次，
    // 绑"每 3 次触发发一帧"实际只有 ~12 帧/秒、p95 间隔 244ms，插值缓冲直接被打穿
    //（客户端看到的就是卡顿+跳帧）。世界步进靠累加器补齐是准的，发射节奏必须另算。
    if (now - lastSnapshotAt < SNAPSHOT_MS) {
        return;
    }
    lastSnapshotAt = now;

    const { map: currentFood, added } = assignFoodIds();
    const eatenIds = [];
    for (const id of lastFoodMap.keys()) {
        if (!currentFood.has(id)) {
            eatenIds.push(id);
        }
    }
    lastFoodMap = currentFood;
    const foodDelta = { a: added.map(encodeFood), e: eatenIds };
    const sendBoard = tickCount % 60 === 0; // 1Hz 排行榜（tickCount = 世界步数，恒 60/s）

    for (const [socketId, session] of sessions) {
        const rect = aoiRect(session);
        const cells = [];
        const ai = [];
        for (const ball of world.balls) {
            if (!ball.alive || !inRect(ball.x, ball.y, rect)) {
                continue;
            }
            const target = world.groups.has(ball.ownerId) ? cells : ai;
            target.push(encodeBall(ball));
        }
        const payload = {
            t: Math.round(world.time * 1000),
            cells,
            ai,
            food: foodDelta,
            my: myPayload(session.ownerId),
        };
        if (sendBoard) {
            payload.board = world.leaderboard(session.ownerId);
        }
        io.to(socketId).emit('snapshot', payload);
    }
}, TICK_MS);

// ---------- 启动信息（局域网 URL + 二维码，沿用 dev-server） ----------

function lanAddresses() {
    const list = [];
    for (const infos of Object.values(os.networkInterfaces())) {
        for (const info of infos || []) {
            if (info.family === 'IPv4' && !info.internal) {
                list.push(info.address);
            }
        }
    }
    return list;
}

function openFile(path) {
    const commands = {
        win32: ['cmd', ['/c', 'start', '""', path]],
        darwin: ['open', [path]],
        linux: ['xdg-open', [path]],
    };
    const command = commands[process.platform];
    if (!command) {
        return;
    }
    try {
        spawn(command[0], command[1], { detached: true, stdio: 'ignore' }).unref();
    } catch {
        // 打开失败不影响服务器
    }
}

async function printStartupInfo() {
    console.log(`superpop 联机服务器: http://localhost:${port}`);
    console.log('注意：与 npm run dev 同抢 3000 端口，二选一跑；新机器首次开服需在 Windows 防火墙放行 node。');
    console.log(`场上 AI 数量目标 ${AI.minCount}~${AI.count}（随场上最大体型增长）· 食物 ${FOOD.count} 颗`);
    const ips = lanAddresses();
    if (ips.length === 0) {
        return;
    }
    const url = `http://${ips[0]}:${port}`;
    console.log(`手机（同一 Wi-Fi）请访问：${url}`);
    try {
        const { default: QRCode } = await import('qrcode');
        await QRCode.toFile(qrPath, url);
        console.log(`二维码图片已生成：${qrPath}`);
        const previous = await readFile(qrUrlCachePath, 'utf8').catch(() => null);
        if (previous !== url) {
            await writeFile(qrUrlCachePath, url, 'utf8');
            openFile(qrPath);
        }
        console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    } catch (err) {
        console.log(`（二维码生成失败：${err && err.message}；URL 不受影响）`);
    }
}

server.listen(port, printStartupInfo);
