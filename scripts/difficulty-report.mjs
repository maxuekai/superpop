// 三档难度的实测对照：AI 成长速度 + 玩家能不能吃到 AI。
// 用法：node scripts/difficulty-report.mjs
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
function argsFor(level) {
    const p = DIFFICULTY[level];
    return [
        '--thinkInterval', String(p.thinkInterval),
        '--escapeSamples', String(p.escapeSamples),
        '--escapeChange', String(p.escapeChange),
        '--fleeRange', String(p.fleeRange),
        '--escapeProbe', String(p.escapeProbe),
        '--escapeWallWeight', '1',
        '--escapeFoodWeight', '0.1',
        '--escapeFoodRange', '90',
        '--chaseRange', String(p.chaseRange),
    ];
}

console.log('难度档位实测对照（速度参数三档相同，只变决策质量）\n');
console.log('难度            | AI/玩家食物比 | 被玩家吃掉的轮次 | 平均存活 | 被逼墙');
console.log('-'.repeat(68));

for (const level of Object.keys(DIFFICULTY)) {
    const args = argsFor(level);
    const foodOut = runSim('food-sim.js', [...args, '--trials', '8', '--foodGain', String(DIFFICULTY[level].foodGain)]);
    const fleeOut = runSim('flee-sim.js', args);

    const ratio = (foodOut.match(/食物获取比：([\d.]+)/) || [])[1] || '?';
    const eaten = (fleeOut.match(/被吃：(\d+)\/20/) || [])[1] || '?';
    const life = (fleeOut.match(/平均 ([\d.]+)s/) || [])[1] || '?';
    const wall = (fleeOut.match(/(\d+\.\d)%/) || [])[1] || '?';

    console.log(
        `${`${DIFFICULTY[level].label}(${level})`.padEnd(15)}| ${String(ratio).padStart(14)} | `
        + `${`${eaten}/20`.padStart(16)} | ${`${life}s`.padStart(8)} | ${`${wall}%`.padStart(6)}`,
    );
}

console.log('\n读法：');
console.log('  · 「被玩家吃掉」= 玩家抓到 AI 的轮次。越低 = AI 越难抓 = 对玩家越难。');
console.log('  · 「AI/玩家食物比」越高 = AI 自己长得越快 = 场上越快出现大球。');
console.log('  · 三档的 speedScale / foragePower 相同，差别全部来自决策质量。');
console.log(`\n默认档：${DEFAULT_DIFFICULTY}；speedScale=${AI.speedScale} foragePower=${AI.foragePower}`);