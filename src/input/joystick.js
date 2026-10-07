import { JOYSTICK } from '../config.js';
import { distance, edgeOffsetX, edgeOffsetY } from '../core/utils.js';

// 浮动虚拟摇杆（touch 事件）：按住屏幕任意位置，摇杆面板出现在手指处，
// 拖动方向写入 player.speedX/speedY，松手摇杆消失、球停止。
// 不处理「界面元素」（.ui-interactive：开局/结算弹层、输入框、按钮）上的触摸，
// 否则 preventDefault 会把按钮点击和输入框聚焦一起吞掉。
// TODO: 只支持触屏，桌面鼠标不可用（见 TODO.md「输入」）
const UI_SELECTOR = '.ui-interactive';

export class Joystick {
    constructor(controlPanel, player) {
        this.controlPanel = controlPanel;
        this.knob = controlPanel.querySelector('.direction-control');
        // 监听整个文档：屏幕上任何位置按下都能操控
        this.layer = controlPanel.ownerDocument;
        this.player = player;

        // 正在操控的触摸点 identifier（多指只认第一根手指）
        this.touchId = null;
        this.originX = 0;
        this.originY = 0;
        this.diffX = 0;
        this.diffY = 0;

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

    handleEvent(e) {
        const event = e || window.event;

        switch (event.type) {
            case 'touchstart':
                // 已有操控中的手指则忽略（避免多指抢控）
                if (this.touchId !== null) {
                    return;
                }
                // 界面上的触摸不接管，也不阻止默认行为
                if (this.isUiTarget(event.target)) {
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
                if (this.touchId === null) {
                    return;
                }
                e.preventDefault();
                {
                    const touch = this.findTouch(event.touches, this.touchId);
                    if (!touch) {
                        return;
                    }
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
                        this.player.speedX = 0;
                        this.player.speedY = 0;
                        return;
                    }
                    this.player.speedX = this.diffX || 0;
                    this.player.speedY = this.diffY || 0;
                }
                break;

            case 'touchend':
            case 'touchcancel':
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
                this.player.speedX = 0;
                this.player.speedY = 0;
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