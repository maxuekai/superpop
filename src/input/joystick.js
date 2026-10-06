import { JOYSTICK } from '../config.js';
import { distance, edgeOffsetX, edgeOffsetY } from '../core/utils.js';

// 虚拟摇杆（touch 事件）：按住面板任意位置即可拖动，方向写入 player.speedX/speedY
// TODO: 只支持触屏，桌面鼠标不可用（见 TODO.md「输入」）
export class Joystick {
    constructor(controlPanel, player) {
        this.controlPanel = controlPanel;
        this.knob = controlPanel.querySelector('.direction-control');
        this.player = player;
        this.dragging = false;
        this.centerX = 0;
        this.centerY = 0;
        this.diffX = 0;
        this.diffY = 0;

        this.handleEvent = this.handleEvent.bind(this);
    }

    handleEvent(e) {
        const event = e || window.event;

        switch (event.type) {
            case 'touchstart':
                e.preventDefault();
                // 不再要求按中摇杆头：面板内任意位置按下都能拖
                this.dragging = true;
                {
                    const rect = this.controlPanel.getBoundingClientRect();
                    this.centerX = rect.left + rect.width / 2;
                    this.centerY = rect.top + rect.height / 2;
                }
                break;

            case 'touchmove':
                if (this.dragging !== true) {
                    return;
                }
                {
                    // 手指相对面板中心的位置
                    let tempX = event.touches[0].clientX - this.centerX;
                    let tempY = event.touches[0].clientY - this.centerY;

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

                    this.player.speedX = this.diffX || 0;
                    this.player.speedY = this.diffY || 0;
                }
                break;

            case 'touchend':
                if (this.dragging !== true) {
                    return;
                }
                this.knob.style.left = '50%';
                this.knob.style.top = '50%';
                this.dragging = false;
                // 松手即停
                this.player.speedX = 0;
                this.player.speedY = 0;
                break;
        }
    }

    enable() {
        this.controlPanel.addEventListener('touchstart', this.handleEvent);
        this.controlPanel.addEventListener('touchmove', this.handleEvent);
        this.controlPanel.addEventListener('touchend', this.handleEvent);
    }

    disable() {
        this.controlPanel.removeEventListener('touchstart', this.handleEvent);
        this.controlPanel.removeEventListener('touchmove', this.handleEvent);
        this.controlPanel.removeEventListener('touchend', this.handleEvent);
    }
}
