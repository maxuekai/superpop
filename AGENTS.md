# AGENTS.md

本文件只写**每次改动都要知道的规则**；数值与理由见 [docs/tuning.md](docs/tuning.md)，
环境/工具问题见 [docs/node-env.md](docs/node-env.md)，进度见 [TODO.md](TODO.md)。
改动仓库结构、命令或关键行为时，请同步更新对应文件。

## 项目简介

superpop —— "球球大作战"网页版（Agar.io-like 网页游戏）。吃食物变大、大球吃小球、被吃后结算重生。
原生 ES modules + canvas 2D，**没有构建步骤**，浏览器直接加载源码。

当前状态：单机可玩（AI 对手 / 互吃 / 死亡重生 / 排行榜 / 分裂）。联机未接通（`server/index.js` 只是旧代码平移）。

## 运行

| 命令 | 作用 | 依赖 |
|---|---|---|
| `npm run dev` | 静态服务器 http://localhost:3000，打印局域网 URL 并生成 `qr.png`，手机同 Wi-Fi 扫码即玩；只放行 `/`、`/index.html`、`/src/**`、`/qr.png` | 无（二维码需可选的 `qrcode`，没装则只打印 URL） |
| `npm test` | `node --check` 全量语法检查 + `scripts/rules-test.js` 玩法规则检查 | 无 |
| `npm run sim` | AI 逃跑仿真：满舵猎手追击 20 轮，输出存活时间/被吃轮次/被逼墙比例 | 无 |
| `npm run sim:food` | 食物密度与成长仿真：密度、命中概率、速度剖面、玩家 vs AI 成长对比 | 无 |
| `npm run server` | 多人联机服务端（express + socket.io），未接通 | 需先 `npm install` |

非交互 shell 里 `npm` 不在 PATH 时先加 PATH，见 [docs/node-env.md](docs/node-env.md)。

## 目录结构

```
├── index.html            # canvas + 体重面板 + 排行榜 + 摇杆 + 开局/结算弹层 + 分裂按钮
├── src/
│   ├── main.js           # 入口：装配 Game / Joystick / Keyboard / Hud
│   ├── config.js         # 全部可调常量（每个都写了调它的理由）
│   ├── core/             # 玩法逻辑，纯逻辑、不碰 DOM
│   │   ├── game.js       # 主循环（固定步长）、调度与渲染
│   │   ├── rules.js      # 裁定层：互吃/吃食物/名次/排行榜/分裂合并/AI 数量/出生点
│   │   ├── ball.js       # 球基类：移动、钳制、弹簧回弹、绘制、进食与互吃判定、出生保护
│   │   ├── player.js     # 玩家细胞（继承 Ball，共享 ownerId）
│   │   ├── ai.js         # AI 细胞（继承 Ball，加决策与逃跑方向打分）
│   │   ├── camera.js     # 死区跟随相机，视口钳制在世界内，支持 snapTo
│   │   ├── map.js        # 背景程序生成，只烤一次，按视口裁剪
│   │   ├── rectangle.js  # 矩形工具（within/overlaps）
│   │   └── utils.js      # 数学、随机、clamp、clusterOffset、formatTime、颜色
│   ├── input/            # joystick.js（浮动摇杆）/ keyboard.js（WASD + 动作键）
│   ├── ui/hud.js         # DOM 层：体重面板、排行榜、弹层、分裂按钮
│   ├── styles/           # reset.css + index.css
│   └── net/client.js     # 联机客户端占位（未实现）
├── server/               # dev-server.js（开发预览）/ index.js（联机，未接通）
├── scripts/              # check.js / rules-test.js / flee-sim.js / food-sim.js
└── docs/                 # tuning.md（数值与实测）/ node-env.md（环境坑）
```

## 约定

- 纯原生 ES modules，无打包器、无转译；沿用 `import/export`。
- 4 空格缩进、JS 单引号、LF 换行（见 `.editorconfig`）。
- 界面文案用中文，代码标识符用英文。
- **玩法逻辑只放在 `core/` 的纯逻辑类里**（不碰 `document`），这样 `rules-test.js` 才能在 node 里直接测；
  `ui/hud.js` 只做 DOM 读写。事件监听目标由构造传入（`new Keyboard(document, ...)`），不要在类里直接摸 `document`。
- 服务端与客户端的事件名约定：`registe` / `create` / `enter` / `update`（改动需两端同步）。
- 保持行为等价：改之前先看 TODO.md 对应条目，别顺手改出与记录不符的行为。

## 关键行为（重构时勿意外改变）

**架构类**

- **新增玩法规则优先写进 `core/rules.js`**（纯函数、不碰 DOM），`Game` 只负责调度与渲染——只有这样才能被单测覆盖。
- **固定步长**：`Game.loop` 用累加器按 `TICK.fps`(60) 推进，每帧上限 `maxSteps` 步，超出丢积压；渲染跟随刷新率。
  `Ball.update(dt)` 的位移与弹簧都乘 `dt * speedUnit`，否则 120Hz 手机上球速会是 60Hz 的两倍。
- **状态机**：`menu` → `playing` → `dead`（被吃）/ `crowned`（称王）。只有 `playing` 跑 `updateWorld`，
  弹层期间世界冻结。称王条件在 `rules.isCrowned`（质量 ≥ `KING.mass` **且**当前第一）。
- **世界尺寸与食物数必须同步**：`WORLD` 和 `FOOD.count` 一起改，保持面密度 λ 不变
  （屏内食物数 = λ × 视口面积）。竖屏手机的视野上限由**世界高度**决定，世界越高缩放区间越长。
- **相机钳制**：视口大于世界时 `Camera.clampView` 必须**居中**，不能贴左上角——旧的"左边超出→贴左"
  和"右边超出→贴右"两条规则会互相打架，`xView` 在负坐标和 0 之间横跳、球偏在屏幕一侧。
  `VIEW.maxZoomOut`(1.3) 靠这个居中行为才成立。
- **改 WORLD 前必须扫三个指标**：`npm run sim -- --worldW X --worldH Y`（追击难度，地图越大 AI 越抓不到）、
  `npm run sim:food -- --trials 8`（AI/玩家平衡 + 屏内食物数）、`node scripts/zoom-report.mjs --scan`
  （缩放区间）。三者互相拉扯。想延长单局请调 `KING.mass`，不要继续放大地图。
- **AI 的觅食减速和逃跑减速是两个系数**：`AI.foragePower` 只作用于非逃跑模式，`AI.speedScale` 两边都乘。
  想让 AI 吃得多只能动前者——动 `speedScale` 会同时加快逃跑，实测 0.92→1.05 让被吃率从
  20/20 崩到 4/20（"AI 吃得多"和"抓得住 AI"是对立的）。
- **视野缩放必须平滑**：`updateViewScale` 用 `utils.smoothTowards` 指数逼近目标值，
  不能直接赋值。目标缩放的来源全是硬跳变——手机地址栏收放（实测一帧跳 12~15% 视口宽度）、
  转屏（33%）、吃人、分身合并。`resize()` 也不能无条件 snap，否则又回到硬跳；
  只有首次布局和重开一局才 snap。指数平滑的单帧幅度与跳变大小无关，线性插值做不到。
- **改 WORLD 前必须扫追击难度**：`npm run sim -- --worldW X --worldH Y`。地图越大 AI 越抓不到
  （2048×1536 时被吃率从 20/20 掉到 2/20，游戏会退化成纯刷食物）。想延长单局请调 `KING.mass`。
- **输入层是 `game.input`**，摇杆与键盘都写它，再由 `updateWorld` 同步给每一个分身——
  分身不是一个球，直接共享球对象的话输入只会作用在其中一个上。
- 渲染按 `devicePixelRatio` 缩放后平移到相机视口；食物**不烤进地图**，每帧按视口动态绘制并**按颜色合批**。

**玩法类**

- **质量口径统一为 `r²`**；体重面板与排行榜按「玩家整组分身质量之和」统计。
- **半径必须封顶**（`WORLD.maxBallRadius`，经 `utils.capRadius`）：`Ball.update` 的边界钳制是
  `x = min(max(r, w-r), max(r, x))`，r 一旦超过世界宽度，`w-r` 变负，球心就被硬推到**界外**，
  而相机视口 clamp 在世界内 → 球永远在屏幕外、走不回来（死档）。**三条增长路径都要 clamp**：
  `Ball.absorb`（互吃）、`resolveFoodEating`（吃食物）、`mergeCells`（分身合并，√2 倍最容易漏）。
  新增增长路径时记得也过一遍。
- **互吃**：尺寸比 > `EAT.ratio`(1.15) 且**两个圆有重叠**（中心距 ≤ r1+r2），质量 `r = sqrt(r² + 对方r² × absorb)`。
  口径是「碰到边缘就吃」而不是「圆心进入体内」——后者会让小球贴着大球边缘擦过去而不死，
  真机反馈过"不是应该一碰到边缘就被吃吗"。
- **软碰撞的阈值必须和互吃一致**（都是 r1+r2），且 `eatBalls()` 必须排在 `separateBalls()` 之前：
  尺寸够、又没有出生保护的重叠对，一定已经在 `resolveEatings` 里被吃掉，不会走到弹开。
  两者一旦不一致（或顺序颠倒），猎物会被永久锁死在半径和上进不去——**谁都吃不掉谁**。
  同一个坑踩过两次：① 互吃曾是「圆心进体内」而弹开是「半径和」；② 例外判断曾用
  `canEatBall`（含距离条件，此刻必然为 false）而不是尺寸判断。不要再加尺寸例外分支。
- **一帧内先配对再结算**：`resolveEatings` 按帧初状态配对，**已被吃掉的球不再作为吃人方**——
  否则「A 吃 B、B 吃 C」的结果会依赖数组顺序，同一局重放结果就变了。
- **分裂**：够大的细胞一切两半，**质量守恒**（原球自己变成一半）、分开方向垂直于移动方向、冷却防连点、
  靠拢自动合并；**同一 ownerId 的分身之间不能互吃**，分身被吃只损失那份质量，**全灭才判死亡**。
  镜头与视野跟随最大的分身，所以分裂时视野不跳。
  **禁用态必须说得出原因**：分身数达 `SPLIT.maxCells` 时按钮显示"已达上限"而不是消失——
  玩家从画面上看不出这个限制。判定在 `rules.splitStatus`（纯函数可单测）。
- **重生必须连世界一起重置**（`Game.restartWorld`，`begin`/`respawnPlayer` 都调）：AI 的体型会跨玩家的
  死亡保留下来，而 `syncAiCount` 只在"数量超编"时踢人——6 个 AI / 目标 6 个时一个都不踢。
  于是玩家重生回 100kg 时，场上每个球都吃得掉它、它吃不掉任何一个，实测连试 8 次只活
  3/5/7/7/5/6/4/8 秒。「再来一局」在玩家看来必须是新的一局。体检：`node scripts/respawn-check.mjs`。
- **AI 决策**：逃离更大的球 > 追击更小的球 > 觅食 > 游走；逃跑方向从多个候选方向打分挑最优
  （离威胁远 + 不贴墙 + 不撞球 + 顺手吃路边食物），不是沿直线跑（那会被逼到墙角撞死）。
- **出生点避开所有存活球**并远离世界边缘；出生保护期内吃不掉（玩家 2.5s / AI 1.5s，画光环），
  保护时间从真正 `begin()` / `respawnPlayer()` 那一刻起算。
- **食物成簇生成**：先定避开球的簇心、每颗落在簇半径内（散点太难点，手机上只有几像素）。

**输入类**

- 摇杆是浮动模式：按住屏幕任意位置出现，松手即停，多指只认第一根；`.ui-interactive` 元素上的触摸
  不接管也不 `preventDefault`，否则弹层里的按钮点不动。
- 键盘 `WASD`/方向键，斜向归一化；摇杆正在操控时键盘让位；输入框/弹层里打字不响应；
  `blur` 与 `visibilitychange` 要清空按键，防止 keyup 丢失后"卡住一直走"。

## 测试与调参

- `npm test`：语法检查 + 58 条玩法规则单测，分五组（球规则 / AI 决策 / 输入 / 整局裁定 / 分裂合并）。
  **改动 `src/core/` 下任何玩法逻辑或 `src/config.js` 的数值后必须跑一次。**
  `Game` 本身依赖 canvas 无法直接测，它的行为靠两个仿真脚本回归。
- 调手感参数前先读 [docs/tuning.md](docs/tuning.md)：里面有公式、当前值、实测数据与验收口径
  （改速度要连带看 AI 探测距离、改食物要考虑 AI 一起变快、"大球追不上"要用仿真扫描而不是看公式）。
  仿真脚本都支持命令行覆盖，可先试值再决定改代码。