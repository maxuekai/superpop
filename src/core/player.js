import { PLAYER } from '../config.js';
import { distance } from './utils.js';

// 玩家小球
export class Player {
    constructor(x, y, r, bColor) {
        this.r = r;
        this.x = x;
        this.y = y;
        this.speedX = 0;
        this.speedY = 0;
        this.speed = PLAYER.speedDivisor;
        this.bColor = bColor;
    }

    update(worldWidth, worldHeight) {
        this.x += this.speedX / this.speed;
        this.y += this.speedY / this.speed;

        // 限制在地图内：圆心至少离边缘一个半径（r 是半径，原来错写成 r/2）
        if (this.x - this.r < 0) {
            this.x = this.r;
        }
        if (this.y - this.r < 0) {
            this.y = this.r;
        }
        if (this.x + this.r > worldWidth) {
            this.x = worldWidth - this.r;
        }
        if (this.y + this.r > worldHeight) {
            this.y = worldHeight - this.r;
        }
    }

    // 调用处需已把上下文平移到世界坐标系
    draw(context) {
        context.save();
        context.fillStyle = this.bColor;
        context.beginPath();
        context.arc(this.x, this.y, this.r, 0, Math.PI * 2);
        context.closePath();
        context.stroke();
        context.fill();
        context.restore();
    }

    // 圆心到食物的距离不超过半径即视为吃到
    canEat(foodX, foodY) {
        return this.r >= distance(this.x, this.y, foodX, foodY);
    }
}
