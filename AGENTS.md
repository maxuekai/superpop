# AGENTS.md

本文件只写**每次改动都要知道的规则**；数值与理由见 [docs/tuning.md](docs/tuning.md)，
环境/工具问题见 [docs/node-env.md](docs/node-env.md)，进度见 [TODO.md](TODO.md)。
改动仓库结构、命令或关键行为时，请同步更新对应文件。

## 项目简介

superpop —— "球球大作战"网页版（Agar.io-like 网页游戏）。吃食物变大、大球吃小球、被吃后结算重生。
原生 ES modules + canvas 2D，**没有构建步骤**，浏览器直接加载源码。

当前状态：**单机可玩 + 联机 M1 可玩**（单机：AI 对手 / 互吃 / 死亡重生 / 排行榜 / 分裂；
联机：`npm run server` 局域网扫码进房，服务端权威 + 快照渲染，见 TODO.md 第二阶段）。

## 运行

| 命令 | 作用 | 依赖 |
|---|---|---|
| `npm run dev` | 静态服务器 http://localhost:3000，打印局域网 URL 并生成 `qr.png`，手机同 Wi-Fi 扫码即玩；只放行 `/`、`/index.html`、`/src/**`、`/qr.png` | 无（二维码需可选的 `qrcode`，没装则只打印 URL） |
| `npm test` | `node --check` 全量语法 + 结构性检查 + 规则单测 | 无 |
| `npm run verify` | **改动 `src/config.js` 数值后必须跑这个**：上面全部 + 不变量断言 + 两个仿真 | 无 |
| `npm run invariants` | 只跑 config 层硬约束断言（面密度、半径上限、称王门槛可达性…） | 无 |
| `npm run sim` | AI 逃跑仿真：满舵猎手追击 20 轮，输出存活时间/被吃轮次/被逼墙比例 | 无 |
| `npm run sim:food` | 食物密度与成长仿真：密度、命中概率、速度剖面、玩家 vs AI 成长对比 | 无 |
| `npm run sim:net` | **联机仿真**：真 socket.io + TCP 代理注入延迟（默认 80/150ms 单向），三客户端跑真实对局，自动判定预测误差/互吃两端一致/带宽与快照频率 | 需 `npm install`（socket.io-client，仅仿真用） |
| `npm run server` | **联机服务器**：同端口托管静态文件 + ws + 局域网 URL/二维码打印；60Hz 跑 World、20Hz 发快照。与 `npm run dev` 同抢 3000 端口，**二选一跑** | 需先 `npm install`（socket.io） |

**非交互 shell（Agent 跑命令）的坑**：shell 不加载 profile 时 `node/npm` 不在 PATH，且
`cd` 进仓库会触发 fnm 钩子报错——它返回非零退出码，`cd 仓库 && npm test` 会**整条断掉**。
每个新 shell 先执行（glob 不钉版本，已验证）：

```bash
export PATH="$(ls -d "$APPDATA"/fnm/node-versions/*/installation | sort -V | tail -1):$PATH"
```

然后用 `cd 仓库; npm test`（`;` 不被 cd 的退出码短路）或 `git -C 仓库 …`。PowerShell 方言见 [docs/node-env.md](docs/node-env.md)。

## 目录结构

```
├── index.html            # canvas + 体重面板 + 排行榜 + 摇杆 + 开局/结算弹层 + 分裂按钮
├── src/
│   ├── main.js           # 入口：装配 Game / Joystick / Keyboard / MouseSteer / Hud，滚轮缩放
│   ├── config.js         # 全部可调常量（每个都写了调它的理由）
│   ├── core/             # 玩法逻辑，纯逻辑、不碰 DOM（例外：log-panel 挂 DOM）
│   │   ├── world.js      # 无头世界：食物/AI/玩家组/互吃/分裂/重生/称王，事件走回调
│   │   │                 # （单机 Game 与联机服务端跑同一份；联机见 TODO.md M0~M4）
│   │   ├── game.js       # 壳：状态机 + 主循环（固定步长）+ 调度 + 渲染 + 输入
│   │   ├── rules.js      # 裁定层：互吃/吃食物/名次/排行榜/分裂合并/AI 数量/出生点
│   │   ├── ball.js       # 球基类：移动、钳制、弹簧回弹、绘制、进食与互吃判定、出生保护
│   │   ├── player.js     # 玩家细胞（继承 Ball，共享 ownerId）
│   │   ├── ai.js         # AI 细胞（继承 Ball，加决策与逃跑方向打分）
│   │   ├── camera.js     # 死区跟随相机，视口钳制在世界内，支持 snapTo
│   │   ├── map.js        # 背景程序生成，只烤一次，按视口裁剪
│   │   ├── log.js        # 诊断日志环形缓冲（埋点埋在 game/ball，默认开）
│   │   ├── log-panel.js  # 运行日志 DOM 面板（?debug=1 挂载）
│   │   ├── rectangle.js  # 矩形工具（within/overlaps）
│   │   └── utils.js      # 数学、随机、clamp、smoothTowards、zoomTarget、颜色
│   ├── input/            # joystick.js（浮动摇杆 + 双指捏合缩放）/ keyboard.js（WASD + 动作键 + 缩放键）
│                         #   / mouse.js（桌面鼠标朝光标方向走）
│   ├── ui/hud.js         # DOM 层：体重面板、排行榜、弹层、分裂按钮、单机/联机选择
│   ├── styles/           # reset.css + index.css
│   └── net/client.js     # 联机客户端：NetSession（连接/输入/动作）+ NetWorld（快照→插值渲染）
├── server/               # dev-server.js（开发预览）/ index.js（联机服务器：静态+ws 同端口、60Hz World、20Hz 快照）
├── scripts/              # 仿真与检查全套：
│                         #   args.js（仿真共用 flag 解析 + 撞值护栏）
│                         #   check.js（语法 + 结构性检查）/ rules-test.js（127 条规则单测）
│                         #   invariants.js（config 硬约束断言，11 条）
│                         #   flee-sim.js（追击仿真）/ food-sim.js（觅食仿真）
│                         #   net-sim.mjs（联机仿真：真 socket.io + 注入延迟，需 socket.io-client）
│                         #   respawn-check / endgame-check / zoom-report / difficulty-report（体检脚本）
├── .agents/skills/       # 项目级 skill：tuning-config-value / device-feedback-triage /
│                         #   no-silent-failure / superpop-browser-test（浏览器实测套路）
└── docs/                 # tuning.md（数值与实测）/ node-env.md（环境坑）
```

## 约定

- 纯原生 ES modules，无打包器、无转译；沿用 `import/export`。
- 4 空格缩进、JS 单引号、LF 换行（见 `.editorconfig`）。
- 界面文案用中文，代码标识符用英文。
- **玩法逻辑只放在 `core/` 的纯逻辑类里**（不碰 `document`），这样 `rules-test.js` 才能在 node 里直接测；
  `ui/hud.js` 只做 DOM 读写。事件监听目标由构造传入（`new Keyboard(document, ...)`），不要在类里直接摸 `document`。
- **联机协议（唯一权威定义在 `server/index.js` 头注释，改动需两端同步并更新这里）**：
  C→S `join{name,viewport,token?}` / `input{x,y}` / `split` / `again{name}` / `viewport{w,h}`；
  S→C `welcome{selfId,time,configHash,world,food,roster,board,roundRemaining,resumeToken,resumed,death}` /
  `snapshot{t,cells[],ai[],food{a,e},board?,my}` / `roster{entries}` / `eaten{mass,rank,by,stats}` /
  `crowned{ownerId,name,mass,countdown}` / `newRound{time}` / `left{id}` / `rejected{reason}`。
  旧协议的 `registe`/`create`/`enter`/`update`（含拼写错误）已废弃，别再引用。
  客户端侧还多两个**本地**事件（不经协议）：`netdown`（断线、正在退避重连）与
  `resumed{death}`（重连成功），由 `NetSession` 合成后交给 `Game.onNetEvent`——
  新增 S→C 事件时这两条要一起看，别只改一边。
- **快照的元组形状只在 `core/protocol.js` 定义一次**（服务端 `encodeBall`、客户端 `decodeBall`、
  单测三方共用，`rules-test.js` 里有一条用真实编码器造快照喂 NetWorld 的测试盯着它）。
  `cells[]`/`ai[]` = `[ownerId, cid, x, y, r, shielded, colorIdx]`，坐标 ×2 量化：
  - **cid 是细胞的稳定身份，构造时分配、永不改变**（`Ball.cellSeq`）。客户端拿它当 ghost 的 key，
    **绝对不要退回 `ownerId#index`**——index 是组内数组位置，被吃一颗中间分身或两个分身合并
    就会重排，key 被复用给别的球，对端看到 ghost 瞬移一帧（回归测试：
    「分身被吃导致索引重排时 ghost 不被复用」）。分裂时原球保留 cid、新半球拿新 cid；
    合并时被并掉的消失；重生是新 cid。
  - **改协议形状必须三步一起做**：改 `protocol.js` → `PROTOCOL_VERSION + 1` → 同步
    `server/index.js` 头注释与本节。版本号算进了 `configHash`，所以漏掉第二步的后果是
    浏览器里的旧客户端连上新宿主、静默解出错位的值——configHash 覆盖不到形状，只覆盖数值块。
- **回合制（称王即终局，2026-10-11 产品决策）**：有人称王 → 服务端广播 `crowned`（带
  countdown=8s）→ 世界冻结、所有人看全场结算（重生按钮/输入框藏起来，**不用点任何东西**）→
  倒计时到点服务端 `startNewRound()`（所有人 respawnGroup 回出生体重 + 稀疏选点 + 保护，
  world.reset() 重铺 AI 与食物）→ 广播 `newRound`。中途加入者在 welcome.roundRemaining
  里拿到剩余秒数，直接进结算界面等下一局。测试钩子：`SUPERPOP_DEBUG=1` 下客户端可发
  `debug:forceCrown` 把自己顶到称王线，验证全流程不用真打几分钟。
- **联机红线**：世界只在服务端跑（`core/world.js` 同一份）；客户端 = 远程球插值渲染 + 输入上行 +
  **本地移动预测**（自己的细胞用同一套 `Ball.update` 按本地输入即时推进，快照到达时对账：
  参考点先按快照年龄外推再比对——否则预测会恒定超前 30 单位；小误差拉回 15%/快照、
  大误差（>半径）或结构变化（分裂/合并/死亡）直接吸附。分裂/被吃不做预测）。
  `welcome.configHash` 必须与客户端 `core/config-hash.js` 比对，不一致当场拒绝
  （两端跑不同数值的 bug 靠手感永远查不出来）。快照坐标是 **×2 量化值**，
  客户端解码除回 2；颜色按 `COLORS` 下标、名字走 roster（`{entries}` 载荷形状别弄错）。
  输入节流按**游戏帧数**计（每 2 帧一包 = 30Hz），不能用真实时钟——泵帧/高刷/卡顿恢复时
  真实时钟会把方向变化整段吞掉（实测踩过）。服务端快照按**真实时间门控**（50ms）发射，
  不能绑 setInterval 触发次数——Windows 上它实测 ~29ms 才触发一次，绑次数只有 ~12 帧/秒
  （p95 间隔 244ms），插值缓冲被打穿就是"联机卡顿"。
  新增 S→C 事件时**客户端 socket.on 绑定与 Game.onNetEvent 处理器要成对加**——
  只写处理器不绑监听，事件静默丢失、状态卡死（实测踩过：newRound 漏绑，全场卡在结算）。
  结算期（ending）世界冻结但**快照照常发射**——中途加入者的 `firstSnapshot()` 靠它进结算界面，
  别把 ending 分支改回"return 不发"。C→S 全消息面有令牌桶限频（input 60/s、其余 10/s），
  超限静默丢包；`again` 服务端校验无存活细胞才放行（否则活着能刷重生+护盾）。
- **断线重连（M4，协议 v3）**：断线**不立刻移除**——细胞留在场上（输入清零，站着不动，
  会被 AI 吃掉），`NET.graceSeconds`(10s) 内带 `join.token = 上次的 welcome.resumeToken`
  重连即**认领原细胞**：ownerId 与 cid 都不变（cid 变了就是"换了个新人"，客户端 ghost 全重画）。
  超期才 `removeGroup` + 广播 `left`，**断线期间不发 `left`**（人还在场上）。
  三条容易踩的：
  ① 认领判断必须在「房间已满」**之前**——宽限期内的组本来就占着 `MAX_PLAYERS` 名额，
     反过来判会把自家重连挡在门外；
  ② 宽限期内被 AI 吃光的话，服务端要记住死亡瞬间的 mass/rank（`eaten` 事件那时没有 socket 可发），
     重连时随 `welcome.death` 带回，否则客户端只看到"没有球"和一个算不出名次的 0kg 结算；
  ③ 客户端断线后**冻结**（`NetWorld.tick(dt, input, frozen)` + 不上行输入）：服务端输入已清零，
     本地还按旧输入推的话球会自己漂一小段、重连后又被吸附回去，像抽搐。
     退避重连失败耗尽才回菜单（`NET.reconnectTries` × 退避 > 宽限期），失败中途不能放弃——
     中途放弃就会出现"客户端还在重试、服务端已删人"的空档。
- 保持行为等价：改之前先看 TODO.md 对应条目，别顺手改出与记录不符的行为。
- commit 消息：`feat:` / `fix:` / `docs:` / `refactor:` + 中文标题；**正文写根因与实测数字**
  （"为什么改、凭什么说改对了"），代码与文档分开提交。

## 关键行为（重构时勿意外改变）

**架构类**

- **新增玩法规则优先写进 `core/rules.js`**（纯函数、不碰 DOM）——只有这样才能被单测覆盖。
  玩法状态住 `core/world.js`（无头世界，事件走 `onEvent` 回调而不是直接调 hud）：
  `Game` 只是「状态机 + 调度 + 渲染 + 输入」的壳，联机服务端 import 的就是这同一个 World。
  玩家组（ownerId → cells/input/stats）是 World 的一等公民：单机只有一个组，联机每人一组。
- **固定步长**：`Game.loop` 用累加器按 `TICK.fps`(60) 推进，每帧上限 `maxSteps` 步，超出丢积压；渲染跟随刷新率。
  `Ball.update(dt)` 的位移与弹簧都乘 `dt * speedUnit`，否则 120Hz 手机上球速会是 60Hz 的两倍。
- **不要提议把渲染层换成成熟框架（PixiJS / Phaser / Three）**——2026-10-17 已评估并否决，
  依据见 [docs/tuning.md](docs/tuning.md#渲染层维持-canvas-2d2026-10-17-评估结论不换)：
  ① 单帧只有几十~几百次 canvas 调用（地图 1 次 blit + 食物 6 次合批 + ≤76 个球），远未到瓶颈；
  ② **零构建步骤是承重结构**，CDN 会打死"手机同 Wi-Fi 扫码即玩"这条主部署路径；
  ③ 通用引擎自带主循环/物理，会破坏"服务端 import 的就是单机那份 `core/World`"这个前提，
     而联机模式整个建立在它上面。**怀疑渲染慢时先用 `?debug=1` 的 `frameMs` 量真机数字**，
     别靠猜。真要提升视觉上限（metaball/辉光）走**球层裸 WebGL**，别引框架，
     也别用 `shadowBlur` 凑合（软件模糊，真机直接掉帧）。
- **状态机**：`menu` → `playing` → `dying`（被吃演出）→ `dead`（结算）/ `playing` → `crowned`（称王）。
  只有 `playing` 与 `dying` 跑 `world.update`（`dying` 按 `DEATH.slowMoScale` 慢放，`world.time` 跟世界走，
  演出计时 `dyingTimer` 用真实秒），播完 `finishDeath()` 才弹结算；弹层期间世界冻结。
  被吃/称王由 World 发 `eaten`/`crowned` 事件、Game 只处理本地组并决定怎么演；
  组被全灭后死细胞**留在 `group.cells` 里**（alive=false，镜头死亡演出期间跟着它），
  消费方（质量/排行榜/分裂/绘制）一律按 alive 过滤——别"顺手"把死细胞从数组里删掉。
  称王条件在 `rules.isCrowned`（质量 ≥ `KING.mass` **且**当前第一）。
- **世界尺寸与食物数必须同步**：`WORLD` 和 `FOOD.count` 一起改，保持面密度 λ 不变
  （屏内食物数 = λ × 视口面积）。竖屏手机的视野上限由**世界高度**决定，世界越高缩放区间越长。
- **相机钳制**：视口大于世界时 `Camera.clampView` 必须**居中**，不能贴左上角——旧的"左边超出→贴左"
  和"右边超出→贴右"两条规则会互相打架，`xView` 在负坐标和 0 之间横跳、球偏在屏幕一侧。
  `VIEW.maxZoomOut`(1.6) 靠这个居中行为才成立。
- **改 WORLD 前必须扫三个指标**：`npm run sim -- --worldW X --worldH Y`（追击难度，地图越大 AI 越抓不到）、
  `npm run sim:food -- --trials 8`（AI/玩家平衡 + 屏内食物数）、`node scripts/zoom-report.mjs --scan`
  （缩放区间）。三者互相拉扯。想延长单局请调 `KING.mass`，不要继续放大地图。
- **AI 的觅食减速和逃跑减速是两个系数**：`AI.foragePower` 只作用于非逃跑模式，`AI.speedScale` 两边都乘。
  想让 AI 吃得多只能动前者——动 `speedScale` 会同时加快逃跑，实测 0.92→1.05 让被吃率从
  20/20 崩到 4/20（"AI 吃得多"和"抓得住 AI"是对立的）。
- **视野缩放必须平滑**：`updateViewScale` 用 `utils.smoothTowards` 指数逼近目标值，
  不能直接赋值。目标缩放的来源全是硬跳变——手机地址栏收放（实测一帧跳 12~15% 视口宽度）、
  转屏（33%）、吃人、分身合并、**用户手动缩放（滚轮/+/−/双指捏合改 `game.userZoom`）**。
  `resize()` 也不能无条件 snap，否则又回到硬跳；只有首次布局和重开一局才 snap。指数平滑的单帧幅度与跳变大小无关，线性插值做不到。
  **用户缩放是乘在自动缩放上的系数**（`VIEW.userZoomMin/Max` = 0.5~2.0），合成在 `utils.zoomTarget`：
  缩出钳在 `fitScale`（不越过 `maxZoomOut` 包络，否则露出更多空白、架空视野类不变量），
  缩进钳在自动值 × `userZoomMax`。`userZoom` 是视角偏好，重开一局不清。
- **改 WORLD 前必须扫追击难度**：`npm run sim -- --worldW X --worldH Y`。地图越大 AI 越抓不到
  （2048×1536 时被吃率从 20/20 掉到 2/20，游戏会退化成纯刷食物）。想延长单局请调 `KING.mass`。
- **输入层是 `game.input`**，摇杆、键盘、鼠标都写它，再同步进玩家组（`group.input`）、由 `world.update`
  写给每一个分身——分身不是一个球，直接共享球对象的话输入只会作用在其中一个上。
- **三种输入互不打架，靠"谁最后动谁生效"**：鼠标只在 `pointermove` 写、键盘只在 `keydown` 写，
  按住 W 不动鼠标就一直是键盘在管，反之亦然。不要为它们加仲裁状态机。
  鼠标给的是**方向不是位移**（光标到球的像素距离与力度无关），力度复用 `JOYSTICK.radius`
  走同一套速度分母；鼠标监听 **canvas** 而不是 document——HUD 面板浮在画布上方，
  指针停在面板上时画布收不到事件，球自然不动，不需要再判 `.ui-interactive`；
  合成 touch 指针事件与摇杆让位要各挡一道（见 `MouseSteer.isTouch` / `isBlocked`）。
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
- **分裂与合并的手感反馈成对**：`rules.splitCells` 写外冲速度（`applySplitPush`），
  `rules.mergeCells` 写 `mergeStun`/`mergeWobble`（`SPLIT.mergeStun*`），都由 `Ball.update` 消费。
  按 `applySplitPush` 的约定，**rules.js 里直接写字段、不调方法**（core 不能假设调用方传的是
  Ball 子类）。僵直的最后一帧必须把 `mergeWobble` 清零——留个 k 的残值就是"球永远是椭的"。
  联机侧合并不额外发事件（纯表现不值带宽），客户端由**自己这一组活细胞数变少且没全灭**来推断
  （`NetWorld.detectMyMerge`）；别人的组不能这么推断——少一颗也可能是离开 AOI。
- **重生必须连世界一起重置**（`Game.restartWorld`，`begin`/`respawnPlayer` 都调）：AI 的体型会跨玩家的
  死亡保留下来，而 `syncAiCount` 只在"数量超编"时踢人——6 个 AI / 目标 6 个时一个都不踢。
  于是玩家重生回 100kg 时，场上每个球都吃得掉它、它吃不掉任何一个，实测连试 8 次只活
  3/5/7/7/5/6/4/8 秒。「再来一局」在玩家看来必须是新的一局。体检：`node scripts/respawn-check.mjs`。
- **AI 决策**：逃离更大的球 > 追击更小的球 > 觅食 > 游走；逃跑方向从多个候选方向打分挑最优
  （离威胁远 + 不贴墙 + 不撞球 + 顺手吃路边食物 + **绕圈偏置**），不是沿直线跑（那会被逼到墙角撞死）。
- **绕圈拖延（`AI.fleeOrbit*`）必须落在 `fleeRange` 之内**：偏置的闸门是
  `fleeOrbitNear → fleeRange` 插值，`fleeOrbitNear` 一旦 ≥ `fleeRange`，AI 根本不会逃到那么远，
  闸门永远打不满、`fleeOrbit` 就成了**死参数**（第一版就是这么写的：240 vs 160，
  40 轮实测全部落在噪声里，白写）。**做法是打分偏置，不是旋转选出来的方向**：
  旋转发生在贴墙/撞球惩罚项算完之后，转完可能正对着墙（实测偏转强度 ≥0.65 时被逼墙
  0.9% → 4~5%）；偏置让打分函数自己去挑，墙的约束一直在，绕不出去就不绕。
- **难度档位只调决策质量，且必须先修度量再调参**：三档 speedScale 相同（动了它 AI 就抓不到），
  差别全在 `DIFFICULTY.*` 覆写值。两个曾经让"调参无效"的度量盲区已经堵上，**别再退回去**：
  ① 成长速度只看「吃了几颗食物」会漏掉 `foodGain`——它改的是**每颗的肉**，颗数一样肉量差三成，
  必须看 `food-sim` 的「AI 30s 平均体重」；② 仿真猎手如果永远瞄当前位置，`chaseLead` 就是
  **死参数**，`flee-sim --hunterLead N` 才是那个口径。改任一档后跑
  `node scripts/difficulty-report.mjs`，它自动判定验收线（两种口径被吃率 easy>normal>hard 单调、
  体重三档单调且档差 ≥15%、normal 守住锚点），不合格 exit 1。
  **两个已实测的反直觉点**：`escapeSamples` 在 16 以上饱和、`escapeChange` 压低反而更好抓
  （不可预测性对两种猎手都只帮猎物）——它们不是难度杠杆。`DIFFICULTY.normal` 必须与
  `AI.*` 默认值逐项相同（脚本会比对）。数字与依据见 docs/tuning.md「难度档位」。
- **出生点避开所有存活球**并远离世界边缘；出生保护期内吃不掉（玩家 2.5s / AI 1.5s，画光环），
  保护时间从真正 `begin()` / `respawnPlayer()` 那一刻起算。
- **食物成簇生成**：开局 `seedFood` 按 `clusterSize` 颗/簇铺满，**同簇共享颜色**（成片可扫；
  逐颗随机色会糊成彩屑）。被吃掉的单颗重生默认贴着一颗随机幸存食物落子并**继承它的颜色**——
  簇从邻居"长回来"，否则会退化回散点；但纯邻居锚定有盲区：被吃光的区域永远没有锚点，
  实测 8 个 AI 吃 6 分钟 96% 的地图会变成食物荒漠（真机反馈"刚出生吃不动东西"），
  所以按 `FOOD.emptyRegionBias`(0.25) 的概率把重生**改投当前最空的格子**给空区播种
  （新种子用随机色，之后仍走邻居锚定长成簇）。绘制半径有 `radiusJitter` 抖动（纯视觉），
  **吃判定始终用基准 `FOOD.radius`**，别把抖动带进碰撞。详见 docs/tuning.md 食物视觉一节。

**输入类**

- 摇杆是浮动模式：按住屏幕任意位置出现，松手即停；第一根非界面手指操控，
  **第二根画布手指进入双指捏合缩放**（摇杆暂停、面板藏起、方向清零；抬指后原地恢复，
  重新锚定原点避免把抬指瞬间的位移当方向）。`.ui-interactive` 元素上的触摸
  不接管也不 `preventDefault`，否则弹层里的按钮点不动——对第二根手指同样成立
  （按钮上的手指不进捏合）。
- 桌面鼠标：球朝光标方向走（不用按住），**监听 canvas**、只认 `pointerType==='mouse'`；
  摇杆操控中与菜单/结算期间让位。`pointerleave` 与 `blur` 都要清零输入——
  光标不动但窗口切走时，上一帧方向还留在 `input` 里，球会一直朝那边走。
- 键盘 `WASD`/方向键，斜向归一化；**`+`/`−` 缩放视野**（一次一档，按住靠系统自动重复）；
  摇杆正在操控时键盘方向让位（缩放不让，它是视角偏好不是移动）；输入框/弹层里打字不响应；
  `blur` 与 `visibilitychange` 要清空按键，防止 keyup 丢失后"卡住一直走"。
- 桌面滚轮缩放挂在 canvas 上；**Ctrl+滚轮不拦**（留给浏览器的页面缩放）。

## 测试与调参

- `npm run verify`：**改动任何玩法数值后的唯一入口**，按顺序跑五层——
  ① 语法 + 结构性检查 ② 规则单测（127 条；**条数以 `npm test` 输出的 `rules check: N/N` 为准**，
  别再在文档里手写一个会漂的数字——本文件曾经同时写着 86 和 108，README 写着 115）③ config 不变量断言（11 条）
  ④ 追击仿真 ⑤ 觅食仿真。
- `npm test` 只跑前两层，**发现不了手感类回归**。速度、AI 平衡、地图尺寸、视野全都只影响仿真，
  单测对它们一概全绿——这次踩过的最贵的几个坑都是"`npm test` 全绿但玩法已经崩了"。
  **改 `src/config.js` 的数值 → 只跑 `npm test` 等于没测。**
- `scripts/check.js` 除了语法还查两件**语法合法但结论是错的**的事：
  仿真里硬编码 config 参数（`flee-sim.js` 曾写死旧世界，于是"玩家追 AI 17/20"其实是在
  旧地图上测的，还被当成过"无回归"的证据）、以及未被引用的导出/类方法
  （`Rectangle.within` 就是这样消失的）。
- `scripts/invariants.js`：把散在本文档里的硬约束写成**会失败的断言**——面密度、
  半径上限装得进世界、称王门槛在上限之内且球不超过视口宽的一半、分裂间距大于合并阈值、
  难度档位不许动速度…… 违反了当场炸，而不是几周后靠"手感不对"才发现。
- `Game` 本身依赖 canvas 无法直接测，它的行为靠两个仿真脚本回归。
- **联机没有单测兜底，靠 `npm run sim:net`**：真 socket.io + TCP 代理注入单向延迟
  （80/150ms 两档），三客户端跑真实对局，自动判定预测误差 < 视口宽 2%、输入突变后 500ms 收敛、
  互吃在「被吃方 / 旁观端 / 吃球方」三处一致、每端带宽 < 10KB/s、快照 ≥15Hz，
  外加断线重连四条（细胞留在宽限期 / 认领回同一 ownerId / cid 不变 / 到期移除并广播 left），
  不合格 exit 1。
  **改协议、预测/对账、插值、AOI 之后必须跑它**——这条路径此前只在 LAN 直连（≈0ms）手测过一次，
  0 毫秒下所有网络问题都不存在。
  写这类仿真时踩过的坑（都在脚本注释里，别退回去）：
  ① 摆位/改状态后**轮询等客户端确认**再取值，固定等待读到的是陈旧值，断言会随机挂；
  ② 断言自己那端的球时，位置要取 `referenceSample`（服务端权威值），**不能取 `cell.x`**——
     那是本地预测值，每帧都在动，"到位没"永远等不到；
  ③ 半径只能用相对容差（球在持续吃食物长大），**而且只卡下界**：摆完位的球是静止的，
     r=15 吃几秒就长到 19，半径单调增长——上界卡紧等于"永远等不到"，这条断言会在
     食物多的布局下必挂，看起来还像"服务端没生效"；
  ④ 让整场确定化靠**给所有端挂护盾**：`resolveEatings` 只在受害者侧查 `isProtected`，
     所以挂护盾的球死不了、却照样吃得掉人；不这么做就会随机有人被 AI 吃掉、摆位变 no-op；
  ⑤ 收尾的 exit code 要从 judge 的结果数组派生，另写一份条件会出现"打了 ✗ 却说全部通过"。
  ⑥ **每条断言的口径都要与"这段时间里还会发生什么"相容**：增量类断言（上界）会把
     路过被顺带吃掉的其他球、以及球站着吃到的食物一起算进来（实测吃球方增量在
     +85 ~ +267 之间跳，取决于 AI 路过没路过与那几秒的食物密度）。写死上界就是在赌这些。
     只卡下界（服务端有没有执行 absorb）并把 kills 打出来，精确算式交给单测。
  ⑦ **稳态指标只在"全员在线"那段窗口里量**：断线重连阶段有一端是断的、还有一个只活了 1.5s
     的重连端，把它们算进平均值就是拿"没收到包"去稀释指标，量出 12.7Hz 然后去查一个没坏的问题。
  ⑧ **收到事件 ≠ 视图已更新**：服务端先广播 `left` 再发下一帧快照，客户端隔一帧（50ms + 单向延迟）
     才把组从视图里剔掉。断言"已移除"要等**视图真的消失**，事件一到就读必然读到旧状态。
- 调仿真参数一律用 **flag**，别用位置参数：`scripts/args.js` 会在 flag 的值和位置参数
  撞值时直接报错（旧的解析器会静默串位，把 `escapeFoodWeight` 赋成 90，整组数据作废）。
- 调手感参数前先读 [docs/tuning.md](docs/tuning.md)：里面有公式、当前值、实测数据与验收口径
  （改速度要连带看 AI 探测距离、改食物要考虑 AI 一起变快、"大球追不上"要用仿真扫描而不是看公式）。
  仿真脚本都支持命令行覆盖，可先试值再决定改代码。