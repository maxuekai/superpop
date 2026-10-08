---
name: tuning-config-value
description: |
  改 superpop 的玩法数值（src/config.js）时的标准动作：先存基线 → 改 → 跑 verify →
  按参数类型补跑对应体检脚本 → 把结论和数字写回 docs/tuning.md。
  触发："AI 太傻/太粘""食物不够吃""速度太慢""改一下 KING.mass""视野不对"，
  或者任何准备动 src/config.js 的场合。
  关键：npm test 全绿**不代表**玩法没崩——手感类回归只有仿真能发现。
---

# 改玩法数值的标准动作

数值、公式、基线一律在 `docs/tuning.md`，本 skill 只写**流程**。需要具体数字时去那里查。

## 0. 先确认这个值真的有问题

不要因为"感觉不对"就动数值。先看它在 `docs/tuning.md` 里有没有对应的验收口径，
以及当前实测值离目标多远。手感类的直觉十有八九是错的（见 `device-feedback-triage`）。

## 1. 存基线

改之前先跑一遍并记下数字，**没有基线就无法判断改动是好是坏**：

```bash
npm run verify
```

至少记下：追击被吃轮次、被逼墙%、AI/玩家食物比、屏内食物数。

## 2. 改，只改一个

一次只动一个参数。`config.js` 里每个常量旁边都写了它的理由和当前实测值，
**先读那段注释**——很多参数已经被调过一轮，再调之前要知道当时为什么选那个值。

## 3. 跑 verify

```bash
npm run verify        # 语法 + 结构性 + 规则单测 + 不变量 + 两个仿真
```

`npm test` 只跑前两层，**发现不了手感类回归**。速度、AI 平衡、地图尺寸、视野
全都只影响仿真，单测对它们一概全绿。

## 4. 按参数类型补跑体检

verify 里的两个仿真只覆盖常规改动。改到下面这些，必须额外跑：

| 动了 | 还要跑 | 因为 |
|---|---|---|
| `WORLD` / `FOOD.count` | `node scripts/zoom-report.mjs --scan`<br>`npm run sim -- --worldW X --worldH Y` | 地图变大 → AI 抓不到；竖屏视野上限由世界**高度**决定 |
| `KING.mass` | `node scripts/endgame-check.mjs`<br>`node scripts/zoom-report.mjs` | 门槛可达吗？到线时球会不会占满屏幕 |
| `AI.*` | `npm run sim:food -- --trials 8`<br>（对比 `npm run sim`） | **单局是噪声，必须 `--trials 8` 以上** |
| `DIFFICULTY` 某档 | `node scripts/difficulty-report.mjs` | 三档要有实际可分辨的梯度 |
| `SPLIT.*` | `npm test` + 手动分裂 | `canSplit` / `splitCells` / `mergeCells` 有单测覆盖 |
| `PLAYER.spawnShield` 或重生相关 | `node scripts/respawn-check.mjs --reboot --move` | 重生后玩家能不能活下来 |

三个指标会**互相拉扯**（地图大了视野宽了但 AI 抓不到，AI 快了觅食好但玩家追不上）。
一次只动一个、一次只看它对应的指标。

## 5. 调参数用 flag

```bash
npm run sim -- --fleeRange 180        # ✅
npm run sim -- 180 180 1 0.1 90       # ⚠️ 位置参数，容易静默串位
```

`scripts/args.js` 会在撞值时明确报错，但批量调参一律用 flag 更省心。

## 6. 写回 tuning.md

**这一步不能省。** 记的是**结论和数字**，不是"改了 X"：

```markdown
`AI.foragePower`: 0.95 → 1.0
去掉 ai.js 里那层没注释的额外减速（0.92 × 0.95 = 0.874 倍满舵）。
为什么能动它：它只作用于非逃跑模式，speedScale 不变 → 逃跑速度不受影响。
实测：AI/玩家比 0.766 → 0.849，追击 20/20 → 18/20。
```

这个项目里好几个结论**推翻了直觉**（`fleeRange` 调高反而让 AI 更好抓、
食物目标滞后完全无效、地图放大导致 AI 变笨），只有写下来才不会重踩。

## 7. 提交

代码和文档分两个 commit。提交信息里写**根因和实测数字**，不写"修复了某 bug"。

## 不要做的事

- ❌ 用 `speedScale` 让 AI 变强 —— 它同时加快逃跑，AI 会变得抓不到。
  难度只调决策质量（见 `config.DIFFICULTY` 的注释）
- ❌ 靠改 `foodGain` 调平衡 —— 它影响质量不影响"吃食物的速度"，比值不会动
- ❌ 看完 `npm test` 通过就认为改动安全
- ❌ 只测新加的那个指标，不对基线项