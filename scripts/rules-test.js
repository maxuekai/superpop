// 玩法规则检查（无 DOM）：吃食物判定、大小互吃规则、质量吸收、AI 决策方向、速度随体型衰减。
// 依赖 Ball / AiPlayer 是纯逻辑（不触碰 document），所以可以直接在 node 里跑。
import assert from 'node:assert/strict';

import { AI, EAT, FOOD, JOYSTICK, NAMES, PLAYER, SPLIT } from '../src/config.js';
import { AiPlayer } from '../src/core/ai.js';
import { Ball } from '../src/core/ball.js';
import { Camera } from '../src/core/camera.js';
import { Player } from '../src/core/player.js';
import {
    canSplit,
    dueRespawns,
    excessToRemove,
    groupMass,
    isOutsideView,
    isSpawnClear,
    leaderboardEntries,
    mergeCells,
    pickFreeName,
    rankOfGroup,
    resolveEatings,
    resolveFoodEating,
    resolveOverlaps,
    splitCells,
    targetAiCount,
} from '../src/core/rules.js';
import { clusterOffset } from '../src/core/utils.js';
import { Joystick } from '../src/input/joystick.js';
import { Keyboard } from '../src/input/keyboard.js';

const STEP = 1 / 60;
const WORLD = { width: 1024, height: 768 };

const tests = [];

function test(name, fn) {
    tests.push([name, fn]);
}

function ball(x, y, r, name = 'x') {
    return new Ball(x, y, r, '#fff', name);
}

// ---------- 吃食物 ----------

test('canEatFood：圆心距 ≤ 半径 + 食物半径', () => {
    const b = ball(100, 100, PLAYER.radius);
    const reach = PLAYER.radius + FOOD.radius;
    assert.equal(b.canEatFood(100 + reach, 100), true);
    assert.equal(b.canEatFood(100 + reach + 1, 100), false);
    assert.equal(b.canEatFood(100, 100 - reach), true);
});

// ---------- 大小互吃 ----------

test('outweighs 受 EAT.ratio 阈值约束', () => {
    const big = ball(0, 0, 20);
    const mid = ball(0, 0, 20 / EAT.ratio + 0.5);
    const small = ball(0, 0, 10);
    assert.equal(big.outweighs(small), true);
    assert.equal(small.outweighs(big), false);
    // 体型接近时谁也吃不掉谁
    assert.equal(big.outweighs(mid), false);
    assert.equal(mid.outweighs(big), false);
});

test('canEatBall：尺寸够 + 两个圆有重叠就吃（碰到边缘即死）', () => {
    const big = ball(100, 100, 20);
    const touch = ball(100 + 30, 100, 10); // 中心距 30 = 半径和，刚好接触
    const overlap = ball(100 + 19, 100, 10); // 明显重叠
    const justOutside = ball(100 + 30.01, 100, 10);
    assert.equal(big.canEatBall(overlap), true);
    assert.equal(big.canEatBall(touch), true, '碰到边缘就该吃掉，不要求圆心进入体内');
    assert.equal(big.canEatBall(justOutside), false);
});

test('canEatBall：擦边而过不会被吃（两圆不重叠就不吃）', () => {
    const big = ball(400, 384, 22, '大球');
    const small = ball(400, 384 + 31.9, 10, '小球'); // 最近距 31.9 < 半径和 32
    assert.equal(big.canEatBall(small), true, '31.9 < 32，已经碰到了');
    const graze = ball(400, 384 + 32.1, 10, '擦过');
    assert.equal(big.canEatBall(graze), false, '32.1 > 32，没碰到');
});

test('absorb：质量按 r² 累加后开方', () => {
    const eater = ball(0, 0, 20);
    const victim = ball(0, 0, 10);
    eater.absorb(victim);
    const expected = Math.sqrt(20 * 20 + 10 * 10 * EAT.absorb);
    assert.ok(Math.abs(eater.r - expected) < 1e-9, `实际 ${eater.r}，期望 ${expected}`);
    assert.ok(eater.r > 20, '吃完应该变大');
});

// ---------- 移动 ----------

test('移动量与 dt 成正比：半步长走一半距离', () => {
    const a = ball(500, 500, PLAYER.radius);
    const b = ball(500, 500, PLAYER.radius);
    a.speedX = JOYSTICK.radius;
    a.update(STEP, WORLD);
    b.speedX = JOYSTICK.radius;
    b.update(STEP / 2, WORLD);
    assert.ok(Math.abs((a.x - 500) - (b.x - 500) * 2) < 1e-9);
});

test('越大越慢：同满舵时大球位移更小', () => {
    const small = ball(500, 500, PLAYER.radius);
    const large = ball(500, 500, PLAYER.radius * 4);
    small.speedX = JOYSTICK.radius;
    large.speedX = JOYSTICK.radius;
    small.update(STEP, WORLD);
    large.update(STEP, WORLD);
    assert.ok((large.x - 500) < (small.x - 500));
});

test('边界钳制：圆心至少离边缘一个半径', () => {
    const b = ball(500, 500, PLAYER.radius);
    b.speedX = -JOYSTICK.radius * 10;
    b.speedY = -JOYSTICK.radius * 10;
    for (let i = 0; i < 600; i += 1) {
        b.update(STEP, WORLD);
    }
    assert.equal(b.x, PLAYER.radius);
    assert.equal(b.y, PLAYER.radius);
});

// ---------- AI 决策 ----------

function ai(x, y, r) {
    return new AiPlayer(x, y, r, '#fff', 'ai');
}

test('AI 会追击比自己小的球', () => {
    const predator = ai(300, 300, 20);
    const prey = ball(400, 300, 10, 'prey');
    const world = { width: WORLD.width, height: WORLD.height };
    predator.update(STEP, world, [predator, prey], []);
    assert.ok(predator.speedX > 0, `应该向右追，实际 speedX=${predator.speedX}`);
    const before = predator.x;
    predator.update(STEP, world, [predator, prey], []);
    assert.ok(predator.x > before, '应该靠近猎物');
});

test('AI 会逃离比自己大的球', () => {
    const prey = ai(300, 300, 10);
    const threat = ball(400, 300, 30, 'boss');
    const world = { width: WORLD.width, height: WORLD.height };
    prey.update(STEP, world, [prey, threat], []);
    assert.ok(prey.speedX < 0, `应该向左逃，实际 speedX=${prey.speedX}`);
});

test('AI 威胁优先于猎物：附近有大球就不去追小球', () => {
    const mid = ai(300, 300, 14);
    const prey = ball(320, 300, 10, 'prey');
    const threat = ball(380, 300, 40, 'boss');
    const world = { width: WORLD.width, height: WORLD.height };
    mid.update(STEP, world, [mid, prey, threat], []);
    assert.ok(mid.speedX < 0, '应该先逃命而不是追猎物');
});

test('AI 被逼到墙边时不会往墙上冲（换哪一侧偏好都一样）', () => {
    // 威胁在左边、球贴着右边墙：沿「远离威胁」直线跑就等于往墙上撞。
    // escapePhase 是随机的，所以这里反复抽样，检验的是「永不撞墙」这个不变量。
    const world = { width: WORLD.width, height: WORLD.height };
    const threat = ball(945, 400, 30, 'boss');
    let diagonal = 0;
    for (let i = 0; i < 24; i += 1) {
        const cornered = ai(985, 400, 10);
        cornered.think([cornered, threat], []);
        cornered.steer(world, [cornered, threat]);
        assert.ok(cornered.speedX < 20, `第 ${i} 次不该往右墙冲，实际 speedX=${cornered.speedX}`);
        assert.ok(cornered.x <= 985.001, '不该被墙顶出去');
        if (Math.abs(cornered.speedY) > 20) {
            diagonal += 1;
        }
    }
    // 直着往左（远离墙）同样是合法选择，所以只要求「多数情况下带一点斜向分量」
    assert.ok(diagonal >= 10, `多数情况下应该斜着逃，只有 ${diagonal}/24 次`);
});

test('AI 贴角被围时会往内侧跑', () => {
    const world = { width: WORLD.width, height: WORLD.height };
    const cornered = ai(1005, 15, 10);
    const threat = ball(985, 30, 30, 'boss');
    for (let i = 0; i < 12; i += 1) {
        cornered.think([cornered, threat], []);
        cornered.steer(world, [cornered, threat]);
        assert.ok(cornered.speedY > -5, `不该继续往顶边冲，实际 speedY=${cornered.speedY}`);
        assert.ok(cornered.speedX < 5, `不该继续往右墙冲，实际 speedX=${cornered.speedX}`);
    }
});

test('AI 空旷处仍然直着远离威胁（不会无谓乱抖）', () => {
    const prey = ai(512, 384, 10);
    const threat = ball(432, 384, 30, 'boss');
    const world = { width: WORLD.width, height: WORLD.height };
    prey.update(STEP, world, [prey, threat], []);
    assert.ok(prey.speedX > 50, `应该干脆地往右跑，实际 speedX=${prey.speedX}`);
    assert.ok(Math.abs(prey.speedY) < 15, `不该上下乱晃，实际 speedY=${prey.speedY}`);
});

test('AI 逃跑时会顺手挑附近最近的食物，超出范围就不理', () => {
    const prey = ai(500, 380, 10);
    const threat = ball(500, 460, 30, 'boss');
    const world = { width: WORLD.width, height: WORLD.height };

    // 逃跑中，范围内的食物会被记下来当「顺手目标」
    const closeFood = { x: 540, y: 320 };
    prey.think([prey, threat], [closeFood]);
    assert.equal(prey.fleeing, true);
    assert.equal(prey.escapeFood, closeFood, '近处有食物应该顺手去吃');

    // 太远就不理（否则会把 AI 往地图另一头拽）
    prey.think([prey, threat], [{ x: 60, y: 60 }]);
    assert.equal(prey.escapeFood, null, '远处食物不该在逃跑时被惦记');

    // 附近有多颗时取最近的那颗（AI 在 500,380：(520,340) 最近，约 45）
    const nearestFood = { x: 520, y: 340 };
    prey.think([prey, threat], [closeFood, nearestFood, { x: 505, y: 300 }]);
    assert.equal(prey.escapeFood, nearestFood, '应该挑最近的食物');
});

test('AI 逃跑时吃食物不会压过安全：仍然远离威胁', () => {
    // 食物摆在威胁方向上，AI 也不该掉头往威胁那边跑
    const prey = ai(500, 300, 10);
    const threat = ball(500, 420, 30, 'boss');
    const towardThreat = { x: 500, y: 360 };
    const world = { width: WORLD.width, height: WORLD.height };
    prey.think([prey, threat], [towardThreat]);
    prey.steer(world, [prey, threat]);
    assert.ok(prey.speedY < 0, `应该继续往上逃，不能为食物掉头，实际 speedY=${prey.speedY}`);
});

test('AI 不在逃跑时也会去吃最近的食物', () => {
    const lonely = ai(300, 300, 12);
    const food = { x: 340, y: 300 };
    const world = { width: WORLD.width, height: WORLD.height };
    lonely.update(STEP, world, [lonely], [food]);
    assert.ok(lonely.speedX > 0, '应该朝食物方向走');
});

test('AI 贴边时会往回躲', () => {
    const edge = ai(30, 400, 12);
    const world = { width: WORLD.width, height: WORLD.height };
    edge.update(STEP, world, [edge], []);
    assert.ok(edge.speedX > 0, `应该远离左边界，实际 speedX=${edge.speedX}`);
});

test('AI 速度不超过摇杆满舵', () => {
    const hunter = ai(300, 300, 12);
    const food = { x: 900, y: 300 };
    hunter.update(STEP, { width: WORLD.width, height: WORLD.height }, [hunter], [food]);
    const power = Math.hypot(hunter.speedX, hunter.speedY);
    assert.ok(power <= JOYSTICK.radius + 1e-9, `满舵上限 ${JOYSTICK.radius}，实际 ${power}`);
    assert.ok(power > JOYSTICK.radius * AI.speedScale * 0.5);
});

// ---------- 成簇食物 ----------

test('clusterOffset：偏移落在簇半径内，且方向是散开的', () => {
    for (let i = 0; i < 200; i += 1) {
        const offset = clusterOffset(FOOD.clusterRadius);
        assert.ok(Math.abs(offset.dx) <= FOOD.clusterRadius + 1e-9, 'x 偏移不能超出簇半径');
        assert.ok(Math.abs(offset.dy) <= FOOD.clusterRadius + 1e-9, 'y 偏移不能超出簇半径');
    }
    // 200 次采样应该铺开一小片，而不是全挤在同一个点
    const spread = new Set();
    for (let i = 0; i < 200; i += 1) {
        const offset = clusterOffset(FOOD.clusterRadius);
        spread.add(`${Math.round(offset.dx / 5)},${Math.round(offset.dy / 5)}`);
    }
    assert.ok(spread.size > 30, `簇内应该散开，实际只占了 ${spread.size} 个格子`);
});

test('进食判定：食物变大后更容易吃到', () => {
    const b = ball(100, 100, PLAYER.radius);
    const reach = PLAYER.radius + FOOD.radius;
    assert.equal(b.canEatFood(100 + reach, 100), true);
    assert.equal(b.canEatFood(100 + reach + 1, 100), false);
});

// ---------- 键盘输入 ----------

function fakeTarget() {
    const listeners = {};
    return {
        listeners,
        addEventListener(type, fn) {
            (listeners[type] = listeners[type] || []).push(fn);
        },
        removeEventListener(type, fn) {
            listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
        },
        fire(type, event) {
            for (const fn of listeners[type] || []) {
                fn(event);
            }
        },
    };
}

function keyEvent(code, target) {
    return { code, target, preventDefault() { this.prevented = true; }, prevented: false };
}

test('键盘：WASD/方向键都能驱动方向，力度等于摇杆满舵', () => {
    const player = ball(500, 500, PLAYER.radius);
    const target = fakeTarget();
    const keyboard = new Keyboard(target, player);
    keyboard.enable();

    target.fire('keydown', keyEvent('KeyD', target));
    assert.ok(player.speedX > 0, '按 D 应该向右');
    assert.equal(player.speedY, 0);
    assert.ok(Math.abs(Math.hypot(player.speedX, player.speedY) - JOYSTICK.radius) < 1e-9, '力度应等于满舵');

    // 换成方向键同样有效
    target.fire('keyup', keyEvent('KeyD', target));
    assert.equal(player.speedX, 0);
    target.fire('keydown', keyEvent('ArrowLeft', target));
    assert.ok(player.speedX < 0, '方向键也应该有效');

    target.fire('keyup', keyEvent('ArrowLeft', target));
    assert.equal(player.speedX, 0);
});

test('键盘：斜向自动归一化（斜着不比直着快）', () => {
    const player = ball(500, 500, PLAYER.radius);
    const target = fakeTarget();
    const keyboard = new Keyboard(target, player);
    keyboard.enable();

    target.fire('keydown', keyEvent('KeyW', target));
    target.fire('keydown', keyEvent('KeyD', target));
    const diagonal = Math.hypot(player.speedX, player.speedY);
    assert.ok(Math.abs(diagonal - JOYSTICK.radius) < 1e-9, `斜向速度应等于满舵，实际 ${diagonal}`);
    assert.ok(Math.abs(player.speedX - JOYSTICK.radius / Math.SQRT2) < 1e-9);
    assert.ok(Math.abs(player.speedY + JOYSTICK.radius / Math.SQRT2) < 1e-9);
});

test('键盘：抬起一个键还按着另一个时方向跟着变', () => {
    const player = ball(500, 500, PLAYER.radius);
    const target = fakeTarget();
    const keyboard = new Keyboard(target, player);
    keyboard.enable();

    target.fire('keydown', keyEvent('KeyD', target));
    target.fire('keydown', keyEvent('KeyW', target));
    assert.ok(player.speedX > 0 && player.speedY < 0);
    target.fire('keyup', keyEvent('KeyW', target));
    assert.equal(player.speedY, 0, '松开 W 后应该只剩向右');
    assert.ok(player.speedX > 0);
});

test('键盘：在输入框里打字不驱动球', () => {
    const player = ball(500, 500, PLAYER.radius);
    const target = fakeTarget();
    const keyboard = new Keyboard(target, player);
    keyboard.enable();

    // target 命中 .ui-interactive（昵称输入框就在 .ui-interactive 弹层里）
    const input = { closest: (selector) => (selector.includes('input') ? input : null) };
    const event = keyEvent('KeyW', input);
    target.fire('keydown', event);
    assert.equal(player.speedX, 0);
    assert.equal(player.speedY, 0);
    assert.equal(event.prevented, false, '不能拦掉输入框的按键');
});

test('键盘：摇杆正在操控时让位', () => {
    const player = ball(500, 500, PLAYER.radius);
    const target = fakeTarget();
    let blocked = true;
    const keyboard = new Keyboard(target, player, { isBlocked: () => blocked });
    keyboard.enable();

    target.fire('keydown', keyEvent('KeyD', target));
    assert.equal(player.speedX, 0, '摇杆在用时键盘不该抢');

    blocked = false;
    keyboard.apply();
    assert.ok(player.speedX > 0, '摇杆松手后键盘恢复生效');
});

test('键盘：窗口失焦时松开所有键，避免卡住一直走', () => {
    const player = ball(500, 500, PLAYER.radius);
    const target = fakeTarget();
    const keyboard = new Keyboard(target, player);
    keyboard.enable();

    target.fire('keydown', keyEvent('KeyW', target));
    assert.ok(player.speedY < 0);
    target.fire('blur', {});
    assert.equal(player.speedY, 0);
    assert.equal(player.speedX, 0);
});

test('键盘：切到后台标签页也松开所有键（此时 keyup 可能已经丢了）', () => {
    const player = ball(500, 500, PLAYER.radius);
    const target = fakeTarget();
    target.hidden = true; // document 级别的 hidden
    const keyboard = new Keyboard(target, player);
    keyboard.enable();

    target.fire('keydown', keyEvent('KeyA', target));
    assert.ok(player.speedX < 0);
    target.fire('visibilitychange', {});
    assert.equal(player.speedX, 0, '丢掉的 keyup 不能让球一直跑');
});

// ---------- 整局裁定（rules.js） ----------

test('互吃裁定：大的吃小的，被吃者死亡、质量并入吃者', () => {
    const big = ball(500, 500, 30, 'big');
    const small = ball(500, 500, 10, 'small');
    const { victims, eaten } = resolveEatings([big, small], 0);
    assert.deepEqual(victims, [small]);
    assert.equal(small.alive, false);
    assert.equal(eaten.get(big), 1);
    assert.ok(big.r > 30, '吃者应该变大');
});

test('互吃裁定：被吃掉的球这一帧不会再吃到别人（与数组顺序无关）', () => {
    // f(100) 能吃 e(50)；e(50) 也能吃 p(10)。无论数组顺序如何，
    // e 既然被 f 吃掉，就不该在这一帧再去吃 p——否则链式互吞会让同一局重放结果不同。
    const orderings = [
        [ball(100, 100, 50, 'e'), ball(100, 100, 10, 'p'), ball(100, 100, 100, 'f')],
        [ball(100, 100, 100, 'f'), ball(100, 100, 50, 'e'), ball(100, 100, 10, 'p')],
    ];
    for (const balls of orderings) {
        const names = balls.map((x) => x.name);
        const { victims, eaten } = resolveEatings(balls, 0);
        assert.deepEqual(victims.map((v) => v.name).sort(), ['e', 'p']);
        assert.equal(eaten.has(balls[names.indexOf('e')]), false, '被吃的球不能再当吃人方');
        assert.equal(eaten.get(balls[names.indexOf('f')]), 2, 'f 吃掉两个');
        assert.equal(balls[names.indexOf('p')].alive, false);
    }
});

test('互吃裁定：大球一帧吃掉多个小球是正常的（不算链式互吞）', () => {
    const big = ball(500, 500, 30, 'big');
    const small1 = ball(500, 500, 10, 's1');
    const small2 = ball(500, 500, 8, 's2');
    const { victims, eaten } = resolveEatings([big, small1, small2], 0);
    assert.deepEqual(victims.map((v) => v.name).sort(), ['s1', 's2']);
    assert.equal(eaten.get(big), 2);
});

test('互吃裁定：出生保护期内的球吃不掉', () => {
    const big = ball(500, 500, 30, 'big');
    const shielded = ball(500, 500, 10, 'shielded');
    shielded.grantShield(2.5, 0);
    const { victims } = resolveEatings([big, shielded], 1);
    assert.equal(victims.length, 0, '保护期内不该被吃掉');
    assert.equal(shielded.alive, true);

    // 保护结束后同一位置就该能吃掉了
    const { victims: later } = resolveEatings([big, shielded], 3);
    assert.deepEqual(later, [shielded]);
});

test('互吃裁定：尺寸不够就是吃不掉', () => {
    const mid = ball(500, 500, 11, 'mid'); // 11 > 10×1.15=11.5 不成立
    const small = ball(500, 500, 10, 'small');
    const { victims } = resolveEatings([mid, small], 0);
    assert.equal(victims.length, 0);
});

test('吃食物：按各自的 foodGain 长大（玩家快、AI 慢）', () => {
    const playerBall = ball(500, 500, PLAYER.radius, 'p');
    const aiBall = new AiPlayer(500, 500, PLAYER.radius, '#fff', 'ai');
    aiBall.foodGain = AI.foodGain;
    playerBall.foodGain = PLAYER.growthPerFood;
    const food = [{ x: 500, y: 500 }];
    const { eaten } = resolveFoodEating(food, [playerBall, aiBall], () => ({ x: 0, y: 0 }));
    // 同一颗食物只会被 balls 里第一个能吃到的球吃掉
    assert.equal(eaten.get(playerBall), 1);
    assert.equal(eaten.has(aiBall), false);
    assert.equal(playerBall.r, PLAYER.radius + PLAYER.growthPerFood);
});

test('吃食物：总量恒定（吃掉几颗就补几颗），补的位置来自 makeFood', () => {
    const b = ball(500, 500, 20, 'b');
    const food = [
        { x: 500, y: 500 }, // 在球内 → 被吃
        { x: 500, y: 500 }, // 在球内 → 被吃
        { x: 900, y: 700 }, // 远处 → 保留
    ];
    let spawnIndex = 0;
    const result = resolveFoodEating(food, [b], () => ({ x: 10 + spawnIndex++, y: 20 }));
    assert.equal(result.foodList.length, 3, '总数必须不变');
    // 被吃掉的槽位就地补上新食物，没被吃的位置保持原样（顺序与原数组一致）
    assert.deepEqual(result.foodList[0], { x: 10, y: 20 }, '第一个槽位换成补位食物');
    assert.deepEqual(result.foodList[1], { x: 11, y: 20 }, '第二个槽位换成补位食物');
    assert.equal(result.foodList[2], food[2], '没被吃的原样保留');
    assert.equal(b.r, 20 + PLAYER.growthPerFood * 2);
});

test('吃食物：死亡球吃不到（不会被隔空吃掉）', () => {
    const dead = ball(500, 500, 20, 'dead');
    dead.alive = false;
    const food = [{ x: 500, y: 500 }];
    const result = resolveFoodEating(food, [dead], () => ({ x: 1, y: 1 }));
    assert.equal(result.eaten.size, 0);
    assert.equal(result.foodList[0], food[0], '没被吃掉就不该补位');
});

test('名次：按整组质量比（分身质量之和算一条）', () => {
    // 玩家组质量 = 100+400 = 500
    const heavier1 = ball(0, 0, 30, 'h1'); // 900
    const heavier2 = ball(0, 0, 40, 'h2'); // 1600
    const lighter = ball(0, 0, 8, 'l'); // 64
    const dead = ball(0, 0, 100, 'dead');
    dead.alive = false;
    const cells = [ball(0, 0, 10, 'me'), ball(0, 0, 20, 'me2')];
    // h1(900) 与 h2(1600) 都比 500 重，dead 已死不计 → 第 3 名
    assert.equal(rankOfGroup(groupMass(cells), [heavier1, heavier2, lighter, dead]), 3);
    // 换成很小的组（质量 25）：三个球都压过它 → 第 4 名
    assert.equal(rankOfGroup(25, [heavier1, heavier2, lighter]), 4);
});

test('排行榜：玩家只占一条（按整组质量），AI 各占一条', () => {
    const cells = [ball(0, 0, 10, 'me'), ball(0, 0, 20, 'me2')]; // 合计 500
    const a = ball(0, 0, 20, 'a'); // 400
    const b = ball(0, 0, 5, 'b'); // 25
    const entries = leaderboardEntries(cells, [a, b], 5);
    assert.equal(entries.length, 3, '两个分身不能占两行');
    assert.deepEqual(entries.map((e) => e.name), ['me', 'a', 'b']);
    assert.equal(entries[0].isPlayer, true);
    assert.equal(entries[0].weight, 500);
    assert.equal(entries.filter((e) => e.isPlayer).length, 1);
});

test('AI 数量目标：随玩家体型单调不减，且有上下限', () => {
    const small = targetAiCount(PLAYER.radius);
    const mid = targetAiCount(PLAYER.radius * 4);
    const huge = targetAiCount(PLAYER.radius * 100);
    assert.equal(small, AI.minCount, '开局取下限，避免满屏对手');
    assert.equal(huge, AI.count, '再大也不超过上限');
    assert.ok(mid >= small && mid <= AI.count);
});

test('超编时踢掉最大的那几个', () => {
    const small = ball(0, 0, 10, 's');
    const mid = ball(0, 0, 20, 'm');
    const big = ball(0, 0, 40, 'b');
    const removed = excessToRemove([small, mid, big], 1);
    assert.deepEqual(removed.map((x) => x.name), ['b', 'm'], '按半径从大到小踢');
    assert.equal(excessToRemove([small], 1).length, 0, '没超编就不踢');
});

test('重生：到点才重生，被永久移除的（respawnAt=Infinity）不重生', () => {
    const ai1 = new AiPlayer(0, 0, 10, '#fff', 'ai1');
    const ai2 = new AiPlayer(0, 0, 10, '#fff', 'ai2');
    const ai3 = new AiPlayer(0, 0, 10, '#fff', 'ai3');
    ai1.alive = false; ai1.respawnAt = 5;
    ai2.alive = false; ai2.respawnAt = 1;
    ai3.alive = false; ai3.respawnAt = Infinity; // 超编被永久移除
    ai1.alive = true; // 存活的也不该被算进去
    assert.deepEqual(dueRespawns([ai1, ai2, ai3], 1).map((x) => x.name), ['ai2']);
    assert.deepEqual(dueRespawns([ai1, ai2, ai3], 9).map((x) => x.name), ['ai2']);
});

test('出生点判定：附近有更大的球就不安全', () => {
    const big = ball(500, 500, 40, 'big');
    const near = { x: 520, y: 500 };
    const far = { x: 900, y: 700 };
    assert.equal(isSpawnClear(near, PLAYER.radius, [big]), false, '贴着大球出生不安全');
    assert.equal(isSpawnClear(far, PLAYER.radius, [big]), true, '空旷处安全');
    big.alive = false;
    assert.equal(isSpawnClear(near, PLAYER.radius, [big]), true, '死球不构成威胁');
});

// ---------- 分裂 / 合并 ----------

function cell(x, y, r, name) {
    return new Player(name); // Player 天然属于同一 owner 组
}

// 造细胞时手动摆好位置与半径（Player 构造默认在原点）
function makeCell(x, y, r, name) {
    const c = cell(x, y, r, name);
    c.x = x;
    c.y = y;
    c.r = r;
    return c;
}

test('分裂：质量守恒（切开的两半合起来还是原来的质量）', () => {
    const big = makeCell(500, 500, 30, 'me');
    const before = groupMass([big]);
    const cells = splitCells([big], 0, 70, (x, y, r) => {
        const c = makeCell(x, y, r, 'me');
        return c;
    });
    assert.equal(cells.length, 2, '原球自己变成一半，另一半是新球');
    const after = groupMass(cells);
    assert.ok(Math.abs(after - before) < 1e-6, `质量应守恒：${before} → ${after}`);
    // 两半半径相同，且各自约等于原来的 1/√2
    assert.equal(cells[0].r, cells[1].r);
    assert.ok(Math.abs(cells[0].r - Math.sqrt(before / 2)) < 1e-6);
});

test('分裂：太小的球不会被切开', () => {
    const small = makeCell(500, 500, 5, 'me');
    const cells = splitCells([small], 0, 70, (x, y, r) => makeCell(x, y, r, 'me'));
    assert.equal(cells.length, 1, '小于阈值就分不了');
});

test('分裂：分开的两个半球是垂直于移动方向的（不会叠在一起）', () => {
    const big = makeCell(500, 500, 30, 'me');
    // 朝右走 → 两半应该上下分开（垂直于前进方向），这样不会挡住去路
    const cells = splitCells([big], 70, 0, (x, y, r) => makeCell(x, y, r, 'me'));
    assert.equal(cells.length, 2);
    const [origin, other] = cells;
    assert.equal(origin, big, '原来的对象要保留（镜头/重生逻辑指着它）');
    assert.ok(Math.abs(other.y - origin.y) > 1, '上下应该分开');
    assert.ok(Math.abs(other.x - origin.x) < 1e-6, '横向不该动（沿前进方向排开）');
});

test('分裂：同一 owner 的分身之间不能互吃', () => {
    const a = makeCell(500, 500, 30, 'me');
    const b = makeCell(500, 500, 10, 'me2');
    assert.equal(b.ownerId, a.ownerId, '分身共用 ownerId');
    assert.equal(a.canEatBall(b), false, '大分身不能吃掉小分身');
    const { victims } = resolveEatings([a, b], 0);
    assert.equal(victims.length, 0);
});

test('分裂：两半初始距离够远，不叠在一起、也不会自动粘回', () => {
    // 真机反馈："分裂也没有分裂多远，还是很近" —— 原来 gap 按【原半径】算，
    // 切完的两半中心距只有半径和的一半，视觉上直接重叠，而且小于合并阈值，
    // mergeCooldown 一到就被吸回一个球。
    const r = SPLIT.minCellRadius;
    const big = makeCell(500, 500, r, 'me');
    const cells = splitCells([big], 70, 0, (x, y, rr) => makeCell(x, y, rr, 'me'));
    const [origin, other] = cells;
    const gap = Math.hypot(other.x - origin.x, other.y - origin.y);
    const sumR = origin.r + other.r;
    assert.ok(gap > sumR, `两半不能重叠：中心距 ${gap.toFixed(1)} 应大于半径和 ${sumR.toFixed(1)}`);
    // 初始距离必须已经超过合并阈值，否则冷却一过就粘回去（= "按了没反应"）
    const mergeAt = sumR * SPLIT.mergeFactor;
    assert.ok(gap > mergeAt, `不该自动粘回：中心距 ${gap.toFixed(1)} 应大于合并阈值 ${mergeAt.toFixed(1)}`);
});

test('分裂：切开会朝外弹一下再停下（看得见"裂开"而不是"变胖"）', () => {
    const big = ball(500, 500, 30, 'me');
    const cells = splitCells([big], 0, 70, (x, y, r) => ball(x, y, r, 'me'));
    for (const cell of cells) {
        assert.ok(cell.pushLeft > 0, '两半都该带一段外冲速度');
    }
    // 朝下走 → 分开方向是水平（x 轴） → 外冲也应该是 ±x
    const [origin, other] = cells;
    assert.ok(origin.splitVx * other.splitVx < 0, '两半朝相反方向弹开');
    assert.ok(Math.abs(origin.splitVx) > 1, '外冲速度不能是 0');
    assert.ok(Math.abs(origin.splitVy) < 1e-6, '外冲垂直于移动方向');

    // 弹到一半距离应该明显拉开，衰减完后不再移动
    const distAt = (seconds) => {
        const [a, b] = cells;
        const ax = a.x;
        const bx = b.x;
        for (let i = 0; i < Math.round(seconds / STEP); i += 1) {
            a.update(STEP, WORLD);
            b.update(STEP, WORLD);
        }
        return { before: Math.abs(bx - ax), after: Math.abs(b.x - a.x), a, b };
    };
    const mid = distAt(SPLIT.pushTime / 2);
    assert.ok(mid.after > mid.before * 1.1, '外冲期间两半应该继续拉开');

    // 跑完 pushTime + 余量，速度归零、位置不再变化
    const a = cells[0];
    const b = cells[1];
    for (let i = 0; i < 60; i += 1) {
        a.update(STEP, WORLD);
        b.update(STEP, WORLD);
    }
    const frozenX = a.x;
    const frozenB = b.x;
    for (let i = 0; i < 30; i += 1) {
        a.update(STEP, WORLD);
        b.update(STEP, WORLD);
    }
    assert.equal(a.splitVx, 0, '外冲应当衰减到 0，不能留下永久漂移');
    assert.equal(a.x, frozenX, '外冲结束后两半不该继续自己分开');
    assert.equal(b.x, frozenB);
});

test('分裂：外冲结束后两半并行保持间距（不会一路拉到天边）', () => {
    const big = ball(500, 500, 30, 'me');
    // 朝右走 → 分开方向是垂直方向（y 轴），所以间距要看 y 差
    const cells = splitCells([big], 70, 0, (x, y, r) => ball(x, y, r, 'me'));
    for (const cell of cells) {
        cell.speedX = 70;
        cell.speedY = 0;
    }
    const gapNow = () => Math.abs(cells[1].y - cells[0].y);
    const startDist = gapNow();
    assert.ok(startDist > cells[0].r * 2, `初始就要分开：${startDist.toFixed(1)}`);

    // 跑完整个外冲窗口
    for (let i = 0; i < Math.round(SPLIT.pushTime / STEP) + 10; i += 1) {
        for (const cell of cells) {
            cell.update(STEP, WORLD);
        }
    }
    const afterPush = gapNow();
    assert.ok(afterPush > startDist * 1.5, `外冲应当把两半明显拉开：${startDist.toFixed(1)} → ${afterPush.toFixed(1)}`);

    // 再跑 5 秒：外冲已经衰减完，距离必须停住
    for (let i = 0; i < 300; i += 1) {
        for (const cell of cells) {
            cell.update(STEP, WORLD);
        }
    }
    assert.ok(Math.abs(gapNow() - afterPush) < 0.01, `并行后距离应稳定：${afterPush.toFixed(1)} → ${gapNow().toFixed(1)}`);
    assert.ok(cells[0].x > 500 && cells[1].x > 500, '两半都朝前进方向移动');
});

test('分裂：不同 owner 仍然照常互吃（AI 之间不受影响）', () => {
    const playerCell = makeCell(500, 500, 30, 'me');
    const aiBall = ball(500, 500, 10, 'ai');
    assert.notEqual(aiBall.ownerId, playerCell.ownerId);
    const { victims } = resolveEatings([playerCell, aiBall], 0);
    assert.deepEqual(victims, [aiBall]);
});

test('能不能分裂：够大 + 冷却结束 + 不超上限', () => {
    const small = [makeCell(0, 0, 5, 'me')];
    assert.equal(canSplit(small, 100, 0), false, '太小不能分');

    const big = [makeCell(0, 0, 30, 'me')];
    assert.equal(canSplit(big, 100, 0), true, '够大且冷却结束');
    assert.equal(canSplit(big, 100, 99), false, '冷却中不能分');

    const many = [];
    for (let i = 0; i < SPLIT.maxCells; i += 1) {
        many.push(makeCell(i * 100, 0, 30, 'me'));
    }
    assert.equal(canSplit(many, 100, 0), false, '超过细胞数上限就不能再分');
});

test('合并：同一 owner 的细胞靠拢后并回一个（质量守恒）', () => {
    const a = makeCell(500, 500, 20, 'me');
    const b = makeCell(500, 505, 20, 'me2'); // 几乎贴住
    const before = groupMass([a, b]);
    const result = mergeCells([a, b], 100);
    assert.equal(result.merged, 1);
    assert.equal(result.cells.length, 1);
    assert.ok(Math.abs(groupMass(result.cells) - before) < 1e-6, '合并不能丢质量');
    assert.ok(Math.abs(result.cells[0].r - Math.sqrt(before)) < 1e-6);
});

test('合并：冷却期内不合并（防止刚切开就粘回去）', () => {
    const a = makeCell(500, 500, 20, 'me');
    const b = makeCell(500, 503, 20, 'me2');
    a.mergeAfter = 103;
    b.mergeAfter = 103;
    const result = mergeCells([a, b], 100);
    assert.equal(result.merged, 0, '合并冷却没到不能合');
    assert.equal(result.cells.length, 2);
    const later = mergeCells([a, b], 200);
    assert.equal(later.merged, 1, '冷却过了就合');
});

test('合并：离得远的、不同 owner 的都不合', () => {
    const a = makeCell(500, 500, 20, 'me');
    const far = makeCell(900, 500, 20, 'me2');
    const other = ball(500, 500, 20, 'ai'); // 别人的球（独立 owner）贴上来
    assert.equal(mergeCells([a, far], 100).merged, 0, '离得远不合并');
    assert.equal(mergeCells([a, other], 100).merged, 0, '别人的球不能和我合并');
});

// ---------- 浮动摇杆（touch） ----------

function touchEvent(type, id, x, y, changedOnly = true) {
    const t = { identifier: id, clientX: x, clientY: y };
    return {
        type,
        target: null,
        changedTouches: [t],
        touches: type === 'touchend' ? [] : [t],
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
    };
}

function uiTarget() {
    // 模拟弹层里的按钮：closest('.ui-interactive') 命中
    return { closest: (selector) => (selector.includes('ui-interactive') ? uiTarget() : null) };
}

function fakeJoystick(input) {
    const panel = { style: {}, querySelector: () => ({ style: {} }) };
    panel.ownerDocument = fakeTarget();
    const joystick = new Joystick(panel, input);
    joystick.enable();
    return { joystick, doc: panel.ownerDocument };
}

test('摇杆：按住并拖动 → 把方向写进 input', () => {
    const input = { speedX: 0, speedY: 0 };
    const { joystick, doc } = fakeJoystick(input);
    doc.fire('touchstart', touchEvent('touchstart', 1, 300, 400));
    assert.equal(joystick.isActive, true, '按住时处于操控状态');
    doc.fire('touchmove', touchEvent('touchmove', 1, 340, 430));
    assert.ok(input.speedX > 0, '向右拖 → speedX 为正');
    assert.ok(input.speedY > 0, '向下拖 → speedY 为正');
    assert.ok(Math.abs(distance2(input.speedX, input.speedY) - 50) < 0.001, '位移原样写入（这里正好 40/30）');
});

test('摇杆：超出面板半径时固定在边缘，不会无限增大', () => {
    const input = { speedX: 0, speedY: 0 };
    const { doc } = fakeJoystick(input);
    doc.fire('touchstart', touchEvent('touchstart', 1, 300, 400));
    doc.fire('touchmove', touchEvent('touchmove', 1, 900, 400));
    const speed = distance2(input.speedX, input.speedY);
    assert.ok(Math.abs(speed - JOYSTICK.radius) < 0.001, `应该停在满舵 ${JOYSTICK.radius}，实际 ${speed}`);
});

test('摇杆：死区内的轻微移动不驱动球（防手抖）', () => {
    const input = { speedX: 0, speedY: 0 };
    const { doc } = fakeJoystick(input);
    doc.fire('touchstart', touchEvent('touchstart', 1, 300, 400));
    doc.fire('touchmove', touchEvent('touchmove', 1, 301, 400));
    assert.equal(input.speedX, 0);
    assert.equal(input.speedY, 0);
});

test('摇杆：松手即停，操控状态解除', () => {
    const input = { speedX: 0, speedY: 0 };
    const { joystick, doc } = fakeJoystick(input);
    doc.fire('touchstart', touchEvent('touchstart', 1, 300, 400));
    doc.fire('touchmove', touchEvent('touchmove', 1, 340, 400));
    assert.ok(input.speedX > 0);
    doc.fire('touchend', touchEvent('touchend', 1, 340, 400));
    assert.equal(input.speedX, 0, '松手必须归零');
    assert.equal(input.speedY, 0);
    assert.equal(joystick.isActive, false);
});

test('摇杆：多指只认第一根，后来的手指不抢控', () => {
    const input = { speedX: 0, speedY: 0 };
    const { joystick, doc } = fakeJoystick(input);
    doc.fire('touchstart', touchEvent('touchstart', 1, 300, 400));
    doc.fire('touchmove', touchEvent('touchmove', 1, 340, 400));
    const before = input.speedX;
    // 第二根手指按下应被忽略
    const second = touchEvent('touchstart', 2, 100, 100);
    doc.fire('touchstart', second);
    assert.equal(second.defaultPrevented, false, '被忽略的手指不该被 preventDefault');
    assert.equal(input.speedX, before, '方向仍由第一根手指控制');
    // 第一根抬起才停（抬起第二根不停）
    doc.fire('touchend', touchEvent('touchend', 2, 100, 100));
    assert.equal(joystick.isActive, true, '抬起非操控手指不该停止');
});

test('摇杆：操控中，第二根手指的 touchmove 不被摇杆拦（否则移动中点不到分裂）', () => {
    const input = { speedX: 0, speedY: 0 };
    const { doc } = fakeJoystick(input);
    // 第一根手指在画布上开始操控
    doc.fire('touchstart', touchEvent('touchstart', 1, 300, 400));
    doc.fire('touchmove', touchEvent('touchmove', 1, 340, 400));
    assert.ok(input.speedX > 0, '第一根手指正在操控');

    // 第二根手指按在右下角分裂按钮上并轻微滑动：
    // touches 里两根都在（第一根还按着），但 changedTouches 只有第二根。
    const finger2 = { identifier: 2, clientX: 360, clientY: 620 };
    const move = {
        type: 'touchmove',
        target: null,
        changedTouches: [finger2],
        touches: [finger2, { identifier: 1, clientX: 340, clientY: 400 }],
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
    };
    doc.fire('touchmove', move);
    assert.equal(move.defaultPrevented, false, '第二根手指不能被摇杆 preventDefault，否则按钮点不动');
    assert.ok(input.speedX > 0, '第一根手指仍然正常操控');
});

test('摇杆：界面元素上的触摸不接管、不 preventDefault（否则按钮点不动）', () => {
    const input = { speedX: 0, speedY: 0 };
    const { joystick, doc } = fakeJoystick(input);
    const event = touchEvent('touchstart', 1, 300, 400);
    event.target = uiTarget();
    doc.fire('touchstart', event);
    assert.equal(joystick.isActive, false, '界面上的触摸不该开始操控');
    assert.equal(event.defaultPrevented, false, '不能拦掉界面的点击');
});

function distance2(x, y) {
    return Math.sqrt(x * x + y * y);
}

test('AI 昵称不重名：同屏 AI 不会有两个「芋圆」', () => {
    // 模拟逐个出生：每次都避开当前存活 AI 已占用的名字
    const assigned = [];
    for (let i = 0; i < NAMES.length; i += 1) {
        const name = pickFreeName(assigned, NAMES);
        assert.equal(assigned.includes(name), false, `第 ${i + 1} 个又抽到了已占用的 ${name}`);
        assigned.push(name);
    }
    assert.equal(new Set(assigned).size, NAMES.length, '抽满一轮后每个名字各用一次');
});

test('AI 昵称：名字全被占满时才退回随机（不崩、不返回 undefined）', () => {
    const pool = ['a', 'b'];
    const name = pickFreeName(['a', 'b'], pool);
    assert.ok(pool.includes(name), `应从原池子里退化选取，实际 ${name}`);
});

test('相机：每帧 follow(target) 不带死区也不会把镜头锁死（回归）', () => {
    // Game.update() 的真实顺序：setViewSize() 先设好死区 → follow(target) 不传死区 → update()
    // 早期 follow() 会用 undefined 覆盖死区，导致比较全变 NaN、镜头永不动
    const camera = new Camera(0, 0, 0, 0, 2000, 2000, 0.35);
    const target = ball(300, 300, 10);
    camera.follow(target);
    camera.setViewSize(400, 400);
    camera.follow(target);
    assert.equal(typeof camera.xDeadZone, 'number', '死区不能被写成 undefined');
    assert.ok(camera.xDeadZone > 0);

    camera.follow(target); // 再跟几帧
    camera.follow(target);
    target.x = 700; // 走出死区
    camera.update();
    assert.ok(camera.xView > 0, `球走出死区后镜头必须移动，实际 xView=${camera.xView}`);
});

test('相机死区：球偏离屏幕中心一小段时镜头就开始跟', () => {
    const camera = new Camera(0, 0, 400, 400, 2000, 2000, 0.35);
    const target = ball(0, 0, 10);
    camera.follow(target);
    camera.setViewSize(400, 400);
    // 死区 0.35 → 球在 x=200（正中）附近移动时镜头不动
    target.x = 200;
    camera.update();
    assert.equal(camera.xView, 0, '正中附近不该动');
    // 超出死区后镜头跟上，球保持在距离中心固定的偏移上
    target.x = 400;
    camera.update();
    assert.ok(camera.xView > 0, '球超出死区后镜头必须移动');
    const offsetFromCenter = target.x - (camera.xView + camera.wView / 2);
    assert.ok(offsetFromCenter > 0 && offsetFromCenter < 400 * 0.2,
        `球应留在屏幕中心附近，实际偏移 ${offsetFromCenter.toFixed(1)}`);
});

test('玩家全灭后：排行榜与名次都不许崩（回归：曾导致整页卡死）', () => {
    // 玩家细胞被吃光后 playerCells 是空数组。早期实现读 cells[0].ownerId 会抛
    // TypeError，异常从 Game.loop 抛出后 rAF 链断裂 → 整页卡死。
    const empty = [];
    const ai1 = ball(0, 0, 20, 'ai1');
    const ai2 = ball(0, 0, 10, 'ai2');
    let entries = null;
    assert.doesNotThrow(() => { entries = leaderboardEntries(empty, [ai1, ai2], 5); },
        '玩家全灭时算排行榜不能抛异常');
    assert.equal(entries.length, 2, '只剩 AI 还在榜上');
    assert.equal(entries.some((e) => e.isPlayer), false, '死人不该出现在排行榜里');

    assert.doesNotThrow(() => rankOfGroup(0, [ai1, ai2]), '玩家全灭时算名次不能抛异常');
    assert.equal(rankOfGroup(0, [ai1, ai2]), 3, '质量 0 时排在所有球之后');
});

test('结算名次用死亡瞬间的质量，而不是清空后的 0', () => {
    const heavy = ball(0, 0, 30, 'heavy'); // 900
    const light = ball(0, 0, 8, 'light'); // 64
    const others = [heavy, light];
    // 玩家死前有 500 质量（r=10 + r=20 两个分身）→ 只被 heavy 压过 → 第 2 名
    assert.equal(rankOfGroup(500, others), 2);
    // 错用清空后的 0 就会变成第 3 名
    assert.equal(rankOfGroup(0, others), 3);
});

test('AI 会互相避让：贴着走的两个 AI 会被推开，不走同一条线', () => {
    const world = { width: WORLD.width, height: WORLD.height };
    const a = new AiPlayer(400, 400, 10, '#fff', 'a');
    const b = new AiPlayer(420, 400, 10, '#fff', 'b'); // 相距 20，远小于避让距离
    const before = distance2(a.x, b.x) || 1;
    const sep = a.separation([a, b]);
    const len = Math.sqrt(sep.x * sep.x + sep.y * sep.y);
    assert.ok(len > 0, '贴在一起必须产生排斥方向');
    assert.ok(sep.x < 0, 'b 在右边，a 应该往左躲');
    assert.ok(AI.avoidGap > 0);

    // 逃跑时忽略当前威胁：否则和 escapeDirection 重复叠加，猎物会灵活到追不上
    const threat = new AiPlayer(380, 400, 30, '#fff', 'boss');
    const sep2 = a.separation([a, threat], threat);
    assert.equal(sep2.x, 0, '指定 ignore 的球不参与避让');
});

test('AI 不抢别人已经盯上的目标', () => {
    const food = [{ x: 515, y: 500 }, { x: 505, y: 500 }]; // A 离 other 近，B 离 hungry 近
    const hungry = new AiPlayer(500, 500, 10, '#fff', 'hungry');
    const other = new AiPlayer(520, 500, 10, '#fff', 'other');
    other.think([other, hungry], food);
    assert.equal(other.targetFood, food[0], 'other 应盯上离自己更近的 A');
    hungry.think([hungry, other], food);
    assert.equal(hungry.targetFood, food[1], '应该改吃第二颗，而不是挤同一颗');
});

test('软碰撞：吃不掉彼此的球被挤开，不该穿模叠在一起', () => {
    const a = ball(500, 500, 10, 'a');
    const b = ball(510, 500, 10, 'b'); // 相距 10 < 20，明显重叠
    const before = distance2(a.x - b.x, a.y - b.y);
    assert.ok(before < a.r + b.r, '前置条件：确实重叠');
    resolveOverlaps([a, b]);
    const after = distance2(a.x - b.x, a.y - b.y);
    assert.ok(Math.abs(after - (a.r + b.r)) < 1e-9, `应该刚好推开到接触，实际 ${after.toFixed(2)}`);
    // 各退一半，质量总和不变（只是位置变了）
    assert.ok(Math.abs((a.x - 500) + (b.x - 510)) < 1e-9);
});

test('软碰撞与互吃用同一个阈值（这个不变量保证"撞大球会被吃"而不是卡住）', () => {
    // 吃人阈值与弹开阈值都是 r1+r2，于是"尺寸够吃、又没有保护"的重叠对
    // 一定已经在 resolveEatings 里被吃掉，不可能走到 resolveOverlaps。
    // 曾经两者不一致（吃=圆心进体内 / 弹=半径和），猎物被锁死在半径和上进不去。
    const big = ball(500, 500, 30, '大球');
    const small = ball(535, 500, 10, '小球'); // 中心距 35 < 半径和 40
    const list = [big, small];
    assert.equal(distance2(big.x - small.x, big.y - small.y) <= big.r + small.r, true, '前置：已经重叠');
    resolveEatings(list, 0);
    assert.equal(small.alive, false, '重叠且尺寸够 → 这一步就该被吃掉');
    resolveOverlaps(list, 0);
    assert.equal(list.filter((b) => b.alive).length, 1, '被吃掉的球不再参与弹开');
});

test('软碰撞：被出生保护的猎物仍然弹开（不能让它嵌在大球里）', () => {
    // 保护期内 resolveEatings 不吃，但重叠还在 → 照常弹开，让它能滑走；
    // 否则它会整个嵌在大球里，保护一到期立刻暴毙。
    const big = ball(500, 500, 30, '大球');
    const small = ball(535, 500, 10, '小球');
    small.grantShield(2, 0);
    const pushed = resolveOverlaps([big, small], 1);
    assert.equal(pushed.length, 2, '保护期内那一对仍然要弹开');
    assert.equal(distance2(big.x - small.x, big.y - small.y), 40, '弹回到半径和');
    assert.equal(small.alive, true, '弹开不会误杀');
});

test('软碰撞：同一 owner 的分身不被推开（它们要合并而不是互推）', () => {
    const a = new Player('me');
    const b = new Player('me2');
    a.x = 500; a.y = 500; a.r = 10;
    b.x = 505; b.y = 500; b.r = 10;
    assert.equal(b.ownerId, a.ownerId);
    resolveOverlaps([a, b]);
    assert.equal(b.x, 505, '同族分身位置不应被软碰撞改动');
});

test('软碰撞：不重叠的球不动', () => {
    const a = ball(500, 500, 10, 'a');
    const b = ball(560, 500, 10, 'b');
    resolveOverlaps([a, b]);
    assert.equal(a.x, 500);
    assert.equal(b.x, 560);
});

test('吃人收益倍率：AI 的 eatBonus 让互吃长得更明显', () => {
    const predator = new AiPlayer(500, 500, 20, '#fff', 'ai');
    predator.eatBonus = 1;
    const prey = ball(500, 500, 10, 'prey');
    predator.absorb(prey, predator.eatBonus);
    const plain = Math.sqrt(predator.mass);

    const boosted = new AiPlayer(500, 500, 20, '#fff', 'ai2');
    boosted.eatBonus = 1.5;
    boosted.absorb(ball(500, 500, 10, 'prey2'), boosted.eatBonus);
    assert.ok(boosted.r > plain, `带倍率应该更大：${boosted.r.toFixed(2)} vs ${plain.toFixed(2)}`);
    // 倍率 1 时等于纯公式
    assert.ok(Math.abs(plain - Math.sqrt(400 + 100 * EAT.absorb)) < 1e-9);
});

test('出生点在视口外：避免 AI 在玩家眼前凭空闪现', () => {
    const view = { x: 400, y: 300, w: 900, h: 500 };
    const margin = 90;
    assert.equal(isOutsideView({ x: 500, y: 400 }, view, margin), false, '视口内不算外部');
    assert.equal(isOutsideView({ x: 100, y: 400 }, view, margin), true, '左侧外部');
    assert.equal(isOutsideView({ x: 1400, y: 400 }, view, margin), true, '右侧外部');
    assert.equal(isOutsideView({ x: 500, y: 950 }, view, margin), true, '下方外部');
    assert.equal(isOutsideView({ x: 500, y: 850 }, view, margin), false, '边缘余量内仍算视口内');
    // 视口未初始化时不限制
    assert.equal(isOutsideView({ x: 0, y: 0 }, { x: 0, y: 0, w: 0, h: 0 }, margin), true);
});

// ---------- 出生保护 ----------

test('出生保护：保护期内 isProtected 为真，到期后失效', () => {
    const b = ball(0, 0, 10);
    assert.equal(b.isProtected(10), false, '默认没有保护');
    b.grantShield(2.5, 10);
    assert.equal(b.isProtected(10.1), true);
    assert.equal(b.isProtected(12.4), true);
    assert.equal(b.isProtected(12.5), false);
});

test('reset 后出生保护被清掉（由 Game 重新发放）', () => {
    const b = ball(0, 0, 10);
    b.grantShield(5, 10);
    b.reset(50, 50, 10);
    assert.equal(b.isProtected(11), false);
});

// ---------- 运行 ----------
let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failed += 1;
        console.log(`fail  ${name}`);
        console.log(`      ${err.message}`);
    }
}
console.log(`rules check: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) {
    process.exitCode = 1;
}