// superpop 联机服务器（TODO.md 第二阶段 M1：局域网扫码即玩）
//
// 架构（规划定稿见 TODO.md「第二阶段」）：服务端权威 + 客户端渲染。
// - 同进程托管静态文件（白名单沿用 dev-server，已在真机验证过）+ socket.io（同端口 ws 升级）
// - 60Hz 固定步长跑 core/world.js——与单机 Game 完全同一份无头世界（M0 抽取的红利）
// - 20Hz 给每个客户端广播 AOI 快照：视口±边距内的球 + 食物增量（量化坐标）
//
// 事件协议（唯一权威定义，改动需两端同步并更新 AGENTS.md）：
//   C→S  join{name,viewport{w,h},token?} / input{x,y} / split / again{name} / viewport{w,h}
//        （全部按 socket 令牌桶限频：input 60/s，其余 10/s，超限静默丢包）
//   S→C  welcome{selfId,time,configHash,world,food,roster,board,roundRemaining,
//                resumeToken,resumed,death{mass,rank}|null}
//        snapshot{t,cells[],ai[],food{a[],e[]},board?,my{stats,lastSplitAt}}
//        roster{entries} / eaten{mass,rank,by,stats} / crowned{ownerId,name,mass,countdown} /
//        newRound{time} / left{id} / rejected{reason}
//   结算期（ending）世界冻结但快照照常按门控发射——中途加入者靠首帧快照进结算界面。
// 断线重连（M4，v3）：断线后细胞留在场上、输入清零，NET.graceSeconds 内带
//   join.token=上次的 welcome.resumeToken 重连即可认领**原来的细胞**（ownerId 与 cid 不变，
//   客户端 ghost 不会瞬移）；超期才 removeGroup + 广播 left。宽限期内被 AI 吃光的话，
//   welcome.death 带上死亡瞬间的质量与名次，客户端据此直接进结算界面。
//   认领的判断在「房间已满」之前——宽限期内的组本来就占着名额，
//   反过来判会把自家重连挡在门外。
// 旧 server 的 registe/create/enter/update（含拼写错误）一并废弃。
//
// cells[] / ai[] 的元组形状（v2）：[ownerId, cid, x, y, r, shielded, colorIdx]，坐标 ×2。
//   cid = 细胞的稳定身份，构造时分配、永不改变。客户端用它当 ghost 的 key，
//   **不要再退回 `ownerId#index`**：index 是组内数组位置，被吃一颗中间分身或两个分身
//   合并就会重排，对端会看到 ghost 瞬移一帧。编码/解码与 PROTOCOL_VERSION 在
//   src/core/protocol.js（两端共用同一份）——形状一改就 +1，否则浏览器里的旧客户端
//   会静默解出错位的值，而 configHash 覆盖不到协议形状。

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

import { prepareQr } from './qr-startup.js';

import { AI, FOOD, JOYSTICK, KING, NET, PLAYER, VIEW, WORLD } from '../src/config.js';
import { groupMass } from '../src/core/rules.js';
import { configHash } from '../src/core/config-hash.js';
import { colorIndex, encodeBall, quantize } from '../src/core/protocol.js';
import { World } from '../src/core/world.js';

const TICK_MS = 1000 / 60;
const SNAPSHOT_MS = 50; // 20Hz，按真实时间门控（见下方 lastSnapshotAt）
const ROUND_RESTART_SECONDS = 8; // 称王即终局：全场结算后倒计时多久开新局
const AOI_MARGIN_RATIO = 0.6; // AOI 边距：视口尺寸的 60%，盖住相机死区(35%)与插值余量
const MAX_PLAYERS = 8; // 人数上限（2026-10-11 产品决策，见 TODO.md M4）
const NICKNAME_MAX = 12;
// 断线宽限期：断线后细胞留在场上（不再被操控），期内带 resumeToken 重连可认领原细胞。
// env 覆盖只给仿真用——net-sim 要跑「宽限期内认领」和「宽限期满被移除」两条断言，
// 等不起真实的 10s。真机跑的是 NET.graceSeconds。
const GRACE_MS = Math.max(200, Number(process.env.SUPERPOP_GRACE_MS) || NET.graceSeconds * 1000);

// ---------- 静态文件（沿用 dev-server 的白名单方案） ----------

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = process.env.PORT || 3000;
const qrPath = join(root, 'qr.png');
const lastUrlPath = join(root, '.qr-last-url');

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
        // 百分号编码的路径穿越（/src/%2f..%2fpackage.json、%2e%2e%5c 变体）：
        // 白名单在解码后、resolve 前做，挡不住编码，解码后含 .. 或 \ 的一律 403
        if (pathname.includes('..') || pathname.includes('\\')) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
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

// 量化与细胞编码统一在 core/protocol.js（服务端、客户端、单测共用同一份定义），
// 协议形状要改时只改那一个文件，见那里的 PROTOCOL_VERSION 三步走。
const encodeFood = (food) => [food.id, quantize(food.x), quantize(food.y), colorIndex(food.color)];

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

const sessions = new Map(); // socket.id -> { ownerId, viewport, token }
let nextOwnerId = 1;
let nextToken = 1;

// 断线宽限登记表：resumeToken -> { ownerId, expiresAt, timer }
// 断线时细胞**留在场上**（输入清零、站着不动，可能被 AI 吃掉），
// 期内用同一个 token 重连就认领回来：ownerId 与 cid 都不变，
// 所以客户端的 ghost 不会被当成"新球"、也不会瞬移。
// 宽限期满（或被认领）才真正 removeGroup + 广播 left。
const graceList = new Map();

function newToken() {
    const token = `t${nextToken}`;
    nextToken += 1;
    return token;
}

// 场上人类数：**数 world.groups 里的 p 组，不是 sessions.size**。
// 断线宽限期内的玩家已经不在 sessions 里了（socket 没了），但他的组还在场上、
// 仍然占名额——用 sessions.size 会少算，日志就会显示"1/8"而实际已经 3 人。
// join 的满员判断也用同一个口径。
function humansOnField() {
    let count = 0;
    for (const ownerId of world.groups.keys()) {
        if (String(ownerId).startsWith('p')) {
            count += 1;
        }
    }
    return count;
}

function sendWelcome(socket, session, { resumed = false } = {}) {
    const group = world.groups.get(session.ownerId);
    socket.emit('welcome', {
        selfId: session.ownerId,
        time: world.time,
        configHash: configHash(), // 注意要调用：简写会把函数本身发出去（序列化成 undefined）
        world: { width: WORLD.width, height: WORLD.height },
        food: world.foodList.map(encodeFood),
        roster: buildRoster(),
        board: world.leaderboard(session.ownerId),
        roundRemaining: roundRemainingSeconds(), // 中途加入碰上结算期：客户端直接进倒计时
        // 断线重连（M4）：令牌由服务端签发，重连时带回即可认领原细胞。
        // death 非 null = 宽限期内这组被吃光了（mass/rank 取死亡瞬间的值，
        // 因为此刻 cells 全是 alive=false，客户端自己算出来只会是 0kg），
        // 客户端据此直接进结算界面，而不是"回来了能动却看不到球"。
        resumeToken: session.token,
        resumed,
        death: resumed && session.death ? session.death : null,
    });
}

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

// ---------- C→S 限频：每 socket 令牌桶，超限静默丢包（不踢人、不报错） ----------
// input 60/s（正常客户端按游戏帧节流 ≤30Hz，留一倍余量）；split/again/viewport 各 10/s
function makeBucket(ratePerSec) {
    return { rate: ratePerSec, tokens: ratePerSec, lastAt: Date.now() };
}

function takeToken(bucket) {
    const now = Date.now();
    bucket.tokens = Math.min(bucket.rate, bucket.tokens + ((now - bucket.lastAt) / 1000) * bucket.rate);
    bucket.lastAt = now;
    if (bucket.tokens < 1) {
        return false;
    }
    bucket.tokens -= 1;
    return true;
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
    log(`新的一局开始（场上人类 ${humansOnField()}/${MAX_PLAYERS}）`);
}

io.on('connection', (socket) => {
    let session = null;
    const buckets = {
        input: makeBucket(60),
        split: makeBucket(10),
        again: makeBucket(10),
        viewport: makeBucket(10),
    };

    socket.on('join', (payload = {}) => {
        if (session) {
            return; // 重复 join 忽略
        }
        // ---- 断线重连：先看能不能用令牌认领回原来那组细胞 ----
        // 顺序很重要：认领要在「人数已满」的判断**之前**。宽限期内的组本来就占着
        // MAX_PLAYERS 的名额（它还在场上），反过来判会把自家重连挡在门外。
        const token = typeof payload.token === 'string' ? payload.token.slice(0, 32) : '';
        const held = token ? graceList.get(token) : null;
        if (held) {
            const group = world.groups.get(held.ownerId);
            if (!group) {
                // 组已经没了（不该发生：移除时会同步清登记表）。清掉走新建流程，
                // 而不是把玩家挂死在一个永远认领不回来的令牌上。
                graceList.delete(token);
            } else {
                clearTimeout(held.timer);
                graceList.delete(token);
                // 组在宽限期内被吃光的话，把死亡瞬间的数据留给客户端弹结算
                const dead = !group.cells.some((cell) => cell.alive);
                session = {
                    ownerId: held.ownerId,
                    viewport: payload.viewport || null,
                    token,
                    death: dead ? { mass: held.deathMass || 0, rank: held.deathRank ?? null } : null,
                };
                sessions.set(socket.id, session);
                sendWelcome(socket, session, { resumed: true });
                socket.broadcast.emit('roster', { entries: buildRoster() });
                log(`玩家重连认领 ${group.name}（${held.ownerId}），剩余宽限 ${Math.max(0, Math.round((held.expiresAt - Date.now()) / 1000))}s`
                    + (dead ? '（宽限期内已被吃光，客户端直接进结算）' : ''));
                return;
            }
        }
        const humans = humansOnField();
        if (humans >= MAX_PLAYERS) {
            socket.emit('rejected', { reason: `房间已满（上限 ${MAX_PLAYERS} 人）` });
            return;
        }
        const ownerId = `p${nextOwnerId}`;
        nextOwnerId += 1;
        const group = world.addGroup(ownerId, sanitizeName(payload.name));
        // 保护从真正进场算起（与单机 begin() 同一规则：World 不发保护，调用方发）
        group.cells[0].grantShield(PLAYER.spawnShield, world.time);
        session = { ownerId, viewport: payload.viewport || null, token: newToken() };
        sessions.set(socket.id, session);

        sendWelcome(socket, session);
        socket.broadcast.emit('roster', { entries: buildRoster() });
        log(`玩家加入 ${group.name}（${ownerId}），场上人类 ${humans + 1}/${MAX_PLAYERS}`);
    });

    socket.on('input', (payload = {}) => {
        if (!session || !takeToken(buckets.input)) {
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
        if (!session || !takeToken(buckets.split)) {
            return;
        }
        // 门槛/冷却/上限都在 World.requestSplit 把关（服务端权威，天然防连点）
        world.requestSplit(session.ownerId);
    });

    socket.on('again', (payload = {}) => {
        if (!session || !takeToken(buckets.again)) {
            return;
        }
        // 状态校验：还有存活细胞时不许重生——否则存活玩家能用 again 刷满血+出生保护
        const existing = world.groups.get(session.ownerId);
        if (existing && existing.cells.some((cell) => cell.alive)) {
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
        if (!session || !takeToken(buckets.viewport)
            || !Number.isFinite(payload.w) || !Number.isFinite(payload.h)) {
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
        const token = session.token;
        sessions.delete(socket.id);
        const group = world.groups.get(session.ownerId);
        if (!group) {
            return;
        }
        // 断线不立刻移除：细胞留在场上，只是没人操控了（M4 断线重连）。
        // 输入必须清零——否则它会带着最后一帧的方向一直漂，看起来像"还活着"。
        group.input.speedX = 0;
        group.input.speedY = 0;
        const entry = {
            ownerId: session.ownerId,
            expiresAt: Date.now() + GRACE_MS,
            timer: null,
        };
        entry.timer = setTimeout(() => {
            // 被认领过的话登记表里已经没有这一条；这里再确认一次是为了
            // "认领与超时同时发生"时不误删别人的组
            if (graceList.get(token) !== entry) {
                return;
            }
            graceList.delete(token);
            const victim = world.groups.get(entry.ownerId);
            world.removeGroup(entry.ownerId);
            io.emit('left', { id: entry.ownerId });
            io.emit('roster', { entries: buildRoster() });
            log(`宽限期结束，移除 ${victim ? victim.name : entry.ownerId}（${humansOnField()}/${MAX_PLAYERS}）`);
        }, GRACE_MS + 50);
        // 定时器不许吊住进程：仿真/测试会提前结束进程
        if (typeof entry.timer.unref === 'function') {
            entry.timer.unref();
        }
        graceList.set(token, entry);
        // 不发 left：人还在场上，名字也还在花名册里（只是操控权没了）。
        // 花名册要重发是因为 AI 超编移除等变化顺带进来，兼带让对端刷新一次。
        io.emit('roster', { entries: buildRoster() });
        log(`玩家断线 ${group.name}（${session.ownerId}），宽限 ${GRACE_MS / 1000}s 内可重连认领（场上人类 ${humansOnField()}/${MAX_PLAYERS}）`);
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

        // 测试钩子：把自己摆到指定位置/体型（可选去掉出生保护）。
        // net-sim 需要**确定性**地造一次互吃：靠 AI 漫游撞出一次互吃是概率事件，
        // 跑十次不一定碰上一次，那样的断言等于没有断言。摆位比"等"可靠得多。
        socket.on('debug:place', (payload = {}) => {
            if (!session) {
                return;
            }
            const group = world.groups.get(session.ownerId);
            const cell = group && group.cells.find((c) => c.alive);
            if (!cell) {
                return;
            }
            if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
                const r = Number.isFinite(payload.r) ? payload.r : cell.r;
                // 钳在世界内：摆到界外会被 Ball.update 的边界钳制拉回来，钩子就白设了
                cell.x = Math.min(WORLD.width - r, Math.max(r, payload.x));
                cell.y = Math.min(WORLD.height - r, Math.max(r, payload.y));
            }
            if (Number.isFinite(payload.r)) {
                cell.r = Math.min(WORLD.maxBallRadius, Math.max(PLAYER.radius, payload.r));
            }
            // shield：给一段出生保护，用来把"摆位等待快照传下来"这几秒里挡住 AI；
            // unshield 则立刻去掉。没有它，被吃方可能在摆位窗口就被 AI 顺手吃掉，
            // 断言的凶手就不是预期里那个"两头接触"的结果了。
            if (Number.isFinite(payload.shield) && payload.shield > 0) {
                cell.grantShield(payload.shield, world.time);
            }
            if (payload.unshield === true) {
                cell.shieldUntil = 0; // 出生保护会挡住互吃，摆位做互吃实验时要去掉
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
        } else {
            // 人在宽限期内（断线中）：事件没 socket 可发，但死亡瞬间的数据要留着，
            // 否则他重连回来只会看到"没有球"和一个算不出名次的 0kg 结算。
            for (const entry of graceList.values()) {
                if (entry.ownerId === event.ownerId) {
                    entry.deathMass = event.mass;
                    entry.deathRank = event.rank;
                }
            }
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

let lastTickAt = Date.now();
let accumulator = 0;
let lastSnapshotAt = 0;
let lastBoardAt = 0;

setInterval(() => {
    const now = Date.now();
    // 结算倒计时到点：重开全新一局。结算期世界冻结，lastTickAt 照常刷新，
    // 重开后累加器不会一次补上一大截
    if (roundState === 'ending') {
        lastTickAt = now;
        if (now >= roundRestartAt) {
            startNewRound();
        }
        // 不 return：结算期照常按真实时间门控发快照（世界冻结、内容不变，开销极小）。
        // 中途加入者 join 后要等第一帧快照才进结算界面——ending 期间一帧都不发的话，
        // 他会干等最长 8 秒，welcome.roundRemaining 也等过期了
    } else {
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
            steps += 1;
        }
    }
    // 快照按真实时间门控（20Hz）：Windows 上 setInterval 实测 ~29ms 才触发一次，
    // 绑"每 3 次触发发一帧"实际只有 ~12 帧/秒、p95 间隔 244ms，插值缓冲直接被打穿
    //（客户端看到的就是卡顿+跳帧）。世界步进靠累加器补齐是准的，发射节奏必须另算。
    if (now - lastSnapshotAt < SNAPSHOT_MS) {
        return;
    }
    lastSnapshotAt = now;

    // AI 出生/重生/超编移除会改 roster：dirty 时随本快照周期广播一次
    if (world.rosterDirty) {
        world.rosterDirty = false;
        io.emit('roster', { entries: buildRoster() });
    }

    const { map: currentFood, added } = assignFoodIds();
    const eatenIds = [];
    for (const id of lastFoodMap.keys()) {
        if (!currentFood.has(id)) {
            eatenIds.push(id);
        }
    }
    lastFoodMap = currentFood;
    const foodDelta = { a: added.map(encodeFood), e: eatenIds };
    // 排行榜 1Hz：真实时间门控。tickCount % 60 的写法在累加器补步时会整秒跳过
    const sendBoard = now - lastBoardAt >= 1000;
    if (sendBoard) {
        lastBoardAt = now;
    }

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
    await prepareQr(url, qrPath, lastUrlPath);
}

server.listen(port, printStartupInfo);
