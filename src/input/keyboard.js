import { KEYS } from '../config.js';

// 键盘操控（WASD / 方向键）：和浮动摇杆一样把方向写进 player.speedX/speedY，
// 两者共用同一套速度分母，所以键盘与触屏手感一致。
// 与摇杆的关系：摇杆正在操控时（isBlocked）键盘让位，松手归零；
// 在输入框/弹层里打字时完全不响应，别把昵称输成 WASD。
export class Keyboard {
    constructor(target, player, options = {}) {
        this.target = target;
        this.player = player;
        // 摇杆在用时让位；不传就默认永远不阻塞
        this.isBlocked = options.isBlocked || (() => false);

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
            || KEYS.left.includes(code)
            || KEYS.right.includes(code);
    }

    isIgnorable(target) {
        return Boolean(target && target.closest && target.closest(KEYS.ignoreTarget));
    }

    handleKeyDown(e) {
        if (!this.isGameKey(e.code) || this.isIgnorable(e.target)) {
            return;
        }
        // 方向键会滚动页面，按游戏键时挡掉
        e.preventDefault();
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
        this.player.speedX = 0;
        this.player.speedY = 0;
    }

    // 按住的方向合成一个向量：斜向自动归一化，斜着走不会比直着快
    apply() {
        if (this.isBlocked()) {
            return;
        }
        let dx = 0;
        let dy = 0;
        if (this.pressed.size === 0) {
            this.player.speedX = 0;
            this.player.speedY = 0;
            return;
        }
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
        this.player.speedX = (dx / len) * KEYS.power;
        this.player.speedY = (dy / len) * KEYS.power;
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