// 三档难度的实测对照，并**判定梯度是否真的存在**。
// 用法：node scripts/difficulty-report.mjs
//
// 这个脚本存在的理由：难度档位曾经"配了参数但量不出来"。三档 speedScale 相同、
// 差别全在决策质量，而当时的报告有两个盲区——
//   ① 只数「吃了几颗食物」，看不见 foodGain 改的是**每颗的肉**（0.26/0.3/0.34 的体重梯度真实存在，报告里是平的）；
//   ② 猎手永远是瞄当前位置的直线球，于是 AI 压宝的 chaseLead/chaseRange 在仿真里是**死参数**。
// 两个盲区叠在一起的结果就是：三档数字全平 → 看起来像"调过了但没效果" → 于是又去调参数。
//
// 现在四个度量一起看，缺一不可：
//   AI 30s 体重      —— 成长速度梯度（foodGain 那一面）
//   被吃(直线)       —— 玩家直球贴脸时 AI 好不好抓（历史基线口径）
//   被吃(预判)       —— 玩家瞄前方时 AI 好不好抓（与 AI.chaseLead 同一套机制，梯度主要体现在这里）
//   AI/玩家食物比    —— AI 是否强到破坏平衡（红线：这个数掉下来要重看）
import { pathToFileURL, fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const ROOT = 'file:///C:/Users/%E9%A3%8E%E4%BB%8E%E5%93%AA%E9%87%8C%E6%9D%A5/projects/superpop/src';
const { DIFFICULTY, DEFAULT_DIFFICULTY, AI } = await import(`${ROOT}/config.js`);

const NODE = process.execPath;
// 必须用 fileURLToPath 解码：用户名是中文，URL 里是 %E9%A3%8E 这种百分号编码，
// 直接 replace('/') 会拿到一个不存在的路径，spawnSync 静默失败、输出全空。
// 用 './' 而不是 '../'：ROOT 以 src 结尾（无尾斜杠），它被当成"文件"，
// 所以 '../' 会退到 projects/，而 './' 正好就是 superpop/。
const REPO = fileURLToPath(new URL('./', ROOT));

function runSim(script, args) {
    const res = spawnSync(NODE, [`${REPO}scripts\\${script}`, ...args], {
        encoding: 'utf8',
        cwd: REPO,
    });
    if (res.status !== 0) {
        console.error(`${script} 跑失败：`, res.stderr || res.error);
    }
    return res.stdout || '';
}

// 一律用 flag 展开，不走位置参数（位置参数会把 flag 的值也吃进去，见 flee-sim 里的注释）
// ⚠ 两个脚本支持的 flag 不是同一套：food-sim 没有 escapeWallWeight / escapeFoodWeight / hunterLead
// （它测的是觅食，猎物不逃跑、没有猎手）。给 food-sim 传它不认识的 flag 会整行报错、
// 表格里只剩 "?"——曾经就这么静默失效过一轮，别再共享同一份参数表。
const FLEE_ONLY_FLAGS = new Set(['escapeWallWeight', 'escapeFoodWeight', 'hunterLead']);

function argsFor(level) {
    const p = DIFFICULTY[level];
    const pairs = [
        ['thinkInterval', String(p.thinkInterval)],
        ['escapeSamples', String(p.escapeSamples)],
        ['escapeChange', String(p.escapeChange)],
        ['fleeRange', String(p.fleeRange)],
        ['escapeProbe', String(p.escapeProbe)],
        ['escapeWallWeight', '1'],
        ['escapeFoodWeight', '0.1'],
        ['escapeFoodRange', '90'],
        ['chaseRange', String(p.chaseRange)],
        // 绕圈拖延：三档逐位传下去。不传的话三档都会跑 AI 默认值，
        // 报告就会在"参数配了"的前提下量出一个假的梯度——这正是本脚本
        // 当初存在的理由（参数配了但量不出来），不能自己再犯一次。
        ['fleeOrbit', String(p.fleeOrbit)],
    ];
    const pick = (allowed) => pairs
        .filter(([name]) => allowed(name))
        // 必须用 --名字=值 的粘连写法：分开写时，两个 flag 恰好同值
        // （如 normal 档 thinkInterval 0.1 与 escapeFoodWeight 0.1）会触发
        // args.js 的撞值护栏整行报错——difficulty-report 从写出来那天起
        // easy/normal 两行就一直是 "?"，没人发现。
        .map(([name, value]) => `--${name}=${value}`);
    return {
        flee: pick(() => true),
        food: pick((name) => !FLEE_ONLY_FLAGS.has(name)),
    };
}

// ---- 解析：读不到就记 '?'，并在最后**大声报错**而不是让表格安静地显示 "?" ----
// 这个脚本从诞生起就因为正则对不上而整列变 "?" 过（easy/normal 两行从没出过数）。
// 静默的 "?" 比没有这一列更坏：它看起来像"这个档没数据"，于是结论落到别的列上去了。
function num(text, re) {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
}

// 预判口径的猎手**三档用同一个提前量**（取 AI.chaseLead 默认值），不能"每档用该档自己的
// chaseLead"——chaseLead 是 AI 追人时的参数，跟猎物逃不逃得掉毫无关系；让猎手随档位变化，
// 那一列量到的就是"这档 AI 自己瞄得准不准"，而不是"这档 AI 好不好抓"。
// 口径要能横向比，就得把除了「被测对象」以外的东西全部固定住（速度同理，三档相同）。
const HUNTER_LEAD = AI.chaseLead;

// flee 侧用 60 轮而不是默认的 20：hard 与 normal 在预判口径下的真实差是 88% vs 78%（10 个点），
// 20 轮的抽样噪声 ±7 个点——验收线要是抖的，它就等于没有，还会让人反复重跑来"求个通过"。
// 单轮耗时 <1s，多花这点时间换一条稳定的判定值。
const FLEE_TRIALS = 60;

const LEVELS = Object.keys(DIFFICULTY);
const rows = [];
const broken = [];

for (const level of LEVELS) {
    const p = DIFFICULTY[level];
    const { flee: fleeArgs, food: foodArgs } = argsFor(level);
    const foodOut = runSim('food-sim.js', [...foodArgs, `--trials=8`, `--foodGain=${p.foodGain}`]);
    const fleeOut = runSim('flee-sim.js', [...fleeArgs, `--trials=${FLEE_TRIALS}`, `--hunterLead=${HUNTER_LEAD}`]);

    // 直线口径的行没有前缀，预判口径的行都带「预判·」前缀 —— 用行首锚定的正则分开取。
    // 少了这个锚定，两段数字会被同一个正则混着读（取到第一段，预判列全是直线的值）。
    const straightEaten = num(fleeOut, /^\s*被吃：(\d+)\//m);
    const leadEaten = num(fleeOut, /^\s*预判·被吃：(\d+)\//m);
    const straightLife = num(fleeOut, /^\s*存活时间：.*?平均 ([\d.]+)s/m);
    const leadLife = num(fleeOut, /^\s*预判·存活时间：.*?平均 ([\d.]+)s/m);
    const corner = num(fleeOut, /^\s*受威胁总帧 \d+，其中被逼到墙角 \d+ 帧（([\d.]+)%）/m);
    const ratio = num(foodOut, /AI \/ 玩家 食物获取比：([\d.]+)/);
    const aiMass = num(foodOut, /AI 30s 平均体重：([\d.]+) kg/);

    for (const [name, v] of Object.entries({ straightEaten, leadEaten, straightLife, leadLife, corner, ratio, aiMass })) {
        if (v === null) {
            broken.push(`${level} 的 ${name} 读不出来（输出格式变了？）`);
        }
    }

    rows.push({
        level,
        label: `${p.label}(${level})`,
        straightEaten,
        leadEaten,
        straightLife,
        leadLife,
        corner,
        ratio,
        aiMass,
    });
}

const cell = (v, width, { digits = 1, suffix = '' } = {}) => (v === null
    ? '?'.padStart(width)
    : `${v.toFixed(digits)}${suffix}`.padStart(width));

console.log('难度档位实测对照（速度参数三档相同，只变决策质量）\n');
console.log(['难度', 'AI/玩家食物比', 'AI 30s体重', '被吃(直线)', '被吃(预判)', '存活(直线)', '存活(预判)', '被逼墙']
    .map((h, i) => h.padEnd([14, 14, 11, 10, 10, 11, 11, 8][i])).join(''));
console.log('-'.repeat(88));
for (const r of rows) {
    console.log([
        r.label.padEnd(14),
        // 食物比必须给 3 位小数：锚点是 0.867，四舍五入成 0.9 就没法当红线判
        cell(r.ratio, 14, { digits: 3 }),
        cell(r.aiMass, 11, { digits: 0, suffix: 'kg' }),
        cell(r.straightEaten, 10, { digits: 0 }),
        cell(r.leadEaten, 10, { digits: 0 }),
        cell(r.straightLife, 11, { digits: 1, suffix: 's' }),
        cell(r.leadLife, 11, { digits: 1, suffix: 's' }),
        cell(r.corner, 8, { digits: 1, suffix: '%' }),
    ].join(''));
}

// ---- 验收判定（TODO.md 里写死的验收线，脚本每次自动判，不靠人肉看表）----
console.log('\n验收判定：');
const verdicts = [];
function judge(name, ok, detail) {
    verdicts.push({ name, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${name}：${detail}`);
}

if (broken.length > 0) {
    console.log('\n  ✗✗ 有读数失败，下面每一条判定都不可信（这是脚本坏了，不是参数坏了）：');
    for (const b of broken) {
        console.log(`      - ${b}`);
    }
    process.exit(1);
}

const by = (lv) => rows.find((r) => r.level === lv);
const [easy, normal, hard] = LEVELS.map(by);

// 被吃率 easy > normal > hard：越难吃 = 档位越难（越高 = 玩家越抓不到 AI）
for (const [key, name] of [['straightEaten', '直线口径'], ['leadEaten', '预判口径']]) {
    judge(
        `${name}被吃率 easy > normal > hard`,
        easy[key] > normal[key] && normal[key] > hard[key],
        `${easy[key]} > ${normal[key]} > ${hard[key]}（越低=对玩家越难）`,
    );
}

// AI 30s 体重三档单调且档差 ≥15%：easy < normal < hard
{
    const spread = (hard.aiMass - easy.aiMass) / easy.aiMass * 100;
    judge(
        'AI 30s 体重 easy < normal < hard 且档差 ≥15%',
        easy.aiMass < normal.aiMass && normal.aiMass < hard.aiMass && spread >= 15,
        `${easy.aiMass} → ${normal.aiMass} → ${hard.aiMass} kg（档差 ${spread.toFixed(0)}%）`,
    );
}

// 食物比红线只对 normal 设：它是默认档、也是 AGENTS.md 里"不许漂"的锚点（0.867）。
// easy/hard 的比值是各自 foodGain 的**设计结果**（easy 故意弱），对它们设红线是自相矛盾。
{
    judge(
        'normal 档 AI/玩家食物比 0.83~0.90（平衡锚点）',
        normal.ratio >= 0.83 && normal.ratio <= 0.9,
        `${normal.ratio.toFixed(3)}（历史锚点 0.867）`,
    );
}

// normal 档必须与 AI.* 默认值等价：默认档的逃离表现一漂，说明有人在改难度档时
// 顺手动了 DIFFICULTY.normal 或 AI 的默认值之一，而两者本该是同一组数。
// 这里拿"不带任何 flag 的 flee-sim"当参照（同种子 → 结果应当逐位相同）。
{
    const ref = runSim('flee-sim.js', [`--trials=${FLEE_TRIALS}`]);
    const refEaten = num(ref, /^\s*被吃：(\d+)\//m);
    const refLife = num(ref, /^\s*存活时间：.*?平均 ([\d.]+)s/m);
    judge(
        'normal 档与 AI 默认值一致（不带 flag 的基线）',
        normal.straightEaten === refEaten && Math.abs(normal.straightLife - refLife) < 0.05,
        `normal ${normal.straightEaten}/${FLEE_TRIALS}、${normal.straightLife}s vs 基线 ${refEaten}/${FLEE_TRIALS}、${refLife}s`,
    );
}

console.log('\n读法：');
console.log('  · 「被吃」= 玩家抓到 AI 的轮次（各 ' + FLEE_TRIALS + ' 轮）。越低 = AI 越难抓 = 对玩家越难。');
console.log('  · 「预判」= 猎手瞄「猎物位置 + 速度 × chaseLead 秒」，与 AI 压宝同一套机制；');
console.log(`    提前量三档固定为 AI.chaseLead=${HUNTER_LEAD}s，只有被测的 AI 在变。`);
console.log('  · 「AI 30s体重」= 30 秒后 AI 长到多重（kg）。foodGain 改的是每颗的肉，');
console.log('    食物颗数可能一样而肉量差三成——只看颗数会以为没调。');
console.log('  · 三档的 speedScale / foragePower 相同，差别全部来自决策质量。');
console.log('  · 本脚本**不覆盖 AI 数量**：food-sim / flee-sim 都只跑单个球，');
console.log('    DIFFICULTY.*.count 的梯度没有自动化度量，改它得靠真机体感。');
console.log(`\n默认档：${DEFAULT_DIFFICULTY}；speedScale=${AI.speedScale} foragePower=${AI.foragePower}`);

if (verdicts.some((v) => !v.ok)) {
    console.log('\n✗ 有验收项不通过：三档差异在度量上还不成立（参数没调到位，或度量仍看不见它）。');
    process.exit(1);
}
console.log('\n✓ 全部验收项通过。');
