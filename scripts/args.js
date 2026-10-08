// 仿真脚本共用的命令行解析。
//
// 为什么要有这个：之前的解析器把「既是 flag、又是某个 flag 的值」的数字从位置参数里
// 剔掉，于是 `flee-sim --thinkInterval 0.1 ... 0.1 90` 里的 0.1 被当成 flag 的值吃掉，
// 后面的 90 顶到了 escapeFoodWeight 的位置——**整组对照数据作废，而且完全静默**。
// 这个坑我踩了两次，所以这里改成：一旦撞值就明确报错并指出该怎么写。
//
// 规矩（两个仿真都遵守）：
//   1. 能用 flag 表达的参数一律用 flag，别用位置参数；
//   2. 位置参数只保留给少数几个历史参数，且必须是固定顺序的数字。

/**
 * 解析 argv。
 * @param {string[]} argv  process.argv.slice(2)
 * @param {object}   spec  { positional: ['fleeRange', ...], flags: ['hunter', ...] }
 * @returns {{ positional: object, flag: (name: string) => number|undefined }}
 */
export function parseArgs(argv, spec = {}) {
    const positionalNames = spec.positional || [];
    const flagNames = Array.isArray(spec.flags) ? spec.flags : Object.keys(spec.flags || {});

    // 逐个 flag 解析成 {名字: 原始字符串值}，同时记下每个 token 在 argv 里出现了几次
    const flags = new Map();
    const occurrences = new Map();
    for (const token of argv) {
        occurrences.set(token, (occurrences.get(token) || 0) + 1);
    }
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            continue;
        }
        let name = token.slice(2);
        let value;
        const eq = name.indexOf('=');
        if (eq >= 0) {
            value = name.slice(eq + 1);
            name = name.slice(0, eq);
        } else {
            value = argv[i + 1];
            i += 1;
        }
        if (value === undefined) {
            throw new Error(`--${name} 后面缺值`);
        }
        if (!flagNames.includes(name)) {
            throw new Error(`不认识的 flag：--${name}\n本脚本支持：${flagNames.map((n) => `--${n}`).join(' ')}`);
        }
        if (flags.has(name)) {
            throw new Error(`--${name} 给了多次`);
        }
        flags.set(name, value);
    }

    // 护栏 1（关键）：某个 flag 的值如果还在 argv 里作为独立 token 出现过，
    // 说明调用方把 flag 和位置参数混着写了 —— 旧解析器会在这里静默串位。
    for (const [name, value] of flags) {
        if ((occurrences.get(value) || 0) > 1) {
            throw new Error(
                `参数写法有歧义：--${name} 的值 "${value}" 同时被当成了一个位置参数。\n`
                + '旧解析器会把后面那个同值的数字悄悄吃掉，导致再后面的数字顶到前一个位置参数上'
                + '——整组数据作废而且不会报错（这个坑踩过两次）。\n'
                + `改法：所有参数都用 flag 写，例如 --${name}=${value}；位置参数只留给纯数字。`,
            );
        }
    }

    // 位置参数候选：不是 flag、也不是任何 flag 的值、且是数字
    const flagValues = new Set([...flags.values()]);
    const loose = [];
    for (const token of argv) {
        if (token.startsWith('--') || flagValues.has(token)) {
            continue;
        }
        if (!Number.isFinite(Number(token))) {
            throw new Error(`无法识别的参数 "${token}"：既不是 --flag，也不是数字位置参数`);
        }
        loose.push(token);
    }

    const positional = {};
    loose.forEach((token, index) => {
        const name = positionalNames[index];
        if (name === undefined) {
            throw new Error(
                `位置参数给多了：第 ${index + 1} 个 "${token}" 没有对应的参数名。\n`
                + `本脚本最多接受 ${positionalNames.length} 个位置参数：${positionalNames.join(' / ')}\n`
                + '能用 flag 表达的参数请写成 --名字 值。',
            );
        }
        positional[name] = Number(token);
    });

    const flag = (name) => {
        if (!flags.has(name)) {
            return undefined;
        }
        const num = Number(flags.get(name));
        if (!Number.isFinite(num)) {
            throw new Error(`--${name} 需要一个数字，收到 "${flags.get(name)}"`);
        }
        return num;
    };

    return { positional, flag };
}