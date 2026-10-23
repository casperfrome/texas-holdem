# 德州扑克单挑

两人在线对战的无限注德州扑克网页游戏，Mac、Windows、Android、iPhone 的浏览器都能玩，不需要自己的服务器。

- 联机方式：通过公共 MQTT 服务器（默认 EMQX）中转，消息在两端设备上用 AES-GCM 端到端加密
- 房间：房主创建一次，之后永远是这个房间。房间口令和房主密钥都是 128 位随机数，只放在链接 `#` 后面，不会发给托管网站，也不进仓库
- 房主：负责洗牌、发牌和判定，另一方只收到自己能看的数据；存档同时保存在本机和服务器（用房主密钥加密，朋友解不开），换设备打开房主链接就能接着打
- 断线：房主每次发送完整画面并保留在服务器上；玩家的操作没确认就重发，房主按序号去重；回到前台时立刻检查连接，失效就换新连接

## 怎么玩

1. 房主打开网站，点"创建房间"。
2. 点"邀请朋友"，把链接私下发给朋友。朋友打开就进入房间。
3. 房主换设备：点"换设备"复制房主链接，在新设备上打开。旧设备会自动停止，牌局接着打。房主链接只留给自己。

## 目录

| 路径 | 内容 |
|---|---|
| `index.html`、`src/main.tsx` | 游戏页面入口（Vite + React） |
| `connectivity-test/` | 第 0 阶段：联机连通性测试页 |
| `src/engine/` | 第 1 阶段：规则引擎（纯函数，不依赖界面和网络） |
| `src/net/` | 第 3 阶段：消息格式、房间链接、加密、MQTT 中转连接；以及单机测试用的本地传输 |
| `src/game/` | 房主（持有完整状态、存档、处理双方操作）和玩家客户端 |
| `src/ui/` | 第 2 阶段：牌桌界面 |
| `.github/workflows/pages.yml` | 推送到 `main` 后自动发布到 GitHub Pages |
| `.github/workflows/test.yml` | 每次推送都跑类型检查和测试 |

## 规则引擎

| 文件 | 内容 |
|---|---|
| `cards.ts` | 牌、加密随机数洗牌 |
| `evaluate.ts` | 从 7 张牌选出最好的 5 张并比较大小 |
| `game.ts` | 对局状态机：盲注、下注、全下、退还多余筹码、摊牌、一方输光后重开 |
| `view.ts` | 按身份裁剪数据：去掉牌堆，对方底牌只在摊牌时给出 |

用法：

```ts
import { applyAction, createMatch, startHand, viewFor } from './src/engine';

let state = createMatch();                     // 默认各 1000 筹码，盲注 5/10，座位 0（房主）先当庄
state = startHand(state);                      // 洗牌、放盲注、发底牌
state = applyAction(state, 0, { type: 'raise', to: 30 });
const forGuest = viewFor(state, 1);            // 发给朋友的数据
```

`bet` / `raise` 的 `to` 是本轮下注后的总额；下注上限按有效筹码（双方较少的那份）封顶。

## 开发

```bash
npm install
npm run dev       # 本地运行，打开 http://localhost:5173
npm test          # 单元测试 + 2 万手随机对打
npm run build     # 类型检查 + 打包到 dist/
```

单机测试（不走网络）：打开 `http://localhost:5173/#local=host` 当房主，再开一个标签页打开 `#local=guest` 当玩家。两个标签页通过 BroadcastChannel 通信，必须是同一个浏览器。

在一台电脑上测联机：房主用 `http://localhost:5173`，把邀请链接里的 `localhost` 换成 `127.0.0.1` 再打开。两个地址的浏览器存储是分开的，相当于两台设备。

连通性测试页：`python3 -m http.server 8765 --bind 127.0.0.1`，然后打开 <http://localhost:8765/connectivity-test/>。加密功能只能在 `https` 或 `localhost` 下使用。
