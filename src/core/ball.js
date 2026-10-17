import { EAT, FOOD, PLAYER, SPLIT } from '../config.js';
import { distance, distanceSq, capRadius, shadeColor } from './utils.js';
import { log } from './log.js';

// 球体渐变按颜色缓存：颜色就 COLORS 那几种，而每个球每帧 createRadialGradient +
// 3 次 addColorStop + shadeColor 字符串解析，20 球 × 高刷就是每秒数千个原生渐变对象。
// 缓存的是**单位圆局部坐标系**的渐变与描边色（与位置/半径/dpr 无关），
// 画球时 translate(x,y) + scale(r,r) 上去即可，与世界坐标渐变逐像素等价。
const paintCache = new Map(); // bColor -> { fill: CanvasGradient, edge: string }

function ballPaint(context, bColor) {
    let paint = paintCache.get(bColor);
    if (!paint) {
        const fill = context.createRadialGradient(-0.35, -0.35, 0.1, 0, 0, 1);
        fill.addColorStop(0, shadeColor(bColor, 0.55));
        fill.addColorStop(0.75, bColor);
        fill.addColorStop(1, shadeColor(bColor, -0.25));
        paint = { fill, edge: shadeColor(bColor, -0.35) };
        paintCache.set(bColor, paint);
    }
    return paint;
}

// ctx.font 每帧重新赋值会触发字体解析：量化到整数 px 后按串缓存，相同就跳过。
// 只有球名字用 canvas 文字，一份全局缓存就够（textAlign/textBaseline 由 Game.draw 每帧统一设）。
let lastNameFont = '';

// 所有小球（玩家和 AI）的共同基类：移动、边界钳制、视觉回弹、进食与互吃判定、绘制。
// 球本身不产生速度：speedX/speedY 由外部写入（摇杆写玩家，AI 决策写自己），
// 数值是「摇杆像素量」，实际位移要除以速度分母（越大越慢）。
// 质量约定为 r²，和体重面板显示口径一致。
export class Ball {
    static ownerSeq = 0;
    // 细胞身份（cid）：构造时分配、此后永不改变，用来在联机快照里认出「同一个细胞」。
    //
    // 为什么需要它：客户端曾经用 `ownerId#index` 当 ghost 的 key，index 是细胞在组内
    // 数组的位置。被吃一颗中间分身、或两个分身合并，位置就会重排——index 1 突然
    // 指向了原来 index 2 的那颗球，对端于是看到 ghost 瞬移一帧。cid 不受重排影响。
    //
    // 语义：
    //   · 分裂：原球**保持**自己的 cid（对象没换，只是半径减半并偏移），新半球拿新 cid；
    //   · 合并：活下来的那颗保持 cid，被并进去的直接消失；
    //   · 死亡/重生：都是新对象、新 cid（重生本来就该是"一颗新球"）。
    // 所以 cid 全局单调递增即可，不需要回收；进程内唯一就够。
    static cellSeq = 0;

    constructor(x, y, r, bColor, name, ownerId) {
        this.x = x;
        this.y = y;
        this.r = r;
        this.cid = Ball.nextCellId();
        this.speedX = 0;
        this.speedY = 0;
        this.bColor = bColor;
        this.name = name || '';
        // 归属：默认每个球自成一组（AI 之间照常互吃）；
        // 玩家的多个分身共用同一个 ownerId，于是彼此不能互吃、排行榜按组合计
        this.ownerId = ownerId || `ball${Ball.nextOwnerId()}`;
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
        // 分裂相关：所属细胞组的合并冷却（世界时间，秒）
        this.mergeAfter = 0;
        // 分裂瞬间「朝外弹开」的速度（世界单位/秒）与剩余时间（秒）。
        // 分裂后两半朝同一方向以同一速度走，距离会永远停在初始间距上——
        // 没有这段外冲，看起来就像球"变胖"而不是"裂开"（见 config.js SPLIT.pushSpeed）
        this.splitVx = 0;
        this.splitVy = 0;
        this.pushLeft = 0;
        // 合并顿挫（两半粘回一个的那一下）：mergeStun 是剩余僵直时间（秒），
        // mergeWobble 是视觉挤压幅度（比例），mergePhase 是挤压往复的相位。
        // 由 rules.mergeCells 写入，Ball.update 消费（见 config.SPLIT.mergeStun*）。
        // 纯表现 + 手感：质量守恒与合并阈值都不受影响。
        this.mergeStun = 0;
        this.mergeWobble = 0;
        this.mergePhase = 0;
    }

    static nextOwnerId() {
        Ball.ownerSeq += 1;
        return Ball.ownerSeq;
    }

    static nextCellId() {
        Ball.cellSeq += 1;
        return Ball.cellSeq;
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
        // 弹开速度也一起清掉，否则重生后会带着上一次分裂的余速漂移
        this.splitVx = 0;
        this.splitVy = 0;
        this.pushLeft = 0;
        this.mergeStun = 0;
        this.mergeWobble = 0;
        this.mergePhase = 0;
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

        // 更大越慢：速度分母随半径增长
        const divisor = PLAYER.speedDivisor + Math.max(0, this.r - PLAYER.radius) * PLAYER.slowdownPerRadius;

        // 合并顿挫：黏回来的那一下走不动。折扣按「剩余僵直比例」线性回到 1，
        // 于是恢复速度也是渐进的——一帧直接恢复会像卡了一下又猛地弹出去。
        // 挤压幅度同样由剩余时间驱动（乘回初值），不需要另写一条衰减。
        let throttle = 1;
        if (this.mergeStun > 0) {
            const k = Math.min(1, this.mergeStun / SPLIT.mergeStunSeconds);
            throttle = 1 - (1 - SPLIT.mergeStunSlow) * k;
            this.mergeStun = Math.max(0, this.mergeStun - dt);
            // ⚠ 最后一帧必须直接清零，不能留 k 的残值：合并后会永远带着
            // 一个永久的挤压变形（0.0057 这种看着无害，久了就是"球一直是椭的"）
            this.mergeWobble = this.mergeStun > 0 ? SPLIT.mergeStunWobble * k : 0;
            this.mergePhase += dt * SPLIT.mergeStunHz * Math.PI * 2;
        } else if (this.mergeWobble !== 0) {
            this.mergeWobble = 0; // 顿挫结束的那一帧把视觉量清干净，别留个尾巴
        }

        this.x += (this.speedX / divisor) * step * throttle;
        this.y += (this.speedY / divisor) * step * throttle;

        // 分裂外冲：按剩余时间线性衰减到 0。
        // 必须乘 dt 而不是 step：这段位移是"世界单位/秒"，不参与速度分母与体型缩放。
        if (this.pushLeft > 0) {
            const falloff = this.pushLeft / SPLIT.pushTime;
            this.x += this.splitVx * dt * falloff;
            this.y += this.splitVy * dt * falloff;
            this.pushLeft = Math.max(0, this.pushLeft - dt);
            if (this.pushLeft === 0) {
                this.splitVx = 0;
                this.splitVy = 0;
            }
        }

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

    // 吃食物：圆心距不超过半径 + 食物半径即吃到（平方距离比较，数学等价）
    canEatFood(foodX, foodY) {
        const reach = this.r + FOOD.radius;
        return distanceSq(this.x, this.y, foodX, foodY) <= reach * reach;
    }

    // 尺寸是否够吃对方（只看大小，不看距离，也不看是不是自己的分身）
    outweighs(other) {
        return this.r > other.r * EAT.ratio;
    }

    // 能否吃掉对方：尺寸够 + 两个圆有重叠；**自己的分身不吃**。
    // 吃人条件用「两圆重叠」（中心距 ≤ r1+r2）而不是「对方圆心进入自己体内」：
    // 后者要求猎物先深入吃者半径内，小球才能贴着边缘擦过去而不死——真机反馈
    // "不是应该一碰到边缘就被吃掉吗"。类型游戏的标准口径也是重叠即吃。
    canEatBall(other) {
        if (other.ownerId === this.ownerId) {
            return false;
        }
        if (!this.outweighs(other)) {
            return false;
        }
        return distance(this.x, this.y, other.x, other.y) <= this.r + other.r;
    }

    // 吸收对方质量：质量按 r² 累加后再开方回半径。
    // bonus 是「吃人收益倍率」，AI 会用它让互吃长得更明显（默认 1）。
    // 结果要过半径上限——互吃是增长最快的一条路径（吃掉同尺寸的球 r 直接 ×1.45）。
    absorb(other, bonus = 1) {
        const before = this.r;
        this.r = capRadius(Math.sqrt(this.mass + other.mass * EAT.absorb * bonus));
        log('吞球', `${this.name} 吃掉 ${other.name}：r ${before.toFixed(0)} → ${this.r.toFixed(0)}`);
        this.onEat();
    }

    // 立体细胞质感：径向渐变（左上受光、右下渐暗）+ 暗描边 + 高光点
    // displayR 是带弹簧回弹的视觉半径（纯表现，碰撞半径仍是 this.r）
    // 调用处需已把上下文平移到世界坐标系。
    // 球体部分在「单位圆局部坐标系」里画（渐变/高光按颜色缓存复用），
    // 光环与名字不便走单位圆的，restore 后回到原坐标系画，观感与旧实现逐像素等价。
    draw(context) {
        const visualR = this.displayR;
        const paint = ballPaint(context, this.bColor);

        // 合并顿挫的视觉挤压：mergeWobble 由 Ball.update 按剩余僵直时间给出，
        // 这里把它变成一对相反方向的缩放 → 圆被挤成椭圆，下一帧又弹回来。
        // 只压球体本身；名字与光环仍按正圆画（挤歪的文字比挤歪的球更难看）。
        const wobble = this.mergeWobble > 0.001 ? Math.sin(this.mergePhase) * this.mergeWobble : 0;
        const radiusX = visualR * (1 + wobble);
        const radiusY = visualR * (1 - wobble);

        context.save();
        context.translate(this.x, this.y);
        context.scale(radiusX, radiusY);
        context.fillStyle = paint.fill;
        context.beginPath();
        context.arc(0, 0, 1, 0, Math.PI * 2);
        context.closePath();
        context.fill();

        // 描边线宽先按世界口径算（含 1.5 下限），再除回单位圆坐标系
        context.strokeStyle = paint.edge;
        context.lineWidth = Math.max(1.5, visualR * 0.06) / radiusX;
        context.stroke();

        context.beginPath();
        context.arc(-0.38, -0.42, 0.16, 0, Math.PI * 2);
        context.fillStyle = 'rgba(255, 255, 255, 0.5)';
        context.fill();
        context.restore();

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
            const font = `600 ${Math.max(7, Math.round(visualR * 0.5))}px -apple-system, BlinkMacSystemFont, sans-serif`;
            if (font !== lastNameFont) {
                context.font = font;
                lastNameFont = font;
            }
            context.fillStyle = 'rgba(255, 255, 255, 0.92)';
            context.fillText(this.name, this.x, this.y - visualR - Math.max(4, visualR * 0.18));
        }
    }
}