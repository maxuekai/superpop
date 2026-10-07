import { EAT, FOOD, PLAYER } from '../config.js';
import { distance, shadeColor } from './utils.js';

// 所有小球（玩家和 AI）的共同基类：移动、边界钳制、视觉回弹、进食与互吃判定、绘制。
// 球本身不产生速度：speedX/speedY 由外部写入（摇杆写玩家，AI 决策写自己），
// 数值是「摇杆像素量」，实际位移要除以速度分母（越大越慢）。
// 质量约定为 r²，和体重面板显示口径一致。
export class Ball {
    constructor(x, y, r, bColor, name) {
        this.x = x;
        this.y = y;
        this.r = r;
        this.speedX = 0;
        this.speedY = 0;
        this.bColor = bColor;
        this.name = name || '';
        // 每吃一颗食物的半径收益：玩家用 PLAYER.growthPerFood，AI 用 AI.foodGain
        this.foodGain = PLAYER.growthPerFood;
        // 视觉半径：用弹簧跟随实际半径，吃到东西会冲过头再回弹（见 update/onEat）
        this.displayR = r;
        this.rVel = 0;
        this.alive = true;
        // AI 用：被吃后的重生时刻（世界时间，秒）
        this.respawnAt = 0;
        // 出生保护：无敌到该时刻（世界时间，秒），0 表示没有
        this.shieldUntil = 0;
        // 由 Game 每帧根据当前时间刷新，draw 用来画保护光环
        this.shielded = false;
    }

    // 质量 = 半径平方
    get mass() {
        return this.r * this.r;
    }

    // 重生/复位：换位置、换半径，清空速度与视觉回弹
    reset(x, y, r, bColor) {
        this.x = x;
        this.y = y;
        this.r = r;
        if (bColor) {
            this.bColor = bColor;
        }
        this.speedX = 0;
        this.speedY = 0;
        this.displayR = r;
        this.rVel = 0;
        this.alive = true;
        // 保护由 Game 在重生后重新发放，这里先清干净
        this.shieldUntil = 0;
        this.shielded = false;
    }

    // 出生保护是否生效
    isProtected(now) {
        return now < this.shieldUntil;
    }

    grantShield(seconds, now) {
        this.shieldUntil = now + seconds;
    }

    update(dt, world) {
        // dt 是固定步长（1/60 秒）；乘 speedUnit 换算成「每 60fps 一帧」的位移，
        // 这样调大调小 dt 都不会改变手感
        const step = dt * PLAYER.speedUnit;

        // 越大越慢：速度分母随半径增长
        const divisor = PLAYER.speedDivisor + Math.max(0, this.r - PLAYER.radius) * PLAYER.slowdownPerRadius;
        this.x += (this.speedX / divisor) * step;
        this.y += (this.speedY / divisor) * step;

        // 视觉半径弹簧跟随实际半径：自然过冲回弹，比直接跳变顺滑
        this.rVel = (this.rVel + (this.r - this.displayR) * PLAYER.springStiffness) * PLAYER.springDamping;
        this.displayR += this.rVel * step;

        // 限制在地图内：圆心至少离边缘一个半径
        const maxX = Math.max(this.r, world.width - this.r);
        const maxY = Math.max(this.r, world.height - this.r);
        this.x = Math.min(maxX, Math.max(this.r, this.x));
        this.y = Math.min(maxY, Math.max(this.r, this.y));
    }

    // 吃到东西：给视觉半径一个向外的速度，之后由弹簧收敛回实际半径
    onEat(kick = PLAYER.pulseKick) {
        this.rVel += kick;
    }

    // 吃食物：圆心距不超过半径 + 食物半径即吃到
    canEatFood(foodX, foodY) {
        return distance(this.x, this.y, foodX, foodY) <= this.r + FOOD.radius;
    }

    // 尺寸是否够吃对方（只看大小，不看距离）
    outweighs(other) {
        return this.r > other.r * EAT.ratio;
    }

    // 能否吃掉对方：尺寸够 + 对方圆心已进入自己体内
    canEatBall(other) {
        return this.outweighs(other) && distance(this.x, this.y, other.x, other.y) <= this.r;
    }

    // 吸收对方质量：质量按 r² 累加后再开方回半径
    absorb(other) {
        this.r = Math.sqrt(this.mass + other.mass * EAT.absorb);
        this.onEat();
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

        // 出生保护：外圈画一圈光环
        if (this.shielded) {
            context.beginPath();
            context.arc(this.x, this.y, visualR * 1.28, 0, Math.PI * 2);
            context.strokeStyle = 'rgba(143, 240, 205, 0.75)';
            context.lineWidth = Math.max(2, visualR * 0.1);
            context.stroke();
        }

        // 名字浮在球上方
        if (this.name) {
            context.font = `600 ${Math.max(7, visualR * 0.5)}px -apple-system, BlinkMacSystemFont, sans-serif`;
            context.textAlign = 'center';
            context.textBaseline = 'bottom';
            context.fillStyle = 'rgba(255, 255, 255, 0.92)';
            context.fillText(this.name, this.x, this.y - visualR - Math.max(4, visualR * 0.18));
        }
    }
}