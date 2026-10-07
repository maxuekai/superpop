# AGENTS.md

本文件面向人和 AI 编码助手：说明这个仓库是什么、怎么跑、代码怎么组织。改动仓库结构或命令时，请同步更新本文件和 [TODO.md](TODO.md)。

## 项目简介

superpop —— "球球大作战"网页版（Agar.io-like 网页游戏）。玩家控制一个小球在地图里移动，吃食物变大。

当前状态：**单机可玩 + AI 对手 + 互吃/死亡/重生 + 排行榜**（手机浏览器扫码即玩）。联机、玩家互吃以外的玩法（分裂/吐球）未实现，清单见 [TODO.md](TODO.md)。

## 运行

| 命令 | 作用 | 依赖 |
|---|---|---|
| `npm run dev` | 静态服务器，http://localhost:3000；启动时打印局域网 URL、生成 `qr.png` 二维码图片并自动打开（IP 未变化时不重复弹窗），终端另有一份字符二维码兜底。只放行 `/`、`/index.html`、`/src/**`、`/qr.png` | 无（二维码需可选的 devDependency `qrcode`，没装则只打印 URL） |
| `npm run server` | 多人联机服务端（express + socket.io） | 需先 `npm install` |
| `npm test` | `node --check` 全量语法检查 + `scripts/rules-test.js` 玩法规则检查（无 DOM，直接在 node 里跑） | 无 |
| `npm run sim` | AI 逃跑能力仿真：模拟满舵猎手直线追击 20 轮，输出存活时间/被吃轮数/被逼墙比例（固定随机种子，可复现）。`npm run sim -- --sweep` 扫猎手半径，看"大球到底能不能追上"；`--hunter 30 --prey 15 --nofood` 可指定体型并关掉"猎物边逃边长大"这个因素。调 `AI` 难度参数前先跑它 | 无 |
| `npm run sim:food` | 食物密度与成长仿真：输出间距/最近食物距离/屏内数量/命中概率，并让玩家球与 AI 球各觅食 30 秒对比成长。调 `FOOD` / `growthPerFood` / `foodGain` 前先跑它 | 无 |

客户端是**原生 ES modules**，没有构建步骤。`server/dev-server.js` 只是开发预览用；联机服务端在 `server/index.js`。手机游玩：连同一 Wi-Fi，扫启动日志里的二维码（或浏览器输 `http://<电脑IP>:3000`）。

## Node.js 环境

- 用 [fnm](https://github.com/Schniz/fnm) 管理 Node 版本（本机未开开发者模式、无管理员权限，nvm-windows 的符号链接不可用，故选 fnm）。
- 版本约定见 `.nvmrc`（当前 `24`）；装了 fnm 的 shell 里 `cd` 进仓库会自动切换，或手动 `fnm install` / `fnm use`。
- 国内网络下已配置 `FNM_NODE_DIST_MIRROR=https://registry.npmmirror.com/-/binary/node`（用户级环境变量），`fnm install --lts` 也走镜像。
- Windows PowerShell 5.1 用户注意：profile 里必须先 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` 再 eval `fnm env`，否则中文路径下解码错误（本仓库 profile 已配好，勿删）。
- 非交互 shell（本仓库的自动化检查）里 `npm` 不在 PATH 上时，先把 `%APPDATA%\fnm\node-versions\v24.x\installation` 加进 PATH 再跑 `npm test`。

## 目录结构

```
├── index.html              # 页面：canvas + 体重面板 + 排行榜 + 摇杆 + 开局/结算弹层
├── src/
│   ├── main.js             # 入口：启动 Game + Joystick + Hud，监听 resize/orientationchange
│   ├── config.js           # 全部常量（世界/步长/视野/食物/玩家/互吃/AI/摇杆/HUD/出生点）
│   ├── core/
│   │   ├── game.js         # 主循环（固定步长）、AI 生成与重生、排行榜调度、渲染
│   │   ├── ball.js         # 球的基类：移动、钳制、弹簧回弹、绘制、进食与互吃判定、出生保护
│   │   ├── rules.js        # 纯裁定层：互吃结算、吃食物、名次/排行榜、AI 数量目标与重生到期
│   │   ├── player.js       # 玩家球（继承 Ball，出生状态）
│   │   ├── ai.js           # AI 球（继承 Ball，加决策：逃离/追击/觅食/游走/避边界）
│   │   ├── camera.js       # 死区跟随相机，视口钳制在世界内，支持 snapTo / 视口尺寸变化
│   │   ├── map.js          # 地图：背景图只烤一次，按视口裁剪
│   │   ├── rectangle.js    # 矩形工具：within / overlaps
│   │   └── utils.js        # 数学小函数、随机、clamp、clusterOffset、formatTime、颜色明暗
│   ├── input/
│   │   ├── joystick.js     # 浮动虚拟摇杆（touch 事件，按住屏幕任意位置出现）
│   │   └── keyboard.js     # 键盘操控（WASD / 方向键；事件目标由构造传入，便于单测）
│   ├── net/
│   │   └── client.js       # 联机客户端占位（未实现）
│   ├── ui/
│   │   └── hud.js          # DOM 层：体重面板、排行榜、开局/结算弹层
│   └── styles/             # reset.css + index.css
├── server/
│   ├── dev-server.js       # 静态服务器（npm run dev，打印局域网 URL + 二维码）
│   └── index.js            # 联机服务端（npm run server，未接通）
├── scripts/
│   ├── check.js            # 语法 smoke 检查
│   ├── rules-test.js       # 玩法规则检查（吃/互吃/AI 决策/出生保护），无 DOM
│   ├── flee-sim.js         # AI 逃跑能力仿真（npm run sim），调 AI 参数用
│   └── food-sim.js        # 食物密度/成长仿真（npm run sim:food），调 FOOD 用
```

（旧版引用的背景图 `assets/img/bg.jpg` 已移除：网格背景改为程序生成，见 `src/core/map.js`。）

## 约定

- 纯原生 ES modules，无打包器、无转译；浏览器直接加载。新增代码沿用 `import/export`。
- 4 空格缩进、JS 单引号、LF 换行（见 `.editorconfig`）。
- 用户界面文案用中文，代码标识符用英文。
- 服务端与客户端的事件名约定：`registe` / `create` / `enter` / `update`（改动需两端同步）。
- **玩法逻辑只放在 `core/` 的纯逻辑类里**（不碰 `document`），这样 `scripts/rules-test.js` 才能在 node 里直接测；`ui/hud.js` 只做 DOM 读写。
- 保持行为等价优先：修 bug / 加功能前先看 TODO.md 对应条目，避免顺手改出与记录不符的行为。

## 关键行为（重构时勿意外改变）

- **固定步长**：`Game.loop` 用累加器按 `TICK.fps`(60) 推进逻辑，每帧上限 `TICK.maxSteps` 步，追不上就丢积压；渲染跟随屏幕刷新率。`Ball.update(dt)` 里的位移与弹簧都乘 `dt * PLAYER.speedUnit`（60），保证 120Hz 手机和 60Hz 桌面手感一致（120Hz 时代码是每帧算位移，会快一倍）。
- 游戏状态机：`menu`（开局界面）→ `playing` → `dead`（结算界面）。只有 `playing` 才跑 `updateWorld`，弹层期间世界冻结。
- 世界固定 1024×768；画布/视口随窗口变化，缩放规则见 `config.js` 的 `VIEW`：屏幕长边锚定 `VIEW.longEdgeWorld` 个世界单位，并按 `(r/初始半径)^VIEW.zoomExponent` 随体型放大视距，但不小于"窗口装下整个世界"的缩放（视口永不超过世界，否则相机钳制出负坐标）。相机是死区跟随（死区 = 半视口），靠边时视口会被钳在世界内，所以玩家在地图边缘时不会位于屏幕正中——这是既有设计。
- 渲染按 `devicePixelRatio` 缩放，`Game.draw` 每帧 `setTransform` 后平移到相机视口，Map/Player 直接用世界坐标绘制。
- 每步位移 = speedX / (speedDivisor + 超出初始半径部分 × slowdownPerRadius) × (dt × speedUnit)，越大越慢；摇杆/键盘直接写 `game.input`（未满舵时线性变速，手指位移小于 `JOYSTICK.deadZone` 不动球），松手（touchend）归零。
- **"大球追不上"不要看速度公式下结论**：小体型段真正的门槛是互吃比例（`r > 对方r × 1.15`，差一点点就永远吃不到）；而速度只是一阶估算——实测猎手比猎物慢 40%（r=50 vs r=10：38.9 vs 64.4 单位/秒）仍能抓到 16/20，因为逃命 AI 达不到理论速度、有界地图躲不了角落、还会边逃边长大。`npm run sim -- --sweep` 是这条的验收口径。
- 质量口径统一为 `r²`。玩家可以有**多个分身**（见下），体重面板与排行榜都按「整组质量之和」统计；
  单个球的吃食物收益 `r += 球自己的 foodGain`；互吃按 `EAT.ratio`(1.15) 的半径比判定，
  `r = sqrt(r² + 对方r² × EAT.absorb)`。
- **分裂**（`SPLIT` 常量 + `rules.splitCells`）：长到 `minCellRadius` 才能分；`requestSplit()` 把够大的
  细胞一切两半（原来的球自己变成一半、另一半是新球，**质量守恒**），冷却 8 秒、最多 8 个分身。
  分开方向是**移动方向的垂直方向**，不挡去路。分身靠拢到 `(r1+r2)×mergeFactor` 且过了
  `mergeCooldown` 会自动合并（`rules.mergeCells`）。同一 `ownerId` 的分身之间**不能互吃**
  （`Ball.canEatBall` 第一条就排除同 owner）；分身被吃只损失那份质量，**全部吃光才判死亡**。
  镜头与视野缩放跟随「整组里最大的分身」，所以分裂时视野不会跳。
- **输入层是 `game.input = { speedX, speedY }`**，摇杆和键盘都写它，再由 `updateWorld` 同步给
  每一个分身（分身不是一个球，共用同一个球对象的话输入只会作用在其中一个上）。
- **一帧内的玩法裁定集中在 `core/rules.js`**（纯函数、不碰 DOM）：`resolveEatings` 先按帧初状态把所有「谁吃谁」配对算完、**已被吃掉的球不再作为吃人方**（否则链式互吞会让同一局重放结果随数组顺序变化），再统一结算质量；`resolveFoodEating` 结算吃食物并即时补位；`rankOf`/`leaderboardEntries`/`targetAiCount`/`excessToRemove`/`dueRespawns`/`isSpawnClear` 同理。`Game` 只负责准备数据、调用、处理结果与渲染——**新增玩法规则优先写进 rules.js，才能被单测覆盖**。
- **食物不烤进地图**：背景只生成一次，食物每帧按视口动态绘制，并**按颜色合批**（`Game.drawFood` 把同色食物合并成一条路径；逐颗 fill 在 360 颗时会有上千次绘制调用）。吃掉一颗立即在别处补一颗（总量恒定 `FOOD.count`），生成位置避开所有存活球；吃到时给视觉半径一次弹簧回弹（见 `ball.js` 的 `displayR/rVel`）。
- **食物成簇生成**：不是均匀散点，而是先找一个避开球的簇心、再让每颗落在 `clusterRadius` 内（`utils.clusterOffset`）。散点太难点——单颗食物在手机上只有 4~7 css px 直径，散开时基本是「擦身而过」；成簇后能看见一片、一把扫过去。
- 食物收益按球区分：玩家 `PLAYER.growthPerFood`(0.5)，AI `AI.foodGain`(0.3)。食物变多后 AI 也吃得更快，用 `foodGain` 把它们的成长按回来——实测玩家 30 秒 100→2300kg 而 AI 仍 100→1040kg。
- AI（`AI` 常量 + `AiPlayer`）：决策优先级为**逃离比自己大的球 > 追击比自己小的球 > 最近的食物 > 随机游走**，决策每 `thinkInterval` 重选、转向每步算，另加边界躲避。数量在 `minCount`(6) ~ `count`(12) 之间随玩家体型调整（每 `syncInterval` 秒校准一次；**开局只放 `targetAiCount()` 个**，不放满，否则开局容易被围）；被吃后 `respawnDelay` 重生，出生半径在 `[0.8, 2.2] × 初始半径` 且不超过玩家当前半径 × `spawnRadiusRatio`（避免开局满屏大佬）。
- **AI 逃跑不是沿「远离威胁」直线跑**（那会被一路逼到墙角撞死）：`escapeDirection` 从 `escapeSamples` 个均分方向里探测 `escapeProbe` 距离打分——离威胁更远加分、贴墙扣分（越近扣越狠）、撞向别的球扣分，取最优；`escapePhase` 是每个 AI 独立的随机相位，重新决策时按 `escapeChange` 概率换一侧，于是不同 AI 走位不同、贴墙时会自动改走斜线。改这组参数前先跑 `npm run sim`。
- `fleeRange` 是手感关键：太大则 AI 一看见玩家就全程逃跑、永远抓不到；太小则 AI 懒得躲。当前 160（比"一看到你就跑"的 320 更耐追）。追击时按 `chaseLead` 瞄猎物前方，而不是死盯当前坐标。
- **AI 逃跑时会顺手吃路边的食物**：逃命途中仍会找 `escapeFoodRange`(90) 内最近的一颗食物，在方向打分里减去「探针到食物的距离 × escapeFoodWeight」。权重必须远小于威胁/贴墙项——实测 0.25 会把被逼墙比例从 1.3% 拉到 8.7%（为了吃一口把自己送回墙角），当前取 0.1。
- 出生点（玩家和 AI 都用 `Game.safeSpawnPosition`）：避开所有存活球，并留出 `SPAWN.edgeGap` 远离世界边缘。
- 出生保护：开局/重生后 `PLAYER.spawnShield`(2.5s)、AI 重生后 `AI.respawnShield`(1.5s) 内吃不掉，`Ball.shielded` 为真时画一圈光环；保护时间从真正 `begin()`/`respawnPlayer()` 那一刻起算（菜单界面世界时间也在走）。
- 摇杆是浮动模式（touch 事件）：按住屏幕任意位置，面板在该处出现，拖动控制方向，松手消失且球停；多指只认第一根手指。`.ui-interactive` 元素（开局/结算弹层、输入框、按钮）上的触摸不接管也不 preventDefault，否则按钮点不动。
- 键盘（`KEYS` + `Keyboard`）：WASD/方向键，写法和摇杆一样（往 `input.speedX/speedY` 写「摇杆像素量」，力度取 `KEYS.power`=摇杆满舵），斜向自动归一化。`ACTIONS` 里的动作键（`Space`=分裂）走 `onAction` 回调，不污染方向集合。三条约束：① 摇杆正在操控时键盘让位（`main.js` 传 `isBlocked: () => joystick.isActive`）；② 事件 target 命中 `KEYS.ignoreTarget`（输入框/弹层）时不响应也不 preventDefault，否则昵称会输成 WASD；③ `blur` 与 `visibilitychange`（切后台）时清空按键，防止 keyup 丢失后"卡住一直走"。

## 测试

`npm test` 分两段：`scripts/check.js` 对 `src/`、`server/`、`scripts/` 下所有 `.js` 跑 `node --check`；`scripts/rules-test.js` 断言玩法规则，覆盖五组：① 球的规则（吃食物判定、互吃阈值、质量吸收、dt 比例、越界钳制、出生保护）；② AI 决策（追击/逃离/贴墙斜逃/觅食/避边界/速度上限、边界吃食物）；③ 输入（键盘 7 条：方向映射、斜向归一化、多键、输入框隔离、摇杆让位、失焦清键；摇杆 6 条：拖动方向、边缘限幅、死区、松手归零、多指不抢控、界面元素不接管）；④ 整局裁定（`rules.js`：互吃结算与不链式、吃食物补位、名次/排行榜、AI 数量校准、重生到期、出生点安全）；⑤ 分裂/合并（质量守恒、太小不能分、垂直于移动方向分开、同 owner 不互吃、可分条件、合并与合并冷却）。**改动 `src/core/` 下任何玩法逻辑或 `src/config.js` 的数值后必须跑一次；`Game` 本身因依赖 canvas 无法直接测，所以它的行为靠上面的仿真脚本回归。**

调 AI 手感参数（`fleeRange`、`escape*`）时用 `npm run sim`：它用固定随机种子跑 20 轮「猎手满舵直线追击」，输出存活时间/被吃轮数/被逼墙比例，结果可复现。也可以 `npm run sim -- 120` 这样临时覆盖 `fleeRange` 来对比数值。