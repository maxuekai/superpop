import { Rectangle } from './rectangle.js';

// 跟随相机的死区逻辑：被跟随物体在死区内移动时相机不动，
// 超出死区则平移视口，并把视口钳制在世界范围内
export class Camera {
    constructor(xView, yView, canvasWidth, canvasHeight, worldWidth, worldHeight) {
        this.xView = xView || 0;
        this.yView = yView || 0;

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

    follow(gameObject, xDeadZone, yDeadZone) {
        this.followed = gameObject;
        this.xDeadZone = xDeadZone;
        this.yDeadZone = yDeadZone;
    }

    // 窗口尺寸变化时更新视口大小（单位：世界坐标），并同步死区
    setViewSize(width, height) {
        this.wView = width;
        this.hView = height;
        this.viewportRect.set(this.xView, this.yView, width, height);
        if (this.followed !== null) {
            this.xDeadZone = width / 2;
            this.yDeadZone = height / 2;
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

        // 更新视口矩形
        this.viewportRect.set(this.xView, this.yView);

        // 视口超出世界范围时钳制回来
        if (!this.viewportRect.within(this.worldRect)) {
            if (this.viewportRect.left < this.worldRect.left) {
                this.xView = this.worldRect.left;
            }
            if (this.viewportRect.top < this.worldRect.top) {
                this.yView = this.worldRect.top;
            }
            if (this.viewportRect.right > this.worldRect.right) {
                this.xView = this.worldRect.right - this.wView;
            }
            if (this.viewportRect.bottom > this.worldRect.bottom) {
                this.yView = this.worldRect.bottom - this.hView;
            }
        }
    }
}
