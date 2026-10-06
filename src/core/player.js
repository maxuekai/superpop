import { PLAYER } from '../config.js';
import { distance, shadeColor } from './utils.js';

// 玩家小球
export class Player {
    constructor(x, y, r, bColor) {
        this.r = r;
        this.x = x;
        this.y = y;
        this.speedX = 0;
        this.speedY = 0;
        this.bColor = bColor;
        // 视觉半径：用弹簧跟随实际半径，吃到食物会冲过头再回弹（见 update/onEat）
        this.displayR = r;
        this.rVel = 0;
    }

    update(worldWidth, worldHeight) {
        // 越大越慢：速度分母随半径增长
        const divisor = PLAYER.speedDivisor + Math.max(0, this.r - PLAYER.radius) * PLAYER.slowdownPerRadius;
        this.x += this.speedX / divisor;
        this.y += this.speedY / divisor;

        // 视觉半径弹簧跟随实际半径：自然过冲回弹，比直接跳变顺滑
        this.rVel += (this.r - this.displayR) * PLAYER.springStiffness;
        this.rVel *= PLAYER.springDamping;
        this.displayR += this.rVel;

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

    // 吃到食物：给视觉半径一个向外的速度，之后由弹簧收敛回实际半径
    onEat() {
        this.rVel += PLAYER.pulseKick;
    }

    // 立体细胞质感：径向渐变（左上受光、右下渐暗）+ 暗描边 + 高光点
    // displayR 是带弹簧回弹的视觉半径（纯表现，碰撞半径仍是 this.r）
    // 调用处需已把上下文平移到世界坐标系
    draw(context) {
        const visualR = this.displayR;
        const gradient = context.createRadialGradient(
            this.x - visualR * 0.35,
            this.y - visualR * 0.35,
            visualR * 0.1,
            this.x,
            this.y,
            visualR,
        );
        gradient.addColorStop(0, shadeColor(this.bColor, 0.55));
        gradient.addColorStop(0.75, this.bColor);
        gradient.addColorStop(1, shadeColor(this.bColor, -0.25));
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(this.x, this.y, visualR, 0, Math.PI * 2);
        context.closePath();
        context.fill();

        context.strokeStyle = shadeColor(this.bColor, -0.35);
        context.lineWidth = Math.max(1.5, visualR * 0.06);
        context.stroke();

        context.beginPath();
        context.arc(this.x - visualR * 0.38, this.y - visualR * 0.42, visualR * 0.16, 0, Math.PI * 2);
        context.fillStyle = 'rgba(255, 255, 255, 0.5)';
        context.fill();
    }

    // 圆心到食物的距离不超过半径即视为吃到
    canEat(foodX, foodY) {
        return this.r >= distance(this.x, this.y, foodX, foodY);
    }
}
