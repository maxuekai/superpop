# AGENTS.md

本文件面向人和 AI 编码助手：说明这个仓库是什么、怎么跑、代码怎么组织。改动仓库结构或命令时，请同步更新本文件和 [TODO.md](TODO.md)。

## 项目简介

superpop —— "球球大作战"网页版（Agar.io-like 网页游戏）。玩家控制一个小球在地图里移动，吃食物变大。

当前状态：**单机可玩**（手机浏览器扫码即玩：摇杆移动、吃食物长大、体重实时显示）。联机、玩家互吃、分裂等能力未实现，清单见 [TODO.md](TODO.md)。

## 运行

| 命令 | 作用 | 依赖 |
|---|---|---|
| `npm run dev` | 静态服务器，http://localhost:3000；启动时打印局域网 URL、生成 `qr.png` 二维码图片并自动打开（IP 未变化时不重复弹窗），终端另有一份字符二维码兜底 | 无（二维码需可选的 devDependency `qrcode`，没装则只打印 URL） |
| `npm run server` | 多人联机服务端（express + socket.io） | 需先 `npm install` |
| `npm test` | smoke 检查：对所有 js 跑 `node --check` | 无 |

客户端是**原生 ES modules**，没有构建步骤。`server/dev-server.js` 只是开发预览用；联机服务端在 `server/index.js`。手机游玩：连同一 Wi-Fi，扫启动日志里的二维码（或浏览器输 `http://<电脑IP>:3000`）。

## Node.js 环境

- 用 [fnm](https://github.com/Schniz/fnm) 管理 Node 版本（本机未开开发者模式、无管理员权限，nvm-windows 的符号链接不可用，故选 fnm）。
- 版本约定见 `.nvmrc`（当前 `24`）；装了 fnm 的 shell 里 `cd` 进仓库会自动切换，或手动 `fnm install` / `fnm use`。
- 国内网络下已配置 `FNM_NODE_DIST_MIRROR=https://registry.npmmirror.com/-/binary/node`（用户级环境变量），`fnm install --lts` 也走镜像。
- Windows PowerShell 5.1 用户注意：profile 里必须先 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` 再 eval `fnm env`，否则中文路径下解码错误（本仓库 profile 已配好，勿删）。

## 目录结构

```
├── index.html              # 页面：canvas + 体重面板 + 摇杆
├── src/
│   ├── main.js             # 入口：启动 Game + Joystick，监听 resize/orientationchange
│   ├── config.js           # 全部常量（世界/视野缩放/食物/玩家/摇杆/颜色）
│   ├── core/
│   │   ├── game.js         # 游戏主循环：自适应渲染、吃食物与重生、体重面板
│   │   ├── camera.js       # 死区跟随相机，视口钳制在世界内，支持视口尺寸变化
│   │   ├── player.js       # 玩家小球：移动、边界钳制、绘制、canEat
│   │   ├── map.js          # 地图：背景图只烤一次，按视口裁剪
│   │   ├── rectangle.js    # 矩形工具：within / overlaps
│   │   └── utils.js        # 数学小函数
│   ├── input/
│   │   └── joystick.js     # 虚拟摇杆（touch 事件，面板任意位置按下即可拖）
│   ├── net/
│   │   └── client.js       # 联机客户端占位（未实现）
│   └── styles/             # reset.css + index.css
├── server/
│   ├── dev-server.js       # 静态服务器（npm run dev，打印局域网 URL + 二维码）
│   └── index.js            # 联机服务端（npm run server，未接通）
├── scripts/
│   └── check.js            # smoke 检查（npm test）
```

（旧版引用的背景图 `assets/img/bg.jpg` 已移除：网格背景改为程序生成，见 `src/core/map.js`。）

## 约定

- 纯原生 ES modules，无打包器、无转译；浏览器直接加载。新增代码沿用 `import/export`。
- 4 空格缩进、JS 单引号（见 `.editorconfig`）。
- 用户界面文案用中文，代码标识符用英文。
- 服务端与客户端的事件名约定：`registe` / `create` / `enter` / `update`（改动需两端同步）。
- 保持行为等价优先：修 bug / 加功能前先看 TODO.md 对应条目，避免顺手改出与记录不符的行为。

## 关键行为（重构时勿意外改变）

- 世界固定 1024×768；画布/视口随窗口变化，缩放规则见 `config.js` 的 `VIEW`：屏幕长边锚定 `VIEW.longEdgeWorld` 个世界单位，但不小于"窗口装下整个世界"的缩放（视口永不超过世界，否则相机钳制出负坐标）。
- 渲染按 `devicePixelRatio` 缩放，`Game.draw` 每帧 `setTransform` 后平移到相机视口，Map/Player 直接用世界坐标绘制。
- 每帧移动量 = speedX / 60（`PLAYER.speedDivisor`）；摇杆直接写 `player.speedX/speedY`，松手（touchend）归零。
- 食物不烤进地图：背景只生成一次，食物每帧按视口动态绘制；吃掉一颗立即重生一颗（总量恒定 `FOOD.count`），每颗 `player.r += 0.5`。
- 体重面板 = r² 取整（初始 r=10 → 100kg），吃食物时更新。
- 玩家越界钳制：圆心离边缘至少一个 `r`（原 `r/2` 为 bug，已修）。
- 摇杆只有 touch 事件（面板 140px 内任意位置按下即可拖动，不要求按中摇杆头），桌面鼠标不可用（TODO.md「输入」）。
