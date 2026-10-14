// AI 逃跑能力仿真：模拟「一个满舵直线追击的猎手」追若干 AI，统计存活时间与被逼墙次数。
// 用途：调 AI 难度/逃跑参数（config.js 的 AI.escape*、fleeRange 等）时，先在这里看整体效果，
// 比在手机上反复试省事。无 DOM，直接 `npm run sim` 运行。
//
// 用法：
//   npm run sim                        默认：猎手半径 22，追 r=10 的 AI
//   npm run sim -- 160 120 0.1         位置参数覆盖 fleeRange / escapeProbe / escapeWallWeight /
//                                      escapeFoodWeight / escapeFoodRange
//   npm run sim -- --sweep             扫猎手半径 10~50，看「大球到底能不能追上」（见下方闭环速度对照）
//   npm run sim -- --hunter 30 --prey 15   指定猎手半径与猎物半径
//   npm run sim -- --hunterLead 0.25   猎手瞄「猎物位置 + 速度 × 0.25s」而不是当前位置。
//                                      与 AI 追击玩家用的是同一套机制（ai.js 里
//                                      `target.x + target.speedX * AI.chaseLead`），
//                                      所以这个口径才量得到「AI 主动压宝的那部分」。
//                                      不给这个 flag 时只出直线口径（历史基线，数字不变）
import { AI, JOYSTICK, PLAYER, WORLD as WORLD_CONFIG } from '../src/config.js';
import { parseArgs } from './args.js';
import { AiPlayer } from '../src/core/ai.js';
import { Ball } from '../src/core/ball.js';
import { resolveOverlaps } from '../src/core/rules.js';
import { distance } from '../src/core/utils.js';

const STEP = 1 / 60;
const WORLD = WORLD_CONFIG; // 从 config 导入，别再硬编码——世界放大后这里不改就成了在旧地图上测
const RUN_SECONDS = 60;
// 默认 20 轮；--trials 覆盖（与 food-sim 一致）。曾经只在 flags 里声明却没应用，
// `--trials 40` 会静默跑 20 轮——按不存在的默认值下结论。
let TRIALS = 20;
const CORNER_CLEARANCE = 50; // 离边界小于该值算「被逼到墙角」
const THREAT_RANGE = 180; // 猎手进入该距离算「受威胁」

// 固定随机种子：AI 的 think() 内部会用到 Math.random，不固定的话同一组参数
// 每次跑出来的存活时间差异极大，没法拿来对比调参
const BASE_RNG_SEED = 20261007;
let rngSeed = BASE_RNG_SEED;
Math.random = () => {
    rngSeed = (rngSeed * 1103515245 + 12345) % 2147483648;
    return rngSeed / 2147483648;
};

// ---------- 命令行参数 ----------
// 解析交给 scripts/args.js：它会在"flag 的值和位置参数撞值"时直接报错，
// 而不是像旧解析器那样静默串位（旧解析器把 escapeFoodWeight 赋成 90，整组数据作废）。
const cli = parseArgs(process.argv.slice(2), {
    positional: ['fleeRange', 'escapeProbe', 'escapeWallWeight', 'escapeFoodWeight', 'escapeFoodRange'],
    flags: [
        'divisor', 'slowdown', 'hunter', 'prey', 'sweep', 'nofood', 'trials',
        'worldW', 'worldH', 'hunterLead',
        'speedScale', 'foragePower', 'thinkInterval', 'escapeSamples', 'escapeChange', 'chaseRange',
        'fleeRange', 'escapeProbe', 'escapeWallWeight', 'escapeFoodWeight', 'escapeFoodRange',
    ],
});
const flagValue = cli.flag;
if (flagValue('divisor') !== undefined) PLAYER.speedDivisor = flagValue('divisor');
if (flagValue('slowdown') !== undefined) PLAYER.slowdownPerRadius = flagValue('slowdown');
// 世界尺寸覆盖：地图放大直接改变"能不能追上"（AI 有更多地方躲），
// 定 WORLD 时必须在这里扫一遍，不能只看成长曲线。
if (flagValue('worldW') !== undefined) WORLD.width = flagValue('worldW');
if (flagValue('worldH') !== undefined) WORLD.height = flagValue('worldH');
// AI 速度：调 AI 觅食平衡时会连带影响逃跑速度，两个仿真必须一起看
if (flagValue('speedScale') !== undefined) AI.speedScale = flagValue('speedScale');
if (flagValue('foragePower') !== undefined) AI.foragePower = flagValue('foragePower');
if (flagValue('thinkInterval') !== undefined) AI.thinkInterval = flagValue('thinkInterval');
if (flagValue('escapeSamples') !== undefined) AI.escapeSamples = flagValue('escapeSamples');
if (flagValue('escapeChange') !== undefined) AI.escapeChange = flagValue('escapeChange');
if (flagValue('chaseRange') !== undefined) AI.chaseRange = flagValue('chaseRange');
// 下面这几个除了 flag 之外还能走位置参数。批量调参时一律用 flag，避开位置参数的坑：
// 位置参数是「既不是 flag、也不是某个 flag 的值」的数字，所以
// `flee-sim --thinkInterval 0.1 ... 0.1 90` 里那个 0.1 会被当成 flag 的值剔掉，
// 后面的 90 就顶到了 escapeFoodWeight 的位置——整组数据作废（已在 tuning.md 记过）。
if (flagValue('fleeRange') !== undefined) AI.fleeRange = flagValue('fleeRange');
if (flagValue('escapeProbe') !== undefined) AI.escapeProbe = flagValue('escapeProbe');
if (flagValue('escapeWallWeight') !== undefined) AI.escapeWallWeight = flagValue('escapeWallWeight');
if (flagValue('escapeFoodWeight') !== undefined) AI.escapeFoodWeight = flagValue('escapeFoodWeight');
if (flagValue('escapeFoodRange') !== undefined) AI.escapeFoodRange = flagValue('escapeFoodRange');
if (flagValue('trials') !== undefined) TRIALS = flagValue('trials');

const DEFAULT_HUNTER_R = 22;
const HUNTER_R = flagValue('hunter') ?? DEFAULT_HUNTER_R;
const PREY_R = flagValue('prey') ?? PLAYER.radius;
// 猎手预判秒数：0 = 瞄猎物当前位置（历史基线）；>0 = 瞄「位置 + 速度 × N 秒」
const HUNTER_LEAD = flagValue('hunterLead') ?? 0;
const SWEEP = process.argv.includes('--sweep');
// --nofood：猎物不吃食物（不长大）。用来把「速度不对称」和「猎物越逃越大越慢」两种因素分开
const PREY_GROWS = !process.argv.includes('--nofood');

// 与 Ball.update 同一套公式的解析速度（世界单位/秒），用来和仿真结果互相印证
function speedOf(r, throttle) {
    const divisor = PLAYER.speedDivisor + Math.max(0, r - PLAYER.radius) * PLAYER.slowdownPerRadius;
    return (JOYSTICK.radius / divisor) * PLAYER.speedUnit * throttle;
}

// 每个 AI 单独一场：猎手从中心出发，被追的 AI 从环形分布的起点出发
// hunterLead：猎手瞄「猎物当前位置」还是「猎物位置 + 输入向量 × lead」。
// 与 ai.js 追击分支 `target.x + target.speedX * AI.chaseLead` 逐字对称，
// 这样"预判口径"量到的才是 AI 压宝时真正用的那套机制。
function runOnce(seedIndex, hunterR, hunterLead = 0) {
    const hunter = new Ball(WORLD.width / 2, WORLD.height / 2, hunterR, '#fff', 'hunter');
    const angle = (seedIndex / TRIALS) * Math.PI * 2;
    const startX = WORLD.width / 2 + Math.cos(angle) * 220;
    const startY = WORLD.height / 2 + Math.sin(angle) * 180;
    const victim = new AiPlayer(startX, startY, PREY_R, '#fff', 'victim');
    victim.foodGain = PREY_GROWS ? PLAYER.growthPerFood : 0;
    victim.escapePhase = seedIndex * 0.61;

    // 固定的一片食物场：AI 逃跑时会「顺手」吃掉路过的那几颗
    const foodList = [];
    for (let i = 0; i < 200; i += 1) {
        foodList.push({
            x: Math.random() * WORLD.width,
            y: Math.random() * WORLD.height,
        });
    }

    let corneredFrames = 0;
    let threatenedFrames = 0;
    let foodEaten = 0;

    for (let step = 0; step < RUN_SECONDS / STEP; step += 1) {
        // 猎手满舵追击（比 AI 快，模拟玩家贴脸追）；hunterLead>0 时瞄猎物前方
        const dx = (victim.x + victim.speedX * hunterLead) - hunter.x;
        const dy = (victim.y + victim.speedY * hunterLead) - hunter.y;
        const len = distance(dx, dy, 0, 0) || 1;
        hunter.speedX = (dx / len) * JOYSTICK.radius;
        hunter.speedY = (dy / len) * JOYSTICK.radius;

        hunter.update(STEP, WORLD);
        victim.update(STEP, WORLD, [hunter, victim], foodList);

        // 与 Game.eatFood 同一套规则：经过就算吃到（此处不补种，只统计）
        for (let i = foodList.length - 1; i >= 0; i -= 1) {
            if (victim.canEatFood(foodList[i].x, foodList[i].y)) {
                foodList.splice(i, 1);
                victim.r += victim.foodGain;
                foodEaten += 1;
            }
        }

        const gap = distance(hunter.x, hunter.y, victim.x, victim.y);
        // 必须与 Game.updateWorld 同序：吃 → 弹开。
        // 这里曾经漏了软碰撞，于是"猎手能不能吃到猎物"是在一个没有碰撞的世界里测出来的，
        // 真实游戏里软碰撞会把猎物锁死在半径和上、谁都吃不掉谁，仿真却报"17/20 被吃"。
        // 漏掉任何一步都会让仿真与真实手感脱节，改这里前先对照 Game.updateWorld。
        resolveOverlaps([hunter, victim]);
        if (gap < THREAT_RANGE) {
            threatenedFrames += 1;
            const clearance = Math.min(
                victim.x - victim.r,
                WORLD.width - victim.x - victim.r,
                victim.y - victim.r,
                WORLD.height - victim.y - victim.r,
            );
            if (clearance < CORNER_CLEARANCE) {
                corneredFrames += 1;
            }
        }
        if (hunter.canEatBall(victim)) {
            return { survived: step * STEP, corneredFrames, threatenedFrames, foodEaten };
        }
    }
    return { survived: RUN_SECONDS, corneredFrames, threatenedFrames, foodEaten };
}

function sweepRadius(r) {
    const results = [];
    for (let i = 0; i < TRIALS; i += 1) {
        results.push(runOnce(i, r));
    }
    const times = results.map((x) => x.survived).sort((a, b) => a - b);
    return {
        hunterR: r,
        avg: times.reduce((sum, v) => sum + v, 0) / times.length,
        caught: results.filter((x) => x.survived < RUN_SECONDS).length,
        cornered: results.reduce((sum, x) => sum + x.corneredFrames, 0),
        threatened: results.reduce((sum, x) => sum + x.threatenedFrames, 0),
        food: results.reduce((sum, x) => sum + x.foodEaten, 0) / TRIALS,
    };
}

// ---------- 输出 ----------

if (SWEEP) {
    console.log(`扫猎手半径（猎物固定 r=${PREY_R}），各 ${TRIALS} 轮，每轮最多 ${RUN_SECONDS}s`);
    console.log('猎手R | 猎手速度 | 猎物速度 | 理论直退 | 平均存活 | 被吃轮次 | 贴墙% | 顺手吃');
    const rows = [];
    for (const r of [10, 12, 15, 18, 22, 25, 30, 35, 40, 50]) {
        const row = sweepRadius(r);
        rows.push(row);
        const hunterSpeed = speedOf(r, 1);
        const preySpeed = speedOf(PREY_R, AI.speedScale);
        const theory = hunterSpeed > preySpeed ? '追得上' : '追不上';
        const cornerPct = row.threatened ? (row.cornered / row.threatened * 100) : 0;
        console.log(
            `${String(r).padStart(4)} | ${hunterSpeed.toFixed(1).padStart(8)} | ${preySpeed.toFixed(1).padStart(8)} `
            + `| ${theory.padEnd(8)} | ${row.avg.toFixed(1).padStart(6)}s | ${String(`${row.caught}/${TRIALS}`).padStart(8)} `
            + `| ${cornerPct.toFixed(1).padStart(5)} | ${row.food.toFixed(1).padStart(5)}`,
        );
    }
    // 验收口径：还能在多少半径内稳定追上（>=80% 轮次被吃到）
    const acceptable = rows.filter((row) => row.caught >= TRIALS * 0.8);
    const maxR = acceptable.length ? acceptable[acceptable.length - 1].hunterR : 0;
    console.log(`\n可稳定追上（≥80% 轮次被吃）的最大猎手半径：${maxR}`);
    console.log('注：「理论直退」假设猎物沿连线远离；若实测比理论更乐观，说明猎物在转向/拐弯时');
    console.log('    把速度花在了侧向（径向分离变差），猎手反而能拉近距离——这正是 AI 贴墙时会被抓的原因。');
} else {
    // 两个口径：lead=0 的直线猎手是**历史基线**（verify / docs/tuning.md 的数字都出自这里，
    // 行文本保持逐字不变），--hunterLead > 0 时再跑一段预判猎手。
    // 为什么需要第二个口径：AI 追击玩家时瞄的是「猎物位置 + 速度 × chaseLead」，
    // 而直线猎手永远瞄当前位置——于是 chaseLead/chaseRange 这两个真正决定
    // "AI 追你追得凶不凶"的参数在仿真里完全是死参数，难度梯度也就测不出来。
    const calibers = [{ label: '直线', lead: 0 }];
    if (HUNTER_LEAD > 0) {
        calibers.push({ label: '预判', lead: HUNTER_LEAD });
    }

    for (const { label, lead } of calibers) {
        // 每个口径都从同一个随机状态出发。否则第二个口径接着第一个的随机流跑，
        // 两组数字的差异里混进了"随机流不同"这一项，就没法归因到猎手瞄准方式。
        rngSeed = BASE_RNG_SEED;
        const results = [];
        for (let i = 0; i < TRIALS; i += 1) {
            results.push(runOnce(i, HUNTER_R, lead));
        }
        const times = results.map((r) => r.survived).sort((a, b) => a - b);
        const avg = times.reduce((sum, v) => sum + v, 0) / times.length;
        const cornered = results.reduce((sum, r) => sum + r.corneredFrames, 0);
        const threatened = results.reduce((sum, r) => sum + r.threatenedFrames, 0);
        const eatenFood = results.reduce((sum, r) => sum + r.foodEaten, 0);
        const caught = results.filter((r) => r.survived < RUN_SECONDS).length;
        const cornerPct = threatened ? (cornered / threatened * 100) : 0;
        // 预判口径的行加「预判·」前缀：difficulty-report 用行首锚定的正则分别取两段，
        // 不加前缀的话两段数字会被同一个正则混着读（这项目里表格静默变 "?" 过一次）。
        const p = label === '直线' ? '' : `${label}·`;

        if (label === '直线') {
            console.log(`猎手半径 ${HUNTER_R} 满舵直线追击，猎物 r=${PREY_R}，各 ${TRIALS} 轮，每轮最多 ${RUN_SECONDS}s`);
        } else {
            console.log(`\n【${label}猎手口径】猎手瞄「猎物位置 + 速度 × ${lead}s」，与 AI 追击玩家同一套机制`);
            console.log(`猎手半径 ${HUNTER_R}，猎物 r=${PREY_R}，各 ${TRIALS} 轮，每轮最多 ${RUN_SECONDS}s`);
        }
        console.log(`  ${p}存活时间：最短 ${times[0].toFixed(1)}s / 平均 ${avg.toFixed(1)}s / 最长 ${times[times.length - 1].toFixed(1)}s`);
        console.log(`  ${p}被吃：${caught}/${TRIALS} 轮`);
        console.log(`  ${p}受威胁总帧 ${threatened}，其中被逼到墙角 ${cornered} 帧（${cornerPct.toFixed(1)}%）`);
        console.log(`  ${p}顺手吃到的食物：${eatenFood} 颗（平均 ${(eatenFood / TRIALS).toFixed(1)} 颗/轮，escapeFoodRange=${AI.escapeFoodRange}）`);

        if (label === '直线') {
            console.log(`  当前参数：fleeRange=${AI.fleeRange} borderMargin=${AI.borderMargin} escapeSamples=${AI.escapeSamples} escapeProbe=${AI.escapeProbe}`);
            const hunterSpeed = speedOf(HUNTER_R, 1);
            const preySpeed = speedOf(PREY_R, AI.speedScale);
            console.log(`  闭环速度：猎手 ${hunterSpeed.toFixed(1)} / 猎物 ${preySpeed.toFixed(1)} → 理论${hunterSpeed > preySpeed ? '追得上' : '追不上'}`);
            if (cornered / threatened > 0.15) {
                console.log('  ⚠ 被逼墙比例偏高：可以考虑调大 escapeWallWeight / escapeProbe');
            }
            if (eatenFood === 0) {
                console.log('  ⚠ 逃跑时一颗食物都没吃到：检查 escapeFoodRange / escapeFoodWeight');
            }
        }
    }
}