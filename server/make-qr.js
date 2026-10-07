// 重新生成手机扫码用的二维码：高纠错(H) + 512px，比默认尺寸好扫得多。
// 用法：node server/make-qr.js [url] [输出路径]
import QRCode from 'qrcode';

const url = process.argv[2] || 'http://192.168.31.146:3000';
const out = process.argv[3] || 'qr.png';

await QRCode.toFile(out, url, {
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: { dark: '#0b1f1a', light: '#ffffff' },
});
console.log(`已生成 ${out} → ${url}`);
console.log(await QRCode.toString(url, { type: 'terminal', small: true }));