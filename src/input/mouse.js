import { MOUSE } from '../config.js';

// 桌面鼠标操控：球朝光标方向走（不用按住按钮），单位与摇杆/键盘完全一致
//（「摇杆像素量」），于是三种输入共用同一个速度分母，手感不会分叉。
//
// 为什么桌面还要 WASD：两个入口共存、互不打架。
//   · 鼠标只在 **pointermove** 时写 input；键盘在 **keydown** 时写。
//     两者都往同一个 input 写，谁最后动谁生效——按住 W 不动鼠标，键盘就一直掌着；
//     松开键盘动一下鼠标，立刻切回鼠标。不需要额外的仲裁逻辑。
//
// 与摇杆的关系：手指在屏幕上操控时（Joystick.isActive）鼠标让位——
// 触屏设备上浏览器的合成 mouse 事件（点按钮后那一下）不该把球拽走。
//
// 监听目标由构造传入（AGENTS.md 的约定）：类里不直接摸 document。
// 事件监听目标默认是 canvas 而不是 document：HUD 面板浮在画布上方，
// 指针停在面板上时画布根本收不到事件，球自然就不动——比"收到事件再判断
// target 是不是 .ui-interactive"更早一步，也不会在面板边缘来回横跳。
export class MouseSteer {
    constructor(target, input, options = {}) {
        this.target = target;
        this.input = input;
        // 球在 CSS 像素里的位置（Game.ballScreen 提供：相机视口 + 缩放）
        this.getBallScreen = options.getBallScreen || (() => ({ x: 0, y: 0 }));
        // 让位判定：手指在操控、或者不在局内，就不接管
        this.isBlocked = options.isBlocked || (() => false);
        // 只在局内操控：菜单/结算弹层期间球不该跟着光标跑
        this.isEnabled = options.isEnabled || (() => true);
        this.pointer = { x: 0, y: 0 };
        this.inside = false;

        this.handleMove = this.handleMove.bind(this);
        this.handleEnter = this.handleEnter.bind(this);
        this.handleLeave = this.handleLeave.bind(this);
        this.handleBlur = this.handleBlur.bind(this);
    }

    // 当前是否由鼠标操控（键盘的 isBlocked 用不到，这里主要给外部查询/测试）
    get isActive() {
        return this.inside;
    }

    clear() {
        this.input.speedX = 0;
        this.input.speedY = 0;
    }

    handleEnter(event) {
        if (this.isTouch(event)) {
            return;
        }
        this.inside = true;
        this.pointer.x = event.clientX;
        this.pointer.y = event.clientY;
        this.apply();
    }

    handleMove(event) {
        if (this.isTouch(event)) {
            return;
        }
        this.inside = true;
        this.pointer.x = event.clientX;
        this.pointer.y = event.clientY;
        this.apply();
    }

    handleLeave() {
        this.inside = false;
        this.clear();
    }

    // 窗口失焦（Alt+Tab、切到别的窗口）时光标不再移动，
    // 但上一帧的方向还留在 input 里 —— 不清掉的话球会一直朝那个方向走。
    // 键盘那边有同样的处理（Keyboard.handleBlur），这里是对称的另一半。
    handleBlur() {
        this.handleLeave();
    }

    // 触屏设备上浏览器的合成 mouse 事件不参与操控：
    // 那会让"手指在摇杆上操作、点一下按钮"变成"球猛地朝按钮方向窜一下"。
    isTouch(event) {
        return Boolean(event.pointerType) && event.pointerType !== 'mouse';
    }

    apply() {
        if (this.isBlocked() || !this.isEnabled()) {
            this.clear();
            return;
        }
        const ball = this.getBallScreen();
        const dx = this.pointer.x - ball.x;
        const dy = this.pointer.y - ball.y;
        const len = Math.hypot(dx, dy);
        // 死区：光标压在球上时（差几像素）不该让球抖。
        // 注意 mouse 事件没有 preventDefault 可用（那会破坏文字选择/右键菜单），
        // 所以 UI 元素的白名单只能靠事件根本不进来（监听 canvas）来保证。
        if (len < MOUSE.deadZone) {
            this.clear();
            return;
        }
        this.input.speedX = (dx / len) * MOUSE.power;
        this.input.speedY = (dy / len) * MOUSE.power;
    }

    enable() {
        this.target.addEventListener('pointerenter', this.handleEnter);
        this.target.addEventListener('pointermove', this.handleMove);
        this.target.addEventListener('pointerleave', this.handleLeave);
        this.target.addEventListener('blur', this.handleBlur);
    }

    disable() {
        this.target.removeEventListener('pointerenter', this.handleEnter);
        this.target.removeEventListener('pointermove', this.handleMove);
        this.target.removeEventListener('pointerleave', this.handleLeave);
        this.target.removeEventListener('blur', this.handleBlur);
    }
}
