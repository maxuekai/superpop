import { MAP } from '../config.js';

// 地图：背景程序生成（暗色渐变 + 世界坐标网格 + 边界描边），只生成一次，
// 绘制时按相机视口裁剪出可见区域。
// 食物不烤进地图，由 Game 每帧按视口动态绘制（吃/重生都不用重烤大图）。
export class Map {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.image = document.createElement('canvas');
        this.image.width = width;
        this.image.height = height;
        this.generate();
        this.ready = true;
    }

    generate() {
        const ctx = this.image.getContext('2d');

        // 底色：纵向暗色渐变
        const gradient = ctx.createLinearGradient(0, 0, 0, this.height);
        gradient.addColorStop(0, '#0e3833');
        gradient.addColorStop(1, '#071e1c');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, this.width, this.height);

        // 网格：每 MAP.gridStep 个世界单位一条细线（锚定世界坐标，相机移动时网格不动）
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = MAP.gridStep; x < this.width; x += MAP.gridStep) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.height);
        }
        for (let y = MAP.gridStep; y < this.height; y += MAP.gridStep) {
            ctx.moveTo(0, y);
            ctx.lineTo(this.width, y);
        }
        ctx.stroke();

        // 世界边界：亮描边，标示可活动范围
        ctx.strokeStyle = 'rgba(110, 231, 195, 0.5)';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, this.width - 4, this.height - 4);
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
