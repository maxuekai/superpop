import { ACTIONS, KEYS } from '../config.js';

// 键盘操控（WASD / 方向键 + 动作键）：方向写进 input.speedX/speedY（单位是「摇杆像素量」），
// 与浮动摇杆共用同一套速度分母，所以键盘与触屏手感一致。
// 与摇杆的关系：摇杆正在操控时（isBlocked）键盘让位；在输入框/弹层里打字时不响应。
// onAction 用来接动作键（分裂等），避免为每个动作再单独挂一个 document 监听。
export class Keyboard {
    constructor(target, input, options = {}) {
        this.target = target;
        this.input = input;
        // 摇杆在用时让位；不传就默认永远不阻塞
        this.isBlocked = options.isBlocked || (() => false);
        this.onAction = options.onAction || (() => {});

        this.pressed = new Set();

        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.handleKeyUp = this.handleKeyUp.bind(this);
        this.handleBlur = this.handleBlur.bind(this);
        this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    }

    // 只处理 WASD/方向键；输入框、弹层里的按键放行给页面
    isGameKey(code) {
        return KEYS.up.includes(code)
            || KEYS.down.includes(code)
            || KEYS.right.includes(code)
            || KEYS.left.includes(code);
    }

    isActionKey(code) {
        for (const list of Object.values(ACTIONS)) {
            if (list.includes(code)) {
                return true;
            }
        }
        return false;
    }

    isIgnorable(target) {
        return Boolean(target && target.closest && target.closest(KEYS.ignoreTarget));
    }

    handleKeyDown(e) {
        const action = this.isActionKey(e.code);
        if (!action && !this.isGameKey(e.code)) {
            return;
        }
        if (this.isIgnorable(e.target)) {
            return;
        }
        // 方向键会滚动页面、Space 会滚动/触发按钮，按游戏键时挡掉
        e.preventDefault();
        if (action) {
            this.onAction(e.code);
            return;
        }
        this.pressed.add(e.code);
        this.apply();
    }

    handleKeyUp(e) {
        if (!this.isGameKey(e.code)) {
            return;
        }
        this.pressed.delete(e.code);
        this.apply();
    }

    // 切窗口时松开所有键，否则会「卡住一直往一个方向走」
    handleBlur() {
        this.clear();
    }

    // 切到后台标签页：有些情况下不会触发 blur，但 keyup 可能已经丢了，
    // 同样要清干净，否则球会一直往最后按的方向跑
    handleVisibilityChange() {
        if (this.target.hidden) {
            this.clear();
        }
    }

    clear() {
        this.pressed.clear();
        this.input.speedX = 0;
        this.input.speedY = 0;
    }

    // 按住的方向合成一个向量：斜向自动归一化，斜着走不会比直着快
    apply() {
        if (this.isBlocked()) {
            return;
        }
        if (this.pressed.size === 0) {
            this.input.speedX = 0;
            this.input.speedY = 0;
            return;
        }
        let dx = 0;
        let dy = 0;
        for (const code of this.pressed) {
            if (KEYS.left.includes(code)) {
                dx -= 1;
            } else if (KEYS.right.includes(code)) {
                dx += 1;
            } else if (KEYS.up.includes(code)) {
                dy -= 1;
            } else if (KEYS.down.includes(code)) {
                dy += 1;
            }
        }
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        this.input.speedX = (dx / len) * KEYS.power;
        this.input.speedY = (dy / len) * KEYS.power;
    }

    enable() {
        this.target.addEventListener('keydown', this.handleKeyDown);
        this.target.addEventListener('keyup', this.handleKeyUp);
        this.target.addEventListener('blur', this.handleBlur);
        this.target.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    disable() {
        this.target.removeEventListener('keydown', this.handleKeyDown);
        this.target.removeEventListener('keyup', this.handleKeyUp);
        this.target.removeEventListener('blur', this.handleBlur);
        this.target.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
}
