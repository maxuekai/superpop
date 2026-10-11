---
name: superpop-browser-test
description: |
  在真实浏览器里实测 superpop（http://localhost:3000）的套路与坑：起服、?debug=1 钩子、
  状态断言用 evaluate 读 __game、需要推进世界时的虚拟时钟泵帧、截图前必须保持真实 RAF。
  触发：要验证玩法/视觉/交互在浏览器里的实际表现、要截图看观感、要自动化跑通一局对局、
  或者浏览器测试出现"页面不动/画面全黑/按钮点不动/状态莫名重置"。
  这些坑每个都实测踩过至少一次，排查成本半小时起。
---

# 浏览器实测 superpop 的套路与坑

单测和仿真跑不出观感与交互问题；要下"看起来对/手感对"的结论，只有真实浏览器。
本 skill 是流程与环境坑的沉淀，游戏数值口径仍在 docs/tuning.md。

## 0. 起服与入口

```bash
npm run dev    # http://localhost:3000；EADDRINUSE = 已有 server 在跑，直接用
```

打开 `http://localhost:3000/?debug=1`。debug 模式做三件事：挂运行日志面板、暴露
`window.__game`（测试钩子）、`window.__superpopLog`（日志文本）。

**读状态一律 evaluate 读 `__game`**（state/time/foodList/camera…），比截图便宜且精确；
截图只在要看观感时用。`__game` 是为后台标签页准备的——见下。

## 1. 坑：点「开始游戏」卡住（Playwright 可操作性检查超时）

`getByRole('button', { name: '开始游戏' }).click()` 偶发永久超时，元素明明可见可点。
不要重试同一个 locator，直接换合成点击：

```js
document.querySelector('.start-btn').click();
```

## 2. 坑：后台/遮挡标签页的 RAF 冻结（世界不跑）

内置浏览器标签页被遮挡/切后台时 `requestAnimationFrame` 被节流到不触发：世界时间不走、
AI 不长、挂机等 10 秒后 `g.time` 纹丝不动。**判别方法就是看 time 有没有走**。

⚠ 联机页面有个假象：`g.net.world.time` 由**快照事件**驱动（socket 异步），不走 RAF 也在涨——
别用它判断 RAF 死活；要看 `g.scale` 这类只在 update() 里变化的量，或直接数一秒内 rAF 回调数
（实测面板整体失焦时是 0 帧/秒，连"激活标签页"都救不回来，只能泵帧）。

需要推进世界时用虚拟时钟泵帧（在页面里执行）：

```js
if (!window.__stepFrames) {
    let rafCb = null;
    window.requestAnimationFrame = (cb) => { rafCb = cb; return 0; };
    let vNow = performance.now();
    window.__stepFrames = (n) => {
        for (let i = 0; i < n; i += 1) { vNow += 1000 / 60; if (rafCb) rafCb(vNow); }
    };
}
window.__game.loop(performance.now());   // ⚠ 必须先手动跑一帧复活循环
window.__stepFrames(1800);               // 之后才有回调可泵；1800 帧 = 30s
```

**漏掉 `g.loop()` 这一步泵帧就是空转**（挂起的帧已被取消，链条断了）。
这个坑值得单独立牌：装泵和复活**必须同一次 evaluate 里连续做**，只装泵不复活 =
整个测试窗口全程空转（实测连踩两次，症状是"世界冻住但没有任何报错"）。

## 2.5 坑：联机页面的 socket 会在长会话里"半死"

面板失焦几分钟后，页面的 socket 会变成半开状态：**上行还在发（服务端收得到输入），
下行快照流却停了**——客户端世界冻在旧快照，服务端照常跑。症状：服务端 dbg 显示
球在长大，客户端读数永远不变；客户端 state 也停在旧值。

对策：**长流程验收不要跨分钟复用同一个页面会话**。reload 页面拿全新 socket，
在 ~30 秒窗口内一口气跑完 join → 操作 → 断言（实测这个窗口内是稳定的）。
判断 socket 半死：服务端 dbg/日志还在动、客户端 `world.time` 不动，就是它。

另外：挂机测试用的服务器世界会**成熟成怪物世界**（AI 7 分钟能长到 r=300+，
100kg 的测试球进场即死）。测玩家成长/分裂前先重启服务器，并在开局几分钟内跑完。

## 3. 坑（最贵）：RAF 补丁会永久杀死页面渲染

第 2 节的补丁把回调存在**创建它的内核闭包**里——那个 JS 内核销毁后（每次工具调用都是
新内核），页面的帧循环就永久断了：canvas 再也不出新帧，而 DOM（HUD/日志面板）靠
interval 还在动，**看起来页面活着，其实渲染已死**。症状：截图全黑/全是旧画面，但
`__game` 状态完全正常。

**规矩：要截图、要看渲染效果，就别打 RAF 补丁。** 让真实 RAF 跑：保持浏览器面板前台
（visibility capability `set(true)`），等一拍（~1s）再截。泵帧只用于逻辑推进
（吃食物、死亡流程、数值断言），逻辑推进完要截图就重载页面来一次真实 RAF 的流程。

## 4. 坑：页面会被环境随机重载（状态全丢）

内置浏览器的标签页偶尔被整个重载：`__game` 换了新对象、world time 归零、state 回 menu。
**判别**：`time ≈ 0`、`state === 'menu'`、日志面板条目清空。对策：关键断言放在**同一次
evaluate 里完成**，别把"操作 → 等待 → 断言"拆在多次调用之间；发现被重载就重跑该段流程，
别把新页面的初始态当成游戏 bug。

## 5. 坑：截图拿到合成器旧帧

即使一切正常，截图偶尔是上一次的旧帧（合成器还没出新图）。重截一次基本就好；
配合第 3 节保持前台可大幅降低概率。

## 6. 收尾

- 关掉自己开的标签页（标签页会活到宿主进程退出）。
- 停 dev server 注意：杀 npm 包装进程**不会**带走 node 子进程（端口继续被占），
  用 `netstat -ano | grep :3000 | grep LISTENING` 找 PID，`taskkill //PID <pid> //F`。

## 7. 判断优先级

状态/数值断言（evaluate 读 `__game`） > 合成事件驱动（WheelEvent/KeyboardEvent/
TouchEvent 都可 `dispatchEvent`，触摸用 `new Touch()` + `new TouchEvent()`）> 截图看观感。
每轮实测同时挂 `window.addEventListener('error', …)` 收集 JS 报错，作为零报错验收的依据。
