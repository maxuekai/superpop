import { Rectangle } from './rectangle.js';

// 跟随相机的死区逻辑：被跟随物体在死区内移动时相机不动，
// 超出死区则平移视口，并把视口钳制在世界范围内
export class Camera {
    // 死区占视口的比例（VIEW.cameraDeadZone）。0.5 表示球要飘到屏幕中心之外镜头才动，
    // 手机上这个值太大会「球不见了」，所以默认 0.35。
    constructor(xView, yView, canvasWidth, canvasHeight, worldWidth, worldHeight, deadZoneRatio = 0.35) {
        this.xView = xView || 0;
        this.yView = yView || 0;

        this.deadZoneRatio = deadZoneRatio;
        this.xDeadZone = 0;
        this.yDeadZone = 0;

        this.wView = canvasWidth;
        this.hView = canvasHeight;

        this.followed = null;

        // 视口矩形（画布大小）
        this.viewportRect = new Rectangle(this.xView, this.yView, this.wView, this.hView);

        // 世界矩形（整张地图）
        this.worldRect = new Rectangle(0, 0, worldWidth, worldHeight);
    }

    // 跟随目标。不传死区时保留现有值——每帧调用 follow(target) 如果把死区写成
    // undefined，后面 update() 里的比较会全变成 NaN，镜头就永远不动了。
    follow(gameObject, xDeadZone, yDeadZone) {
        this.followed = gameObject;
        if (typeof xDeadZone === 'number') {
            this.xDeadZone = xDeadZone;
        }
        if (typeof yDeadZone === 'number') {
            this.yDeadZone = yDeadZone;
        }
    }

    // 窗口尺寸变化时更新视口大小（单位：世界坐标），并同步死区
    setViewSize(width, height) {
        this.wView = width;
        this.hView = height;
        this.viewportRect.set(this.xView, this.yView, width, height);
        if (this.followed !== null) {
            this.xDeadZone = width * this.deadZoneRatio;
            this.yDeadZone = height * this.deadZoneRatio;
        }
    }

    update() {
        if (this.followed !== null) {
            // 右超出
            if (this.followed.x - this.xView + this.xDeadZone > this.wView) {
                this.xView = this.followed.x - (this.wView - this.xDeadZone);
            }
            // 左超出
            else if (this.followed.x - this.xDeadZone < this.xView) {
                this.xView = this.followed.x - this.xDeadZone;
            }
            // 下超出
            if (this.followed.y - this.yView + this.yDeadZone > this.hView) {
                this.yView = this.followed.y - (this.hView - this.yDeadZone);
            }
            // 上超出
            else if (this.followed.y - this.yDeadZone < this.yView) {
                this.yView = this.followed.y - this.yDeadZone;
            }
        }

        this.clampView();
    }

    // 视口超出世界范围时钳制回来。
    // 视口比世界还大时**居中**而不是贴左上角——贴左上角的话 xView 会被
    // "左边超出"和"右边超出"两条规则来回打，变成负坐标和反复横跳，球也偏在屏幕一侧。
    // 居中之后露出的世界外区域在左右两边均分。
    clampView() {
        const worldW = this.worldRect.width;
        const worldH = this.worldRect.height;

        this.xView = this.wView >= worldW
            ? (worldW - this.wView) / 2
            : Math.min(worldW - this.wView, Math.max(0, this.xView));

        this.yView = this.hView >= worldH
            ? (worldH - this.hView) / 2
            : Math.min(worldH - this.hView, Math.max(0, this.yView));

        this.viewportRect.set(this.xView, this.yView);
    }

    // 立刻把视口居中到目标身上（重生、传送用），避免相机慢慢追过去
    snapTo(target) {
        this.xView = target.x - this.wView / 2;
        this.yView = target.y - this.hView / 2;
        this.clampView();
    }
}
