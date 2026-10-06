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

        // 限制在地图内
        // TODO: 这里用的是 r/2，但画圆时 r 是半径，疑似 bug，应改为 r
        if (this.x - this.r / 2 < 0) {
            this.x = this.r / 2;
        }
        if (this.y - this.r / 2 < 0) {
            this.y = this.r / 2;
        }
        if (this.x + this.r / 2 > worldWidth) {
            this.x = worldWidth - this.r / 2;
        }
        if (this.y + this.r / 2 > worldHeight) {
            this.y = worldHeight - this.r / 2;
        }
    }

    draw(context, xView, yView) {
        context.save();
        context.fillStyle = this.bColor;
        context.beginPath();
        context.arc(this.x - xView, this.y - yView, this.r, 0, Math.PI * 2);
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
