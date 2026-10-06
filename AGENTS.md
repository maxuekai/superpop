# AGENTS.md

本文件面向人和 AI 编码助手：说明这个仓库是什么、怎么跑、代码怎么组织。改动仓库结构或命令时，请同步更新本文件和 [TODO.md](TODO.md)。

## 项目简介

superpop —— "球球大作战"网页版（Agar.io-like 网页游戏）。玩家控制一个小球在地图里移动，吃食物变大。

当前状态：**单机 demo**。核心循环（移动 / 相机跟随 / 吃食物变大）可用；联机、玩家互吃、分裂等能力均未实现，清单见 [TODO.md](TODO.md)。

## 运行

| 命令 | 作用 | 依赖 |
|---|---|---|
| `npm run dev` | 零依赖静态服务器，http://localhost:3000 | 无，可直接运行 |
| `npm run server` | 多人联机服务端（express + socket.io） | 需先 `npm install` |

客户端是**原生 ES modules**，没有构建步骤。`server/dev-server.js` 只是开发预览用；联机服务端在 `server/index.js`。

## Node.js 环境

- 用 [fnm](https://github.com/Schniz/fnm) 管理 Node 版本（本机未开开发者模式、无管理员权限，nvm-windows 的符号链接不可用，故选 fnm）。
- 版本约定见 `.nvmrc`（当前 `24`）；装了 fnm 的 shell 里 `cd` 进仓库会自动切换，或手动 `fnm install` / `fnm use`。
- 国内网络下已配置 `FNM_NODE_DIST_MIRROR=https://registry.npmmirror.com/-/binary/node`（用户级环境变量），`fnm install --lts` 也走镜像。
- Windows PowerShell 5.1 用户注意：profile 里必须先 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` 再 eval `fnm env`，否则中文路径下解码错误（本仓库 profile 已配好，勿删）。

## 目录结构

```
├── index.html              # 页面：canvas + 体重面板 + 摇杆 + 分裂按钮
├── src/
│   ├── main.js             # 入口：window load 后启动 Game + Joystick
│   ├── config.js           # 全部常量（世界/画布/食物/玩家/摇杆/颜色）
│   ├── core/
│   │   ├── game.js         # 游戏主循环：update + draw，吃食物逻辑
│   │   ├── camera.js       # 死区跟随相机，视口钳制在世界内
│   │   ├── player.js       # 玩家小球：移动、边界钳制、绘制、canEat
│   │   ├── map.js          # 地图：背景+食物烤成一张大图，按视口裁剪
│   │   ├── rectangle.js    # 矩形工具：within / overlaps
│   │   └── utils.js        # 数学小函数
│   ├── input/
│   │   └── joystick.js     # 虚拟摇杆（touch 事件）
│   ├── net/
│   │   └── client.js       # 联机客户端占位（未实现）
│   └── styles/             # reset.css + index.css
├── server/
│   ├── dev-server.js       # 零依赖静态服务器（npm run dev）
│   └── index.js            # 联机服务端（npm run server，未接通）
└── assets/img/bg.jpg       # 地图背景图
```

## 约定

- 纯原生 ES modules，无打包器、无转译；浏览器直接加载。新增代码沿用 `import/export`。
- 4 空格缩进、JS 单引号（见 `.editorconfig`）。
- 用户界面文案用中文，代码标识符用英文。
- 服务端与客户端的事件名约定：`registe` / `create` / `enter` / `update`（改动需两端同步）。
- 保持行为等价优先：修 bug / 加功能前先看 TODO.md 对应条目，避免顺手改出与记录不符的行为。

## 关键行为（重构时勿意外改变）

- 世界固定 1024×768，画布固定 667×375，不随窗口变化。
- 每帧移动量 = speedX / 60（`PLAYER.speedDivisor`）；摇杆直接写 `player.speedX/speedY`。
- 食物画进地图大图（`Map.generate`），每吃一颗重绘全图并 `r += 0.5`。
- 玩家越界钳制用的是 `r/2`（疑似 bug，见 TODO.md，重构未"顺手修复"）。
- 摇杆只有 touch 事件，桌面鼠标无法操作。
