// 二维码准备：生成 qr.png、URL 没变就不重画、按需自动打开。
//
// 为什么单独抽一个文件：`dev-server.js`（npm run dev）和 `server/index.js`（npm run server）
// 之前各抄了一份完全一样的逻辑，两边各改各的迟早会不一致。
//
// 为什么**默认不自动打开**（真机反馈）：图片查看器每次都被拉起一个**新窗口**、不复用已有的。
// 开发时反复重启（改一行代码重启一次）就会在桌面上叠出一堆二维码预览窗口，
// 而且没人会去关它们——用户反馈"一直在疯狂地打开二维码，也不关闭之前老的预览"。
// 现在只有显式设了 SUPERPOP_OPEN_QR=1 才弹，终端打印路径，需要时自己点开。
//
// qrcode 是可选 devDependency：没装就只打印 URL，不影响服务器启动。
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const AUTO_OPEN = process.env.SUPERPOP_OPEN_QR === '1';

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

// 用系统默认程序打开文件，失败静默忽略
function openFile(path) {
    const commands = {
        win32: ['cmd', ['/c', 'start', '""', path]],
        darwin: ['open', [path]],
        linux: ['xdg-open', [path]],
    };
    const command = commands[process.platform];
    if (!command) {
        return;
    }
    try {
        spawn(command[0], command[1], { detached: true, stdio: 'ignore' }).unref();
    } catch {
        // 打开失败不影响服务器
    }
}

/**
 * @param {string} url     要编码的地址（局域网 URL）
 * @param {string} qrPath  二维码图片输出路径
 * @param {string} [lastUrlPath] 记录上次 URL 的文件，用于跳过重复生成
 */
export async function prepareQr(url, qrPath, lastUrlPath) {
    // URL 没变就不重画：反复重启时文件内容与修改时间都不该变，也省掉一次编码开销。
    if (lastUrlPath && await exists(qrPath) && await exists(lastUrlPath)) {
        try {
            const last = (await readFile(lastUrlPath, 'utf8')).trim();
            if (last === url) {
                console.log(`二维码未变（仍是 ${url}），复用 ${qrPath}`);
                if (AUTO_OPEN) {
                    openFile(qrPath);
                }
                return true;
            }
        } catch {
            // 读失败就当没有缓存，正常重新生成
        }
    }

    let QRCode;
    try {
        ({ default: QRCode } = await import('qrcode'));
    } catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND') {
            console.log('（可选 devDependency qrcode 未安装：npm install 后自动生成二维码图片）');
        } else {
            console.log(`（二维码生成失败：${err && err.message}；URL 不受影响）`);
        }
        return false;
    }

    try {
        await QRCode.toFile(qrPath, url);
        if (lastUrlPath) {
            await writeFile(lastUrlPath, `${url}\n`, 'utf8');
        }
        console.log(`二维码图片已生成：${qrPath}`);
        if (AUTO_OPEN) {
            openFile(qrPath);
            console.log('（已自动打开二维码图片，用手机扫屏幕上的码）');
        } else {
            console.log('（需要扫码时点开上面这个文件；想让它自动弹窗就设 SUPERPOP_OPEN_QR=1 再启动）');
        }
        return true;
    } catch (err) {
        // Windows 上只要还有图片查看器开着这个文件，重写就会报 UNKNOWN/EBUSY。
        // 这个错不解释的话就是一串天书，而它恰好是"自动弹窗留下的窗口没关"造成的。
        const code = err && (err.code || err.errno);
        if (code === 'UNKNOWN' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
            console.log(`（二维码没写成：${qrPath} 正被别的程序占用，多半是之前弹出的二维码预览窗口还没关；`
                + '关掉它再启动一次即可。URL 不受影响）');
        } else {
            console.log(`（二维码生成失败：${err && err.message}；URL 不受影响）`);
        }
        return false;
    }
}

// 两个 server 的 qr.png 都在仓库根目录，缓存记录跟着放
export function qrPaths(root) {
    return {
        qrPath: join(root, 'qr.png'),
        lastUrlPath: join(dirname(join(root, 'qr.png')), '.qr-last-url'),
    };
}
