// smoke 检查：语法 + 两条会骗人的结构性检查。
//
// 为什么不止语法：这次踩过的坑里，最贵的两个**语法完全合法、npm test 也全绿**，
// 但结论是错的。语法检查必须配套这两条才够用。
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src', 'server', 'scripts'];

function collectJs(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectJs(path));
        } else if (entry.name.endsWith('.js')) {
            out.push(path);
        }
    }
    return out;
}

const files = roots.flatMap(collectJs);
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

// ① 语法
for (const file of files) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`smoke check passed: ${files.length} files`);

const problems = [];
const SIM_FILES = ['scripts/flee-sim.js', 'scripts/food-sim.js'];

// ② 仿真不许硬编码 config 里的参数。
//    踩过的坑：flee-sim.js 里写过 `const WORLD = {width:1024,height:768}`，
//    地图放大后仿真还在旧世界上跑，"玩家追 AI 17/20"却被当成"无回归"证据用过。
//    语法检查和单测都发现不了——只有这条能发现。
for (const file of SIM_FILES) {
    const src = sources.get(file) || '';
    for (const m of src.matchAll(/^\s*const\s+(WORLD|STEP)\s*=\s*\{/gm)) {
        const name = m[1];
        const imported = new RegExp(`\\b${name}\\b[^\\n]*from '\\.\\./src/config\\.js'`).test(src)
            || new RegExp(`WORLD as ${name}`).test(src)
            || new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\} from '\\.\\./src/config\\.js'`).test(src);
        if (!imported) {
            problems.push(`${file} 自己声明了 ${name} = {...}。`
                + '仿真必须从 src/config.js 导入，否则仿真跑的世界和游戏跑的世界可能不是同一个，'
                + '而这种错语法检查和单测都发现不了（已踩过一次）。');
        }
    }
    for (const m of src.matchAll(/(?<![\d.])(1024|768)(?![\d.])/g)) {
        problems.push(`${file} 里有硬编码数字 ${m[1]}，看着像旧的世界尺寸。`
            + '如果确实是别的含义就换个写法，否则仿真可能没在跑当前世界。');
    }
}

// ③ 未使用的导出。`Rectangle.within` 就是这样消失的：改完调用方没人再调它，
//    语法检查和单测都不会吭声，所以这里连类方法一起查。
//
//    白名单里的是**有意的占位**，不是死代码：删掉它等于删掉一个还没做的功能。
const ALLOWED_UNUSED = new Map([
    ['NetClient', '联机占位（TODO.md 阶段二，用户明确说不做联机）'],
    ['connect', 'e7300 placeholder NetClient TODO'],
    ['disable', 'enable/disable 成对的 API，游戏是单页应用，没有拆卸场景'],
]);
// constructor 是语言构造，永远不会被按名字调用
const LANG_CONSTRUCTS = new Set(['constructor']);

// 于是真正没人调的 Rectangle.within 反而漏掉了（第一版就栽在这）。
const allText = [...sources.entries()]
    .filter(([f]) => f !== 'scripts/check.js')
    .map(([f, s]) => `// ${f}\n${s}`)
    .join('\n');

function checkUnused(file, name) {
    if (ALLOWED_UNUSED.has(name) || LANG_CONSTRUCTS.has(name)) {
        return;
    }
    const withoutDefs = allText
        .replace(new RegExp(`export[^\\n]*\\b${name}\\b[^\\n]*\\n`, 'g'), '')
        .replace(new RegExp(`^\\s+${name}\\s*\\([^\\n]*\\)\\s*\\{`, 'gm'), '');
    if (!new RegExp(`\\b${name}\\b`).test(withoutDefs)) {
        problems.push(`${file} 的 ${name} 没有任何地方用到`
            + '（要么是死代码，要么该用而漏了；确认无用就删掉，确认有用就补调用）。');
    }
}

for (const [file, src] of sources) {
    if (!file.startsWith('src')) {
        continue;
    }
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
        checkUnused(file, m[1]);
    }
    // 类方法：class 体内形如 `    methodName(` 的成员
    const classBody = src.replace(/^export\s+class[\s\S]*?\n}/gm, (block) => {
        const methods = [...block.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*\(/gm)].map((x) => x[1]);
        for (const name of methods) {
            checkUnused(file, name);
        }
        return 'classRemoved';
    });
    void classBody;
}

if (problems.length > 0) {
    console.error('\nstructural problems:');
    for (const p of problems) {
        console.error(`  - ${p}`);
    }
    process.exitCode = 1;
} else {
    console.log('structural check passed: 仿真参数一致性 + 未使用导出');
}