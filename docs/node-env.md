# 环境与工具坑（本机记录）

只在"命令跑不起来 / 结果不对"时才需要读这个文件。

## Node 版本管理：fnm

- 用 [fnm](https://github.com/Schniz/fnm)（本机未开开发者模式、无管理员权限，nvm-windows 的符号链接不可用）。
- 版本约定见 `.nvmrc`（当前 `24`）。装了 fnm 的 shell 里 `cd` 进仓库会自动切换，或手动 `fnm install` / `fnm use`。
- 国内网络已配置镜像：`FNM_NODE_DIST_MIRROR=https://registry.npmmirror.com/-/binary/node`（用户级环境变量）。

## 非交互 shell 里 npm 不在 PATH

自动化检查（以及 Agent 跑命令）用的 shell 不加载 PowerShell profile，`npm` 经常找不到。先加 PATH：

```powershell
$bin = "$env:APPDATA\fnm\node-versions\v24.x\installation"
$env:PATH = "$bin;$env:PATH"
node -v; npm test
```

## PowerShell 5.1 的编码坑（中文乱码）

- 读文件必须显式 UTF-8：`Get-Content -Encoding UTF8`。默认按系统 ANSI（本机 GBK）读 UTF-8 文件会乱码。
- profile 里要先 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` 再 eval `fnm env`，否则中文路径下解码错误（本仓库 profile 已配好，勿删）。
- **典型误判**：乱码导致 `ConvertFrom-Json` 之类的解析失败时，先怀疑编码，而不是以为文件坏了。
  本次就因此差点误判 package.json 有问题。

## git 推送走代理

系统代理开着 `127.0.0.1:7897`，但 **git 不读系统代理**，直连 github.com:443 会超时
（`Failed to connect to github.com:443 after 21124 ms`）。推送时临时指定：

```powershell
git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin master
```

不写进全局配置，是因为代理没运行时全局代理会让 git 直接失败。若要常开：

```powershell
git config --global http.proxy http://127.0.0.1:7897
git config --global https.proxy http://127.0.0.1:7897
```

## 端口占用

`npm run dev` 报 `EADDRINUSE` 说明已经有 dev server 在跑（它是按请求读盘的，改代码刷新即可生效，不必重启）。