// 零依赖静态文件服务器：开发预览用，不需要 npm install（二维码功能除外，装 qrcode 后启动会生成手机扫码用的二维码图片）
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareQr } from './qr-startup.js';

// resolve 去掉目录 URL 自带的结尾分隔符，保证下面的 root + sep 前缀判断正确
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = process.env.PORT || 3000;
const qrPath = join(root, 'qr.png');
const lastUrlPath = join(root, '.qr-last-url');

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

        // 百分号编码的路径穿越（/src/%2f..%2fpackage.json、%2e%2e%5c 变体）：
        // 白名单在解码后、resolve 前做，挡不住编码，解码后含 .. 或 \ 的一律 403
        if (pathname.includes('..') || pathname.includes('\\')) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
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
        // no-cache：手机浏览器对无缓存头的 js 会启发式缓存，改完代码真机刷到的还是旧包
        res.writeHead(200, {
            'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        });
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

async function printStartupInfo() {
    console.log(`superpop dev server: http://localhost:${port}`);
    const ips = lanAddresses();
    if (ips.length === 0) {
        return;
    }
    const url = `http://${ips[0]}:${port}`;
    console.log(`手机（同一 Wi-Fi）请访问：${url}`);
    await prepareQr(url, qrPath, lastUrlPath);
}

server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(`端口 ${port} 被占用：是否已经在跑 npm run server？（两者同抢一个端口，二选一）`);
        process.exit(1);
    }
    throw err;
});

server.listen(port, printStartupInfo);
