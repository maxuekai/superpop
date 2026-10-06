// 零依赖静态文件服务器：开发预览用，不需要 npm install（二维码功能除外，装 qrcode 后启动会打印手机扫码用的二维码）
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// resolve 去掉目录 URL 自带的结尾分隔符，保证下面的 root + sep 前缀判断正确
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = process.env.PORT || 3000;

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

const server = http.createServer(async (req, res) => {
    try {
        let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname === '/') {
            pathname = '/index.html';
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
        console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    } catch {
        console.log('（安装 qrcode 后此处会显示二维码：npm install）');
    }
}

server.listen(port, printStartupInfo);
