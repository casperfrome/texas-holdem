import { useEffect, useState, useSyncExternalStore } from 'react';
import { browserStore, canNudge, type GameClient, GuestClient, HostController } from '../game/client';
import { createLocalGuestTransport, createLocalHostTransport } from '../net/local';
import { api, ServerGameClient } from '../net/server';
import type { User } from '../shared/server-protocol';
import { isStandalone } from './pwa';
import { alertNudge, InstallPanel, LinkPanel, StatusDot, useWakeLock } from './RoomUI';
import { Table } from './Table';
import { Login } from './Login';
import { Lobby } from './Lobby';

type LocalRole = 'host' | 'guest' | 'watch';
export function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const changed = () => setHash(location.hash);
    addEventListener('hashchange', changed);
    return () => removeEventListener('hashchange', changed);
  }, []);
  const local = /^#local=(host|guest|watch)$/.exec(hash)?.[1] as LocalRole | undefined;
  return local ? <LocalGame key={local} role={local} /> : <Online key={hash} hash={hash} />;
}
function Online({ hash }: { hash: string }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invite = new URLSearchParams(hash.replace(/^#/, '')).get('room');
  useEffect(() => {
    let active = true;
    const expired = () => { setUser(null); setRoomId(null); };
    addEventListener('session-expired', expired);
    void api<{ user: User }>('/me').then(({ user: account }) => {
      if (!active) return;
      setUser(account);
      if (!invite) setRoomId(browserStore.get('thp.v3.current.' + account.id) || null);
    }).catch((e: Error) => { if (active && e.message !== '请先登录' && !e.message.includes('登录已过期')) setError(e.message); });
    return () => { active = false; removeEventListener('session-expired', expired); };
  }, [invite]);
  const enter = (id: string) => { if (user) browserStore.set('thp.v3.current.' + user.id, id); setRoomId(id); history.replaceState(null, '', location.pathname); };
  const leave = () => { if (user) browserStore.set('thp.v3.current.' + user.id, ''); setRoomId(null); };
  const logout = async () => {
    if (!confirm('退出登录会断开当前连接，确定退出吗？')) return;
    try { await api('/auth/logout', 'POST'); setUser(null); setRoomId(null); }
    catch (e) { setError((e as Error).message); }
  };
  if (error) return <main className="lobby"><p role="alert">{error}</p><button type="button" className="btn" onClick={() => location.reload()}>重新连接</button></main>;
  if (user === undefined) return <div className="center-note">正在连接服务器…</div>;
  if (!user) return <Login onDone={setUser} />;
  if (roomId) return <RemoteGame roomId={roomId} onLeave={leave} />;
  return <Lobby user={user} invite={invite} onEnter={enter} onUser={setUser} onLogout={() => { void logout(); }} />;
}
function RemoteGame({ roomId, onLeave }: { roomId: string; onLeave: () => void }) {
  const [client, setClient] = useState<ServerGameClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const game = new ServerGameClient(roomId);
    setClient(game);
    return () => game.dispose();
  }, [roomId]);
  const leave = async () => {
    try { await api('/rooms/' + roomId + '/leave', 'POST'); onLeave(); }
    catch (e) {
      const message = (e as Error).message;
      if (message.includes('不存在') || message.includes('先加入')) onLeave();
      else setError(message);
    }
  };
  return <>{error && <p role="alert" className="banner banner-warn">{error}</p>}{client ? <GameScreen client={client} online inviteUrl={location.origin + location.pathname + '#room=' + roomId} onLeave={() => { void leave(); }} /> : <div className="center-note">正在进入房间…</div>}</>;
}

/** 单机测试：同一设备几个标签页 */
function LocalGame({ role }: { role: LocalRole }) {
  const [client, setClient] = useState<GameClient | null>(null);
  useEffect(() => {
    const c = role === 'host'
      ? new HostController(createLocalHostTransport(), { roomName: '单机测试', maxWatchers: 5, saveKey: 'thp.v2.local' })
      : new GuestClient(createLocalGuestTransport(), role === 'guest'
        ? { name: '玩家', token: 'local-guest', want: 'play' }
        : { name: '观众', token: Math.random().toString(36), want: 'watch' });
    setClient(c);
    return () => c.dispose();
  }, [role]);
  return client ? <GameScreen client={client} online={false} inviteUrl={null} onLeave={() => { client.leave(); location.hash = ''; }} /> : null;
}

function GameScreen({ client, online, inviteUrl, onLeave, onMatchOver }: {
  client: GameClient;
  online: boolean;
  inviteUrl: string | null;
  onLeave: () => void;
  onMatchOver?: (epoch: string, matchNumber: number, won: boolean) => void;
}) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const { view, room, turn, error, connection, pending, nudged, denied, epoch } = snapshot;
  const [panel, setPanel] = useState<'invite' | 'install' | null>(null);
  const [nudgeNote, setNudgeNote] = useState<string | null>(null);
  const host = online ? room?.owner === true : client.role === 'host';
  const seated = room?.you === 'host' || room?.you === 'player';
  useWakeLock(online);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => client.dismissError(), 3000);
    return () => clearTimeout(t);
  }, [error, client]);

  useEffect(() => {
    if (!nudged) return;
    alertNudge();
    setNudgeNote(`${nudged.from} 催你快点！`);
    const t = setTimeout(() => setNudgeNote(null), 3000);
    return () => clearTimeout(t);
  }, [nudged]);

  // 一局分出胜负：记战绩（观众不记）
  const winner = view?.matchWinner ?? null;
  useEffect(() => {
    if (winner === null || !seated || !epoch || !view) return;
    onMatchOver?.(epoch, view.matchNumber, winner === view.you);
  }, [winner, seated, epoch]);

  if (connection.superseded) {
    return (
      <main className="lobby">
        <h1>已在其他设备打开</h1>
        <p className="muted">同一账号已在另一台设备进入这个房间，这台设备已停止操作。</p>
        <button type="button" className="btn btn-raise" onClick={() => location.reload()}>改回在这台设备上玩</button>
      </main>
    );
  }

  if (denied) {
    return (
      <main className="lobby">
        <h1>进不去</h1>
        <p className="muted">{denied}</p>
        <button type="button" className="btn btn-raise" onClick={onLeave}>回到大厅</button>
      </main>
    );
  }

  return (
    <main className="game">
      {online && connection.self !== 'online' && <div className="banner banner-warn">网络断开，正在重连…座位保留 60 秒，计时仍会继续。</div>}
      {online && connection.self === 'online' && connection.peer === 'offline' && <div className="banner banner-warn">对手暂时离线，计时仍在继续；60 秒内可回来。</div>}
      {view ? (
        <Table
          view={view} room={room} turn={turn} pending={pending}
          statusDot={online ? <StatusDot connection={connection} /> : null}
          canNudge={canNudge(snapshot)}
          onAct={(a) => client.act(a)}
          onNext={() => client.next()}
          onNudge={() => client.nudge()}
          onSit={() => client.sit()}
        />
      ) : (
        <div className="center-note">
          正在进入房间…
          <div className="muted small">{online ? '正在从服务器读取牌局' : '请在另一个标签页以房主身份打开'}</div>
        </div>
      )}

      {room && (
        <div className="watchers muted small">
          {room.name && <span>{room.name} · </span>}
          观战 {room.maxWatchers === 0 ? '不开放' : `${room.watchers.length}/${room.maxWatchers}`}
          {room.watchers.length > 0 && `：${room.watchers.join('、')}`}
        </div>
      )}

      {inviteUrl && panel === 'invite' && (
        <LinkPanel
          title="邀请朋友"
          note="把这个链接发给朋友（例如微信）。朋友打开后登录，输入房间密码就能进来。密码请另外告诉他。"
          url={inviteUrl}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'install' && <InstallPanel onClose={() => setPanel(null)} />}

      {nudgeNote && <div className="toast toast-nudge" role="alert" onClick={() => setNudgeNote(null)}>{nudgeNote}</div>}
      {error && <div className="toast" role="alert" onClick={() => client.dismissError()}>{error}</div>}

      <footer className="footer">
        <span className="muted small">
          {host ? '房主' : room?.you === 'player' ? '玩家' : '观众'}{online ? '' : '（单机测试）'}
        </span>
        {inviteUrl && <button type="button" className="link small" onClick={() => setPanel('invite')}>邀请</button>}
        {online && !isStandalone() && (
          <button type="button" className="link small" onClick={() => setPanel('install')}>安装</button>
        )}
        {host && !online && <a className="link small" href="#local=guest" target="_blank" rel="noopener">打开玩家标签页</a>}
        {host && !online && <a className="link small" href="#local=watch" target="_blank" rel="noopener">打开观众标签页</a>}
        {room?.you === 'player' && (
          <button
            type="button" className="link small"
            onClick={() => { if (confirm('站起来变成观众？这一局就此结束，下次坐下从头开始。')) client.stand(); }}
          >站起</button>
        )}
        {host && (
          <button
            type="button" className="link small"
            onClick={() => { if (confirm('确定清空当前对局，双方筹码和比分从头开始吗？')) (client as HostController).reset(); }}
          >重新开始</button>
        )}
        <button
          type="button" className="link small"
          onClick={() => {
            const msg = host
              ? '离开会让出座位，未完成的整局不计战绩。房间仍保留在我的房间。确定离开吗？'
              : room?.you === 'player'
                ? '离开会让出座位，这一局就此结束。确定离开吗？'
                : '确定离开这个房间吗？';
            if (confirm(msg)) onLeave();
          }}
        >离开</button>
      </footer>
    </main>
  );
}
