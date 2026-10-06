# TODO.md

superpop 半成品待办清单。重构（`refactor/modernize` 分支）已把代码改为现代 ES modules 结构，但**功能仍是单机 demo**，以下能力均未实现。

## 联机（优先级最高）

- [ ] 接通客户端 `src/net/client.js`：实现 socket.io 连接，事件名与服务端 `server/index.js` 对齐（`registe` / `create` / `enter` / `update`）
- [ ] 客户端用 Map 管理所有远程玩家（旧代码只有一个 `anotherball` 变量，只支持一个对手）
- [ ] 远程玩家位置插值平滑，避免抖动
- [ ] 断线清理：服务端在 `disconnect` 里广播玩家离开，客户端移除对应小球
- [x] 验证 `npm install && npm run server` 在当前依赖版本（express ^4.19 / socket.io ^4.7）下可用

## 玩法

- [ ] 玩家互吃：按半径判定，大球吃小球，被吃者死亡
- [ ] 死亡 / 重生流程（含结算与重新加入）
- [ ] 分裂：实现时需把 `.division` 按钮加回页面（UI 已于 2026-10 移除，样式与结构见 git 历史，用户老误按）
- [ ] 吐球 / 喷射（原作的孢子机制）
- [x] 移动速度随体型增大而降低（速度分母 = speedDivisor + 超出初始半径部分 × slowdownPerRadius）

## 世界与规则

- [x] 食物吃掉后重生，保持场上食物总量；重生位置避开玩家（不刷脸）
- [x] 修复玩家越界钳制 bug：`Player.update` 原来用 `r/2`，已改为 `r`（画圆时 r 是半径）
- [x] 视野随**体型**缩放（VIEW.zoomExponent，越大看得越远，视口不超过世界）
- [x] 玩家出生位置随机（带边距）且避开食物；联机时再考虑避开其他玩家
- [ ] 真机验证：手机扫码游玩，确认摇杆手感与渲染清晰度

## UI

- [x] 体重面板接入真实数据（体重 = r² 取整，初始 r=10 → 100kg）
- [ ] 排行榜
- [ ] 起名 / 注册界面（旧代码的 `prompt` 已删）
- [ ] 游戏结束 / 结算界面

## 输入与适配

- [ ] 桌面鼠标支持（摇杆只注册了 touch 事件；触屏手感已适配，见 AGENTS.md）
- [x] canvas 随窗口 / 设备自适应（含 devicePixelRatio 高清渲染）
- [x] 触屏细节：页面禁滚动/橡皮筋，摇杆与按钮 `touch-action: none`
- [ ] 键盘操作支持（方向键 / WASD）

## 服务端

- [ ] 权威校验：位置、吃食物、互吃都由服务端裁定，客户端只发输入
- [ ] 真正的房间管理（现在是写死的 `room1`，`enter` 还错误地用全局广播代替房间内广播）
- [ ] 食物状态由服务端生成并同步给所有客户端
- [ ] 服务端对 `update` 做频率限制，防刷

## 性能

- [x] 吃食物不再 `Map.generate()` 全图重绘 + `toDataURL()`：背景只烤一次，食物每帧按视口动态绘制

## 工程

- [x] 确认 `server/index.js` 里 `res.sendFile` 的路径写法在 Windows / Linux 都正确（已改用 `fileURLToPath` 转换并实测通过）
- [x] 最小化 smoke 检查：`npm test` 对所有 js 跑 `node --check`
- [ ] CI（可选）
