import { AI, JOYSTICK } from '../config.js';
import { Ball } from './ball.js';
import { clamp, distance, distanceSq, randomFloat } from './utils.js';

// AI 小球：继承 Ball，只加一层「决策」。
// 决策优先级：逃离更大的球 > 追击更小的球（含玩家）> 觅食 > 随机游走。
// 决策按 AI.thinkInterval 重新挑选目标（避免每帧抖动），转向每帧计算。
export class AiPlayer extends Ball {
    constructor(x, y, r, bColor, name) {
        super(x, y, r, bColor, name);
        // 吃人收益倍率：让 AI 之间的互吃更明显（数值见 config.AI.eatBonus）
        this.eatBonus = AI.eatBonus;
        this.thinkTimer = 0;
        this.wanderTimer = 0;
        this.wanderAngle = randomFloat(0, Math.PI * 2);
        this.targetBall = null;
        this.targetFood = null;
        this.fleeing = false;
        // 逃跑时顺手去吃的食物（见 think()），null = 这轮只顾逃命
        this.escapeFood = null;
        // 逃跑方向偏好：每个 AI 一份，让它们的走位各不相同
        this.escapePhase = randomFloat(0, Math.PI * 2);
    }

    update(dt, world, balls, foodList) {
        this.thinkTimer -= dt;
        this.wanderTimer -= dt;
        if (this.thinkTimer <= 0) {
            this.thinkTimer = AI.thinkInterval;
            this.think(balls, foodList);
        }
        this.steer(world, balls);
        super.update(dt, world);
    }

    // 挑目标：最近的威胁 / 最近的猎物 / 最近的食物
    think(balls, foodList) {
        // 别的 AI 已经盯上的目标就不抢：不这么做的话一堆 AI 会同时奔向同一个球
        // 或同一颗食物，走成一条线（玩家看着就像"AI 不闪避"）
        const claimedBalls = new Set();
        const claimedFood = new Set();
        for (const other of balls) {
            if (other === this || !other.alive) {
                continue;
            }
            if (other.targetBall && !other.fleeing) {
                claimedBalls.add(other.targetBall);
            }
            if (other.targetFood) {
                claimedFood.add(other.targetFood);
            }
            if (other.escapeFood) {
                claimedFood.add(other.escapeFood);
            }
        }

        let threat = null;
        let threatDistSq = Infinity;
        let prey = null;
        let preyDistSq = Infinity;
        const fleeRangeSq = AI.fleeRange * AI.fleeRange;
        const chaseRangeSq = AI.chaseRange * AI.chaseRange;

        for (const other of balls) {
            if (other === this || !other.alive) {
                continue;
            }
            // 这里只比大小、不取距离值，用平方距离省掉 sqrt（热循环：球数²每帧）
            const dSq = distanceSq(this.x, this.y, other.x, other.y);
            if (other.outweighs(this)) {
                if (dSq < fleeRangeSq && dSq < threatDistSq) {
                    threat = other;
                    threatDistSq = dSq;
                }
            } else if (this.outweighs(other) && dSq < chaseRangeSq && dSq < preyDistSq && !claimedBalls.has(other)) {
                prey = other;
                preyDistSq = dSq;
            }
        }

        // 最近的食物：不管在不在逃都算一份，逃跑时用来「顺手把路边的吃掉」
        let nearestFood = null;
        let nearestFoodDistSq = Infinity;
        for (const food of foodList) {
            if (claimedFood.has(food)) {
                continue; // 已经有人在路上了
            }
            const dSq = distanceSq(this.x, this.y, food.x, food.y);
            if (dSq < nearestFoodDistSq) {
                nearestFood = food;
                nearestFoodDistSq = dSq;
            }
        }
        // 试过给食物目标加滞后（"已在追的食物没远出 N 倍就不换"），比值纹丝不动
        // （0.860 全档一样），说明 AI 并没有在两个差不多远的食物之间抖。
        // 已回退——没测出收益的复杂度不要留着。

        // 有威胁先跑，命重要
        if (threat) {
            if (threat !== this.targetBall || Math.random() < AI.escapeChange) {
                // 换目标或按概率换一套方向偏好：贴着墙时就能临时改走另一侧
                this.escapePhase = randomFloat(0, Math.PI * 2);
            }
            this.targetBall = threat;
            this.targetFood = null;
            this.fleeing = true;
            // 近处有食物就带上它：逃跑方向会顺便往它那边偏一点
            this.escapeFood = nearestFood && nearestFoodDistSq <= AI.escapeFoodRange * AI.escapeFoodRange
                ? nearestFood
                : null;
            return;
        }
        if (prey) {
            this.targetBall = prey;
            this.targetFood = null;
            this.fleeing = false;
            this.escapeFood = null;
            return;
        }

        this.targetBall = null;
        this.fleeing = false;
        this.escapeFood = null;
        this.targetFood = nearestFood;
    }

    // 逃离方向：从一圈候选方向里挑最优，而不是沿「远离威胁」的直线冲。
    // 打分 = 离威胁更远（加分） - 贴墙（扣分） - 撞向别的球（扣分）
    //        + 绕圈偏置（绕圈拖延，见 orbitBias）
    // 于是空旷处直着跑最快，被逼到墙角时会自动改走斜线而不是撞墙。
    escapeDirection(world, balls) {
        const threat = this.targetBall;
        const samples = AI.escapeSamples;
        const orbit = this.orbitBias(threat);
        // 绕圈偏置要用「远离威胁」这条轴的左手法向，它与候选方向无关，
        // 所以提到循环外算一次（逃跑中的 AI 每帧都会走这段循环）。
        let nx = 0;
        let ny = 0;
        if (orbit !== 0) {
            const awayX = this.x - threat.x;
            const awayY = this.y - threat.y;
            const awayLen = Math.hypot(awayX, awayY) || 1;
            nx = -awayY / awayLen;
            ny = awayX / awayLen;
        }
        let bestDx = 0;
        let bestDy = 0;
        let bestScore = -Infinity;

        for (let i = 0; i < samples; i += 1) {
            const angle = (Math.PI * 2 * i) / samples + this.escapePhase;
            const dx = Math.cos(angle);
            const dy = Math.sin(angle);
            const probeX = this.x + dx * AI.escapeProbe;
            const probeY = this.y + dy * AI.escapeProbe;

            let score = threat ? distance(probeX, probeY, threat.x, threat.y) : 0;

            // 越靠近边界扣分越狠；探出界外会被这条一起重罚
            const clearance = Math.min(probeX, world.width - probeX, probeY, world.height - probeY);
            if (clearance < AI.borderMargin) {
                score -= (AI.borderMargin - clearance) * AI.escapeWallWeight;
            }

            // 别一头扎进别的球
            for (const other of balls) {
                if (other === this || other === threat || !other.alive) {
                    continue;
                }
                const gap = this.r + other.r + AI.escapeBallGap;
                const gapDist = distance(probeX, probeY, other.x, other.y);
                if (gapDist < gap) {
                    score -= (gap - gapDist) * AI.escapeBallWeight;
                }
            }

            // 顺手把路边的食物扫掉：奖励「逃命方向顺便经过食物」的候选，
            // 权重远小于威胁/贴墙项，所以安全永远压过这一口吃的
            if (this.escapeFood) {
                score -= distance(probeX, probeY, this.escapeFood.x, this.escapeFood.y) * AI.escapeFoodWeight;
            }

            // 绕圈拖延：在"离威胁更远"这一项上加一个切向偏置（世界单位），
            // 于是评分函数本身就会挑到斜着跑的那个候选——墙与撞球的惩罚项照常生效，
            // 被逼到墙角时自然退回直退。
            //
            // 为什么是**偏置**而不是把选出来的方向旋转：旋转发生在惩罚项算完之后，
            // 转完可能正对着墙（实测偏转 ≥0.65 强度时被逼墙比例从 0.9% 飙到 4~5%），
            // 而且每个 AI 的绕法会被同一个角度钉死。偏置是让**打分**去挑，
            // 墙的约束一直在，绕不出去就不绕。
            if (orbit !== 0) {
                // 候选方向在切向轴上的投影 = "绕出去的成分"，∈ [-1, 1]
                score += (dx * nx + dy * ny) * orbit;
            }

            if (score > bestScore) {
                bestScore = score;
                bestDx = dx;
                bestDy = dy;
            }
        }

        return { dx: bestDx, dy: bestDy };
    }

    // 绕圈偏置的强度（世界单位）。0 = 不绕（纯径向直退）。
    //
    // 闸门：威胁在 fleeOrbitNear 以内 → 0（贴脸保命，直着跑）；
    // 拉到 fleeRange（也就是刚好开始逃的距离）→ 上满。**满点必须落在 fleeRange 之内**：
    // 上一版把它写成 fleeOrbitRange=240，而 fleeRange 只有 160 ——
    // AI 压根不会逃到那么远，闸门永远打不满，fleeOrbit 是个死参数（白写）。
    //
    // 绕左还是绕右由 escapePhase 决定——它本来就随 escapeChange 换，
    // 于是每个 AI、每次换偏好都是一个不同的绕法（否则场上会一片同手同脚）。
    // fleeOrbitReach 与 escapeSamples 耦合：相邻候选方向的弦长
    // = 2 × escapeProbe × sin(π/escapeSamples)，16 个样本时约 70 单位，
    // 偏置落在同一量级才不会压过「离威胁更远」那一项、或小到根本选不出来。
    orbitBias(threat) {
        if (!threat || AI.fleeOrbit <= 0) {
            return 0;
        }
        const near = Math.min(AI.fleeOrbitNear, AI.fleeRange * 0.9);
        const gap = distance(this.x, this.y, threat.x, threat.y);
        const k = clamp((gap - near) / Math.max(1, AI.fleeRange - near), 0, 1);
        const side = Math.cos(this.escapePhase) >= 0 ? 1 : -1;
        return side * AI.fleeOrbit * AI.fleeOrbitReach * k;
    }

    // 与其他球保持距离：逃跑之外的模式（觅食/追击/游走）也要避让，
    // 否则几个 AI 会贴着走同一条线，看起来像"不会闪避"。
    // ignore 传当前威胁——逃跑时 escapeDirection 已经把威胁算过一次，重复叠加会
    // 让猎物过分灵活、玩家根本追不上。
    separation(balls, ignore) {
        let sx = 0;
        let sy = 0;
        for (const other of balls) {
            if (other === this || other === ignore || !other.alive) {
                continue;
            }
            const d = distance(this.x, this.y, other.x, other.y);
            const want = this.r + other.r + AI.avoidGap;
            if (d > 0.001 && d < want) {
                const push = (want - d) / want;
                sx += ((this.x - other.x) / d) * push;
                sy += ((this.y - other.y) / d) * push;
            }
        }
        return { x: sx * AI.avoidWeight, y: sy * AI.avoidWeight };
    }

    // 把当前目标换算成方向：朝目标走，同时躲开边界与其他球，最后写进 speedX/speedY
    steer(world, balls) {
        let dx = 0;
        let dy = 0;

        if (this.fleeing && this.targetBall) {
            const escape = this.escapeDirection(world, balls);
            dx = escape.dx;
            dy = escape.dy;
        } else if (this.targetBall) {
            // 瞄猎物前方一点，别永远追在屁股后面
            dx = (this.targetBall.x + this.targetBall.speedX * AI.chaseLead) - this.x;
            dy = (this.targetBall.y + this.targetBall.speedY * AI.chaseLead) - this.y;
        } else if (this.targetFood) {
            dx = this.targetFood.x - this.x;
            dy = this.targetFood.y - this.y;
        }

        // 没有目标就随机游走
        if (!this.targetBall && !this.targetFood) {
            if (this.wanderTimer <= 0) {
                this.wanderTimer = AI.wanderInterval;
                this.wanderAngle = randomFloat(0, Math.PI * 2);
            }
            dx += Math.cos(this.wanderAngle) * 0.6;
            dy += Math.sin(this.wanderAngle) * 0.6;
        }

        // 边界躲避：贴边时按接近程度往回拉，别把自己顶在边界上
        const m = AI.borderMargin;
        if (this.x < m) {
            dx += ((m - this.x) / m) * 1.5;
        } else if (this.x > world.width - m) {
            dx -= ((this.x - (world.width - m)) / m) * 1.5;
        }
        if (this.y < m) {
            dy += ((m - this.y) / m) * 1.5;
        } else if (this.y > world.height - m) {
            dy -= ((this.y - (world.height - m)) / m) * 1.5;
        }

        // 避让其他球：所有模式都生效（逃跑模式里 escapeDirection 已经算过一次，
        // 这里只是再叠一层近距离的推开，不会冲突）
        const sep = this.separation(balls, this.fleeing ? this.targetBall : null);
        dx += sep.x;
        dy += sep.y;

        const len = distance(dx, dy, 0, 0);
        if (len < 0.0001) {
            dx = Math.cos(this.wanderAngle);
            dy = Math.sin(this.wanderAngle);
        } else {
            dx /= len;
            dy /= len;
        }

        // 逃跑时全速；其他模式（觅食/追击/游走）叠一层 AI.foragePower。
    // 两者相乘就是 AI 相对满舵的实际功率，见 config.js 里的说明。
    const power = JOYSTICK.radius * AI.speedScale * (this.fleeing ? 1 : AI.foragePower);
        this.speedX = dx * power;
        this.speedY = dy * power;
    }
}