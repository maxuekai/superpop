// 联机客户端占位。
// 事件名与服务端 server/index.js 的约定保持一致：registe / create / enter / update。
// 默认不启用；接入联机时在这里实现 socket.io 客户端逻辑（见 TODO.md「联机」）。
export class NetClient {
    constructor() {
        this.socket = null;
    }

    connect() {
        throw new Error('联机尚未实现：见 TODO.md');
    }
}
