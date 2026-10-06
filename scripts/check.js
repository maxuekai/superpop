// 最小 smoke 检查：对 src/ 和 server/ 下所有 .js 跑 node --check（语法级，不执行浏览器代码）
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
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
for (const file of files) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`smoke check passed: ${files.length} files`);
