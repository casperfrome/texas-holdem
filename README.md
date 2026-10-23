# 德州扑克单挑

两人在线对战的无限注德州扑克网页游戏，Mac、Windows、Android、iPhone 的浏览器都能玩，不需要自己的服务器。

- 联机方式：通过公共 MQTT 服务器中转，消息在两端设备上端到端加密
- 房间：只有一个固定房间，由房间口令决定；口令只放在链接 `#` 后面，不进仓库
- 房主：负责洗牌、发牌和判定，另一方只收到自己能看的数据

## 目录

| 路径 | 内容 |
|---|---|
| `index.html` | 网站首页 |
| `connectivity-test/` | 第 0 阶段：联机连通性测试页 |
| `src/engine/` | 第 1 阶段：规则引擎（纯函数，不依赖界面和网络） |
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

```bash
npm install
npm test          # 单元测试 + 2 万手随机对打
npm run typecheck
```

## 本地预览

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

然后打开 <http://localhost:8765/connectivity-test/>。加密功能只能在 `https` 或 `localhost` 下使用。
