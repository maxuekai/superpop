import { JOYSTICK } from '../config.js';
import { distance, edgeOffsetX, edgeOffsetY } from '../core/utils.js';

// 虚拟摇杆（touch 事件），拖动时把方向写入 player.speedX/speedY
// TODO: 只支持触屏，桌面鼠标不可用（见 TODO.md「输入」）
export class Joystick {
    constructor(controlPanel, player) {
        this.controlPanel = controlPanel;
        this.player = player;
        this.dragging = null;
        this.diffX = 0;
        this.diffY = 0;

        this.handleEvent = this.handleEvent.bind(this);
    }

    handleEvent(e) {
        const event = e || window.event;
        const target = e.target || e.srcElement;

        switch (event.type) {
            case 'touchstart':
                e.preventDefault();
                if (~target.className.indexOf('draggable')) {
                    this.dragging = target;
                } else {
                    this.dragging = null;
                    return;
                }
                break;

            case 'touchmove':
                if (this.dragging !== null) {
                    // 摇杆头相对面板中心的位置
                    let tempX = event.touches[0].clientX - target.parentNode.offsetLeft - JOYSTICK.centerOffset;
                    let tempY = event.touches[0].clientY - target.parentNode.offsetTop - JOYSTICK.centerOffset;

                    // 超出圆形范围时固定在边缘
                    if (distance(tempX, tempY, 0, 0) >= JOYSTICK.radius) {
                        this.diffX = edgeOffsetX(tempX, tempY);
                        this.diffY = edgeOffsetY(tempX, tempY);
                    } else {
                        this.diffX = tempX;
                        this.diffY = tempY;
                    }

                    this.dragging.style.left = this.diffX + JOYSTICK.centerOffset + 'px';
                    this.dragging.style.top = this.diffY + JOYSTICK.centerOffset + 'px';

                    // 防止小球突然停止
                    this.diffX = this.diffX ? this.diffX : 0;
                    this.diffY = this.diffY ? this.diffY : 0;
                    this.player.speedX = this.diffX;
                    this.player.speedY = this.diffY;
                }
                break;

            case 'touchend':
                if (this.dragging === null) {
                    return;
                }
                this.dragging.style.left = '50%';
                this.dragging.style.top = '50%';
                this.dragging = null;
                // 松手即停（原来只复位摇杆头、不归零速度，球会一直滚）
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
