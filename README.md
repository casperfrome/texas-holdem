# 德州扑克单挑

服务器裁判的双人无限注德州扑克网页游戏，支持密码房间、观战、15 秒倒计时、断线恢复和安装到主屏幕。

游戏地址：<https://156.225.76.31:1108/>。旧 GitHub Pages 地址会跳转到这里。新服需要重新注册，旧 MQTT 账号和牌局不迁移。

## 玩法

1. 注册或登录，只需要用户名和非空密码。账号和战绩保存在服务器，密码只存哈希。
2. 创建房间，可以设置密码及 0 / 2 / 5 / 10 个观战席，把邀请链接发给朋友；密码另外告知。
3. 建房者默认坐 0 号位，也可以站起观战。任意空座都可以入座，双方坐好后自动开始。
4. 初始各 1000 筹码，盲注 5/10。每步显示 15 秒，另有 1 秒网络宽限；超时能过牌就过牌，否则弃牌。
5. 玩家和观众断线后保留位置 60 秒，期间计时继续。同账号换设备进入同房间时，新设备接管，旧设备停止操作。
6. 主动离座、离房或超时腾位会结束尚未完成的整局，不计战绩；下次双方坐好重新开始。站起需要空余观战席。
7. 房主保留重开和解散房间的权限，房主离线不影响服务器运行。胜负由服务器按整局结果记一次。
8. 服务重启后恢复牌局和筹码，重新给予 15 秒行动时间和 60 秒重连宽限。

玩家只能收到自己的底牌，观众在摊牌前看不到任何底牌。完整牌堆和所有玩家手牌只保存在服务器。筹码仅用于游戏计分。

## 开发

需要 Node.js 24。使用 npm ci 安装依赖，在两个终端分别运行：

~~~sh
npm run dev:server   # 127.0.0.1:3000，SQLite 默认 data/game.sqlite
npm run dev          # http://127.0.0.1:5173，代理 /api 和 /ws
~~~

~~~sh
npm test             # 规则、2 万手随机对打、账号和服务端集成测试
npm run typecheck    # 前后端类型检查
npm run build        # dist/ 网页 + dist-server/ 服务端
npm start            # 启动已打包的服务端
npm run backup       # SQLite 一致性备份，清理超过 7 天的备份
~~~

单机测试入口：#local=host、#local=guest、#local=watch；同源标签页通过 BroadcastChannel 通信，不依赖服务器。旧 MQTT 模块仅作为历史实现和回归测试保留，不参与在线运行。

## 服务接口

- POST /api/auth/register、/api/auth/login、/api/auth/logout；GET /api/me。
- GET /api/rooms、POST /api/rooms、POST /api/rooms/:id/join、POST /api/rooms/:id/leave、DELETE /api/rooms/:id。
- GET /api/health：进程和数据库健康检查。
- /ws：协议 v3，Cookie 鉴权及 Origin 校验。订阅大厅和房间，发送 action / next / sit / stand / nudge / reset 操作；服务器返回个人视图、确认、错误和状态更新。

Cookie 为 HttpOnly、SameSite=Lax，生产环境启用 Secure；30 天有效。浏览器不保存密码、会话令牌或完整牌局。每次操作先事务保存再广播，重复请求与重复结算不会重复生效。Service Worker 只缓存静态资源，API 不缓存。

## 部署

Windows PowerShell：

~~~powershell
.\scripts\deploy.ps1
~~~

脚本默认使用 root@156.225.76.31、私钥 C:\Users\zevro\.ssh\id_ed25519 和 HTTPS 1108；可通过 Server、Port、IdentityFile 参数覆盖。首次连接需事先将已核验的 SSH 主机密钥加入 known_hosts。脚本先测试和构建，再上传产物、安装服务并检查健康，失败时回退上一程序版本。

- Nginx：80 仅用于 ACME 验证和跳转；1108 提供网页、API 和 WebSocket。
- Node.js 24：仅监听 127.0.0.1:3000，专用用户 texas-holdem，systemd 管理。
- 程序：/opt/texas-holdem/releases/，current 指向当前发布，previous 指向上一发布。
- 数据：/var/lib/texas-holdem/game.sqlite；配置：/etc/texas-holdem.env。
- 备份：/var/lib/texas-holdem/backups/，每日执行并保留 7 天，更新前也执行备份。
- TLS：Certbot Snap 5.4+ 签发受信任的短期 IP 证书，Snap 定时续期，成功后重载 Nginx。
- SSH 私钥、数据库、备份和生产配置不进入 Git。现有 443 / Xray 和 Hysteria 服务保留。

## 运维

~~~sh
systemctl status texas-holdem nginx
journalctl -u texas-holdem -n 100 --no-pager
systemctl restart texas-holdem
systemctl start texas-holdem-backup.service
systemctl list-timers --all
/snap/bin/certbot renew --dry-run --run-deploy-hooks
curl https://156.225.76.31:1108/api/health
~~~

程序回退：将 current 重新指向 previous 所指的发布目录，然后重启 texas-holdem。回退程序不会替换数据库。

数据恢复：先停止 texas-holdem，将选定的备份复制到 game.sqlite，移除该数据库旧的 -wal / -shm 文件，确认文件归 texas-holdem 用户且权限 600，再启动服务。恢复会退回到备份时刻，请先保留当前数据库的一致性备份。

真实设备清单见 [docs/device-testing.md](docs/device-testing.md)。
