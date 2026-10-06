import { MAP_IMAGE_SRC } from '../config.js';

// 地图：把背景图烤到一张离屏 canvas 上只烤一次，绘制时按相机视口裁剪出可见区域。
// 食物不烤进地图，由 Game 每帧按视口动态绘制（吃/重生都不用重烤大图）。
export class Map {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.image = document.createElement('canvas');
        this.image.width = width;
        this.image.height = height;
        this.ready = false;

        const img = new Image();
        img.src = MAP_IMAGE_SRC;
        img.onload = () => {
            this.image.getContext('2d').drawImage(img, 0, 0, this.width, this.height);
            this.ready = true;
        };
    }

    // 视口（世界坐标）内的可见部分画到屏幕上；调用处需已把上下文平移到世界坐标系
    draw(context, camera) {
        if (!this.ready) {
            return;
        }

        // 开始裁剪的位置
        const sx = Math.max(0, camera.xView);
        const sy = Math.max(0, camera.yView);

        // 被裁剪的区域大小，不超出图片边界
        const sWidth = Math.min(camera.wView, this.image.width - sx);
        const sHeight = Math.min(camera.hView, this.image.height - sy);
        if (sWidth <= 0 || sHeight <= 0) {
            return;
        }

        // 目标位置与裁剪区域同坐标（调用处已做 translate）
        context.drawImage(this.image, sx, sy, sWidth, sHeight, sx, sy, sWidth, sHeight);
    }
}
