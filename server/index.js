// 多人联机服务端（express + socket.io）
// 需要先在仓库根目录执行 npm install 安装依赖
// 注意：当前仅为旧版 app.js 的平移，功能缺陷见 TODO.md「联机 / 服务端」
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const randomColor = ['#fff', '#ff9797', '#97eaff', '#97ffbe', '#f4ff97', '#ffb797'];
const players = [];

app.use('/src', express.static('src'));
app.use('/assets', express.static('assets'));
app.get('/', (req, res) => {
    res.sendFile(new URL('../index.html', import.meta.url).pathname);
});

io.on('connection', (socket) => {
    let player;

    socket.on('registe', (name) => {
        player = {
            id: socket.id,
            name,
            x: parseInt(Math.random() * 600),
            y: parseInt(Math.random() * 300),
            r: 10,
            color: randomColor[parseInt(Math.random() * randomColor.length)],
        };

        socket.emit('registe', player);
        players.push(player);
        // TODO: 广播新玩家加入
    });

    socket.on('create', () => {
        const roomInfo = 'room1';
        // TODO: 房间是写死的，没有房间管理
        io.sockets.emit('create', {
            room: roomInfo,
            msg: 'create successed',
            code: 1,
        });
    });

    socket.on('enter', (data) => {
        socket.join(data.room);
        // TODO: 应广播给房间内玩家，现在是全局广播
        socket.broadcast.emit('join', player);
    });

    // TODO: 客户端说什么就是什么，没有任何权威校验
    socket.on('update', (player) => {
        socket.broadcast.emit('update', player);
    });

    socket.on('disconnect', () => {
        for (let i = 0; i < players.length; i += 1) {
            if (socket.id === players[i].id) {
                players.splice(i, 1);
            }
        }
        // TODO: 没有向其他玩家广播离开事件
        console.log(players);
    });
});

server.listen(3000, () => {
    console.log('listening on 3000');
});
