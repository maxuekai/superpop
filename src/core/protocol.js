// 联机协议里**与数值编码有关**的那一半：版本号 + 量化 + 球的编码/解码。
//
// 为什么要单独一个文件：快照的元组形状是服务端与客户端之间最容易被悄悄改歪的东西——
// 字段加一个、客户端照样能跑（只是读到 undefined 或错位），没有任何报错。
// 曾经客户端用 `ownerId#index` 当 ghost 的 key，index 是组内数组位置，被吃一颗中间分身
// 或两个分身合并就会重排 → 对端 ghost 瞬移一帧。现在改用细胞的稳定 cid。
//
// **协议形状有任何改动，必须同时做三件事**：
//   1. 改这里的 encodeBall / decodeBall；
//   2. 把 PROTOCOL_VERSION +1（否则浏览器里的旧客户端会连上新宿主并解出乱码——
//      configHash 只覆盖 config 数值块，覆盖不到协议形状）；
//   3. 更新 server/index.js 头注释与 AGENTS.md 的协议清单。
import { COLORS } from '../config.js';

// 与快照形状绑定的版本号。configHash 把 PROTOCOL_VERSION 也算进去：
// join 时两端不一致就当场 rejected，而不是进游戏后看到一堆错位的球。
export const PROTOCOL_VERSION = 2;

// 坐标/半径 ×2 量化：世界 1280 → ×2 后仍在 uint16 范围，精度 0.5 世界单位（球半径 ≥12，够用）
export const quantize = (v) => Math.round(v * 2);
export const colorIndex = (hex) => Math.max(0, COLORS.indexOf(hex));

// 细胞/球编码：[ownerId, cid, x, y, r, shielded, colorIdx]
//   cid：细胞稳定身份（构造时分配、永不改变）—— 客户端靠它认出「同一个分身」，
//        分裂后原球保留 cid、新半球拿新 cid，合并时被并掉的消失。
//        ⚠ 别再退回 index：组内位置一变（被吃/合并）ghost 就会瞬移。
//   颜色跟着球走（AI 重生、玩家重生都会换色），名字走 roster。
export const encodeBall = (ball) => [
    ball.ownerId,
    ball.cid,
    quantize(ball.x),
    quantize(ball.y),
    quantize(ball.r),
    ball.shielded ? 1 : 0,
    colorIndex(ball.bColor),
];

// 解码成纯数据（坐标/半径除回 2）。客户端用它在 applySnapshot 里逐行还原，
// 单测也用同一份来断言"编码→解码"是对合的。
export const decodeBall = (row) => ({
    ownerId: row[0],
    cid: row[1],
    x: row[2] / 2,
    y: row[3] / 2,
    r: row[4] / 2,
    shielded: row[5] === 1,
    colorIndex: row[6],
});

// ghost/采样缓冲的 key。cells 走 ownerId#cid（cid 全局唯一，ownerId 只是让 key 可读、
// 并支撑 isMine 的前缀判断）；AI 目前一个 ownerId 只有一颗球，但同样用 cid——
// 将来 AI 会分裂时这里不用再改一次。
export const cellKey = (ownerId, cid) => `${ownerId}#${cid}`;
export const aiKey = (cid) => `ai:${cid}`;
