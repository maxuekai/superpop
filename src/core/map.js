import { FOOD, MAP_IMAGE_SRC } from '../config.js';

// 地图：把背景图和食物点画到离屏 canvas 上，缓存为一张大图，
// 绘制时按相机视口裁剪出当前可见区域
export class Map {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.image = new Image();
    }

    // 食物变化后重新生成整张地图（开销大，见 TODO.md「性能」）
    generate(foodList) {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.canvas.width = this.width;
        ctx.canvas.height = this.height;

        const img = new Image();
        img.src = MAP_IMAGE_SRC;
        img.onload = () => {
            ctx.drawImage(img, 0, 0, this.width, this.height);
            this.drawFood(ctx, foodList);
            this.image.src = ctx.canvas.toDataURL('image/jpg');
            ctx = null;
        };
    }

    draw(context, xView, yView) {
        // 开始裁剪的位置
        let sx = xView;
        let sy = yView;

        // 被裁剪的区域大小，不超出图片边界
        let sWidth = context.canvas.width;
        let sHeight = context.canvas.height;
        if (this.image.width - sx < sWidth) {
            sWidth = this.image.width - sx;
        }
        if (this.image.height - sy < sHeight) {
            sHeight = this.image.height - sy;
        }

        // 在画布上从 (0, 0) 开始放置
        context.drawImage(this.image, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);
    }

    drawFood(context, foodList) {
        for (const food of foodList) {
            context.save();
            context.fillStyle = food.color;
            context.beginPath();
            context.arc(food.x, food.y, FOOD.radius, 0, Math.PI * 2);
            context.closePath();
            context.stroke();
            context.fill();
            context.restore();
        }
    }
}
