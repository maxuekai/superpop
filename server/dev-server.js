// 零依赖静态文件服务器：开发预览用，不需要 npm install（二维码功能除外，装 qrcode 后启动会生成手机扫码用的二维码图片）
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// resolve 去掉目录 URL 自带的结尾分隔符，保证下面的 root + sep 前缀判断正确
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = process.env.PORT || 3000;
const qrPath = join(root, 'qr.png');
// 记录上次二维码指向的 URL：IP 没变就不重复弹图片查看器（开发中服务器经常重启）
const qrUrlCachePath = join(root, '.qr-last-url');

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

// 只放行游戏真正需要的静态文件，避免整个仓库（package-lock.json / server / .git / node_modules）
// 在局域网里被手机直接下载。qr.png 是给手机扫码用的，保留。
const allowedPrefixes = ['/src/', '/index.html', '/qr.png', '/favicon.ico'];

function isAllowed(pathname) {
    return allowedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

const server = http.createServer(async (req, res) => {
    try {
        let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname === '/') {
            pathname = '/index.html';
        }

        if (!isAllowed(pathname)) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const filePath = resolve(root, '.' + pathname);
        if (filePath !== root && !filePath.startsWith(root + sep)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        const data = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream' });
        res.end(data);
    } catch (err) {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// 本机局域网 IPv4 地址（手机连同一 Wi-Fi 后扫码/输 IP 访问）
function lanAddresses() {
    const list = [];
    for (const infos of Object.values(os.networkInterfaces())) {
        for (const info of infos || []) {
            if (info.family === 'IPv4' && !info.internal) {
                list.push(info.address);
            }
        }
    }
    return list;
}

// 用系统默认程序打开文件（二维码图片），失败静默忽略
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

async function printStartupInfo() {
    console.log(`superpop dev server: http://localhost:${port}`);
    const ips = lanAddresses();
    if (ips.length === 0) {
        return;
    }
    const url = `http://${ips[0]}:${port}`;
    console.log(`手机（同一 Wi-Fi）请访问：${url}`);

    // qrcode 是可选 devDependency：没装就只打印 URL，不影响启动
    try {
        const { default: QRCode } = await import('qrcode');
        await QRCode.toFile(qrPath, url);
        console.log(`二维码图片已生成：${qrPath}`);

        const previous = await readFile(qrUrlCachePath, 'utf8').catch(() => null);
        if (previous === url) {
            console.log('（IP 未变化，未重复打开图片；需要时手动打开 qr.png）');
        } else {
            await writeFile(qrUrlCachePath, url, 'utf8');
            openFile(qrPath);
            console.log('（已自动打开二维码图片，用手机扫屏幕上的码）');
        }

        // 终端里再打印一份字符二维码作兜底
        console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    } catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND') {
            console.log('（可选 devDependency qrcode 未安装：npm install 后自动生成二维码图片）');
        } else {
            console.log(`（二维码生成失败：${err && err.message}）`);
        }
    }
}

server.listen(port, printStartupInfo);
