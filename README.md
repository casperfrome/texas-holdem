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
| `.github/workflows/pages.yml` | 推送到 `main` 后自动发布到 GitHub Pages |

## 本地预览

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

然后打开 <http://localhost:8765/connectivity-test/>。加密功能只能在 `https` 或 `localhost` 下使用。
