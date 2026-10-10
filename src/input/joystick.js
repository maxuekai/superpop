import { JOYSTICK } from '../config.js';
import { distance, edgeOffsetX, edgeOffsetY } from '../core/utils.js';

// 浮动虚拟摇杆（touch 事件）：按住屏幕任意位置，摇杆面板出现在手指处，
// 拖动方向写入 player.speedX/speedY，松手摇杆消失、球停止。
// 不处理「界面元素」（.ui-interactive：开局/结算弹层、输入框、按钮）上的触摸，
// 否则 preventDefault 会把按钮点击和输入框聚焦一起吞掉。
// 多指：第一根非界面手指认作摇杆；第二根进入双指捏合缩放视野（onZoom 收到两指距离比），
// 捏合期间停摇杆（两指一起动时第一根的位移是噪声，不能当方向），捏合结束原地恢复。
// TODO: 只支持触屏，桌面鼠标不可用（见 TODO.md「输入」）
const UI_SELECTOR = '.ui-interactive';

export class Joystick {
    constructor(controlPanel, player, options = {}) {
        this.controlPanel = controlPanel;
        this.knob = controlPanel.querySelector('.direction-control');
        // 监听整个文档：屏幕上任何位置按下都能操控
        this.layer = controlPanel.ownerDocument;
        this.input = player;
        // 双指捏合的缩放回调（factor = 本次移动的两指距离比）；不传则捏合只停摇杆不缩放
        this.onZoom = options.onZoom || (() => {});

        // 正在操控的触摸点 identifier（多指只认第一根手指）
        this.touchId = null;
        this.originX = 0;
        this.originY = 0;
        this.diffX = 0;
        this.diffY = 0;
        // 双指捏合进行中：{ idA, idB, lastDist }，否则 null
        this.pinch = null;

        this.handleEvent = this.handleEvent.bind(this);
    }

    // 触摸是否落在界面元素上（这类触摸要留给界面自己处理）
    isUiTarget(target) {
        return Boolean(target && target.closest && target.closest(UI_SELECTOR));
    }

    // 当前是否正在用手指操控（键盘检测到就自动让位）
    get isActive() {
        return this.touchId !== null;
    }

    startPinch(first, second) {
        this.pinch = {
            idA: first.identifier,
            idB: second.identifier,
            lastDist: distance(first.clientX, first.clientY, second.clientX, second.clientY),
        };
        // 捏合期间停摇杆：面板藏掉、方向清零（松开捏合后原地恢复，见 endPinch）
        this.controlPanel.style.display = 'none';
        this.input.speedX = 0;
        this.input.speedY = 0;
    }

    // 两指的最新距离比就是缩放系数：张开（dist 变大）= 拉近。用增量比而不是
    // 「相对捏合起点的比」，手势中途回拉时视野跟着回，不会一锤定音
    pinchMove(event) {
        const a = this.findTouch(event.touches, this.pinch.idA);
        const b = this.findTouch(event.touches, this.pinch.idB);
        if (!a || !b) {
            return;
        }
        const dist = distance(a.clientX, a.clientY, b.clientX, b.clientY);
        if (this.pinch.lastDist > 0 && dist > 0) {
            this.onZoom(dist / this.pinch.lastDist);
        }
        this.pinch.lastDist = dist;
    }

    // 捏合结束：摇杆那根手指还按着就原地恢复（重新锚定原点，别把抬指瞬间
    // 的位移当方向）；否则整个手势结束、球停
    endPinch(event) {
        this.pinch = null;
        const stillDown = this.findTouch(event.touches, this.touchId);
        if (stillDown) {
            this.originX = stillDown.clientX;
            this.originY = stillDown.clientY;
            this.diffX = 0;
            this.diffY = 0;
            this.knob.style.left = '50%';
            this.knob.style.top = '50%';
            this.controlPanel.style.display = 'block';
            this.controlPanel.style.left = `${this.originX - JOYSTICK.centerOffset}px`;
            this.controlPanel.style.top = `${this.originY - JOYSTICK.centerOffset}px`;
            this.input.speedX = 0;
            this.input.speedY = 0;
        } else {
            this.touchId = null;
            this.controlPanel.style.display = 'none';
            this.knob.style.left = '50%';
            this.knob.style.top = '50%';
            this.input.speedX = 0;
            this.input.speedY = 0;
        }
    }

    handleEvent(e) {
        const event = e || window.event;

        switch (event.type) {
            case 'touchstart':
                // 界面上的触摸不接管，也不阻止默认行为（按钮点击、输入框聚焦要留给界面）
                if (this.isUiTarget(event.target)) {
                    return;
                }
                // 捏合中：第三根及以上的手指全忽略
                if (this.pinch !== null) {
                    return;
                }
                // 已有操控中的手指 → 这次按下是非界面的第二根，进入捏合缩放
                if (this.touchId !== null) {
                    const second = event.changedTouches[0];
                    const first = this.findTouch(event.touches, this.touchId);
                    if (first) {
                        e.preventDefault();
                        this.startPinch(first, second);
                    }
                    return;
                }
                e.preventDefault();
                {
                    const touch = event.changedTouches[0];
                    this.touchId = touch.identifier;
                    this.originX = touch.clientX;
                    this.originY = touch.clientY;

                    // 摇杆面板以按下的位置为中心出现（贴边时允许被屏幕裁切）
                    this.controlPanel.style.display = 'block';
                    this.controlPanel.style.left = `${this.originX - JOYSTICK.centerOffset}px`;
                    this.controlPanel.style.top = `${this.originY - JOYSTICK.centerOffset}px`;
                    this.knob.style.left = '50%';
                    this.knob.style.top = '50%';
                }
                break;

            case 'touchmove':
                // 捏合中只跟两根捏合手指：其他手指（比如正在按按钮的第三根）不抢，
                // 也不 preventDefault，按钮的兼容性 click 才不会被吞掉
                if (this.pinch !== null) {
                    const moved = event.changedTouches[0];
                    if (moved.identifier === this.pinch.idA || moved.identifier === this.pinch.idB) {
                        e.preventDefault();
                        this.pinchMove(event);
                    }
                    return;
                }
                if (this.touchId === null) {
                    return;
                }
                // 判据是 changedTouches（本次真正移动了哪几根手指），不是 touches（当前按着的全部手指）：
                // 玩家一根手指拖着球走、第二根去按分裂按钮时，第二根的 touchmove 里
                // changedTouches 只有它自己，这里就直接返回、不 preventDefault，
                // 按钮的兼容性 click 才不会被吞掉（真机反馈："没法同时移动的时候按分裂"）。
                // 之前是无条件 preventDefault —— 只要第一根手指还按着，第二根在按钮上的滑动就被摇杆吃掉。
                {
                    const touch = this.findTouch(event.changedTouches, this.touchId);
                    if (!touch) {
                        return;
                    }
                    e.preventDefault();
                    // 手指相对按下原点的位置
                    const tempX = touch.clientX - this.originX;
                    const tempY = touch.clientY - this.originY;

                    // 超出圆形范围时固定在边缘
                    if (distance(tempX, tempY, 0, 0) >= JOYSTICK.radius) {
                        this.diffX = edgeOffsetX(tempX, tempY);
                        this.diffY = edgeOffsetY(tempX, tempY);
                    } else {
                        this.diffX = tempX;
                        this.diffY = tempY;
                    }

                    this.knob.style.left = this.diffX + JOYSTICK.centerOffset + 'px';
                    this.knob.style.top = this.diffY + JOYSTICK.centerOffset + 'px';

                    // 死区：手指没怎么动就别动球，避免手抖漂移
                    if (distance(tempX, tempY, 0, 0) < JOYSTICK.deadZone) {
                        this.input.speedX = 0;
                        this.input.speedY = 0;
                        return;
                    }
                    this.input.speedX = this.diffX || 0;
                    this.input.speedY = this.diffY || 0;
                }
                break;

            case 'touchend':
            case 'touchcancel':
                // 捏合中：捏合手指抬起才结束捏合，其他手指的抬起不碰摇杆状态
                if (this.pinch !== null) {
                    const ended = event.changedTouches[0];
                    if (ended.identifier === this.pinch.idA || ended.identifier === this.pinch.idB) {
                        this.endPinch(event);
                    }
                    return;
                }
                if (this.touchId === null) {
                    return;
                }
                // 只有操控中的那根手指抬起才停止
                if (!this.findTouch(event.changedTouches, this.touchId)) {
                    return;
                }
                this.touchId = null;
                this.controlPanel.style.display = 'none';
                this.knob.style.left = '50%';
                this.knob.style.top = '50%';
                // 松手即停
                this.input.speedX = 0;
                this.input.speedY = 0;
                break;
        }
    }

    findTouch(touchList, identifier) {
        for (const touch of touchList) {
            if (touch.identifier === identifier) {
                return touch;
            }
        }
        return null;
    }

    enable() {
        // passive: false 才能 preventDefault 掉页面滚动/缩放
        this.layer.addEventListener('touchstart', this.handleEvent, { passive: false });
        this.layer.addEventListener('touchmove', this.handleEvent, { passive: false });
        this.layer.addEventListener('touchend', this.handleEvent);
        this.layer.addEventListener('touchcancel', this.handleEvent);
    }

    disable() {
        this.layer.removeEventListener('touchstart', this.handleEvent);
        this.layer.removeEventListener('touchmove', this.handleEvent);
        this.layer.removeEventListener('touchend', this.handleEvent);
        this.layer.removeEventListener('touchcancel', this.handleEvent);
    }
}
