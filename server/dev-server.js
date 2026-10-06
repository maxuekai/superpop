// 零依赖静态文件服务器：开发预览用，不需要 npm install
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
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

        const filePath = join(root, normalize(pathname));
        if (!filePath.startsWith(root + sep) && filePath !== join(root, 'index.html')) {
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

server.listen(port, () => {
    console.log(`superpop dev server: http://localhost:${port}`);
});
