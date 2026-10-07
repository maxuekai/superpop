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
- **状态机**：`menu` → `playing` → `dead`。只有 `playing` 跑 `updateWorld`，弹层期间世界冻结。
- **输入层是 `game.input`**，摇杆与键盘都写它，再由 `updateWorld` 同步给每一个分身——
  分身不是一个球，直接共享球对象的话输入只会作用在其中一个上。
- 渲染按 `devicePixelRatio` 缩放后平移到相机视口；食物**不烤进地图**，每帧按视口动态绘制并**按颜色合批**。

**玩法类**

- **质量口径统一为 `r²`**；体重面板与排行榜按「玩家整组分身质量之和」统计。
- **互吃**：尺寸比 > `EAT.ratio`(1.15) 且对方圆心进入自己体内，质量 `r = sqrt(r² + 对方r² × absorb)`。
- **一帧内先配对再结算**：`resolveEatings` 按帧初状态配对，**已被吃掉的球不再作为吃人方**——
  否则「A 吃 B、B 吃 C」的结果会依赖数组顺序，同一局重放结果就变了。
- **分裂**：够大的细胞一切两半，**质量守恒**（原球自己变成一半）、分开方向垂直于移动方向、冷却防连点、
  靠拢自动合并；**同一 ownerId 的分身之间不能互吃**，分身被吃只损失那份质量，**全灭才判死亡**。
  镜头与视野跟随最大的分身，所以分裂时视野不跳。
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