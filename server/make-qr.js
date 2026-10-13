// 重新生成手机扫码用的二维码：高纠错(H) + 512px，比默认尺寸好扫得多。
// 用法：node server/make-qr.js [url] [输出路径]
// 不传 url 时自动探测本机局域网 IPv4 地址（与 dev-server 启动时同一套逻辑），
// 探测不到就打印用法退出——写死 IP 换网络环境就是错的。
import os from 'node:os';
import QRCode from 'qrcode';

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

const port = process.env.PORT || 3000;
let url = process.argv[2];
if (!url) {
    const ips = lanAddresses();
    if (ips.length === 0) {
        console.log('探测不到局域网地址，请显式传入：node server/make-qr.js <url> [输出路径]');
        process.exit(1);
    }
    url = `http://${ips[0]}:${port}`;
}
const out = process.argv[3] || 'qr.png';

await QRCode.toFile(out, url, {
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: { dark: '#0b1f1a', light: '#ffffff' },
});
console.log(`已生成 ${out} → ${url}`);
