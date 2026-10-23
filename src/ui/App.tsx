import { useEffect, useState, useSyncExternalStore } from 'react';
import { browserStore, type GameClient, GuestClient, HostController, isSavedGame } from '../game/client';
import { deriveKeys } from '../net/crypto';
import { createLocalTransport } from '../net/local';
import { RoomConnection } from '../net/mqtt';
import type { Role } from '../net/protocol';
import {
  BROKERS, clearRoom, createRoom, guestLink, hostLink, isHost, loadRoom, parseRoomHash, parseRoomLink, type RoomCredentials,
  saveRoom,
} from '../net/room';
import { isStandalone } from './pwa';
import { InstallPanel, LinkPanel, StatusBanner, StatusDot, useWakeLock } from './RoomUI';
import { Table } from './Table';

type Route =
  | { kind: 'lobby' }
  | { kind: 'local'; role: Role }
  | { kind: 'room'; creds: RoomCredentials };

/** 读取地址栏：房间链接会被存到本机，然后从地址栏去掉，避免截图或分享时泄露 */
function resolveRoute(): Route {
  const hash = location.hash;
  const local = /^#local=(host|guest)$/.exec(hash);
  if (local) return { kind: 'local', role: local[1] as Role };
  const fromLink = parseRoomHash(hash);
  if (fromLink) {
    saveRoom(browserStore, fromLink);
    history.replaceState(null, '', location.pathname + location.search);
    return { kind: 'room', creds: fromLink };
  }
  const stored = loadRoom(browserStore);
  return stored ? { kind: 'room', creds: stored } : { kind: 'lobby' };
}

const pageBase = () => location.origin + location.pathname;

export function App() {
  const [route, setRoute] = useState(resolveRoute);
  useEffect(() => {
    const onHash = () => setRoute(resolveRoute());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  if (route.kind === 'local') return <LocalGame key={route.role} role={route.role} />;
  if (route.kind === 'room') {
    return (
      <RoomGame
        key={`${route.creds.room}-${route.creds.hostSecret ?? ''}`}
        creds={route.creds}
        onLeave={() => { clearRoom(browserStore); setRoute({ kind: 'lobby' }); }}
      />
    );
  }
  const enter = (creds: RoomCredentials) => {
    saveRoom(browserStore, creds);
    setRoute({ kind: 'room', creds });
  };
  return <Lobby onCreate={() => enter(createRoom())} onJoin={enter} />;
}

function Lobby({ onCreate, onJoin }: { onCreate: () => void; onJoin: (c: RoomCredentials) => void }) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const join = () => {
    const creds = parseRoomLink(text);
    if (creds) onJoin(creds);
    else setInvalid(true);
  };
  return (
    <main className="lobby">
      <h1>德州扑克单挑</h1>
      <p className="muted">两个人在线对战。房主创建房间后，把邀请链接发给朋友，朋友打开链接就能加入。</p>
      <button type="button" className="btn btn-raise" onClick={onCreate}>创建房间（我当房主）</button>

      <h2 className="lobby-sub">已经有链接？</h2>
      <p className="muted small">朋友粘贴邀请链接；房主换设备粘贴房主链接。从主屏幕图标第一次打开时也在这里粘贴。</p>
      <form className="paste-row" onSubmit={(e) => { e.preventDefault(); join(); }}>
        <input
          value={text} onChange={(e) => { setText(e.target.value); setInvalid(false); }}
          placeholder="粘贴链接" autoComplete="off" autoCapitalize="off" spellCheck={false} aria-label="房间链接"
        />
        <button type="submit" className="btn" disabled={!text.trim()}>进入</button>
      </form>
      {invalid && <p className="sheet-warn small">这不是有效的房间链接，请检查是否复制完整。</p>}

      <p className="muted small"><a className="link" href="#local=host">单机测试</a>（同一设备开两个标签页对打）</p>
    </main>
  );
}

/** 联机：通过加密中转连接 */
function RoomGame({ creds, onLeave }: { creds: RoomCredentials; onLeave: () => void }) {
  const [client, setClient] = useState<GameClient | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const host = isHost(creds);

  useEffect(() => {
    let disposed = false;
    let created: GameClient | null = null;
    (async () => {
      const keys = await deriveKeys(creds);
      const conn = new RoomConnection({ role: host ? 'host' : 'guest', keys, brokerUrl: BROKERS[creds.broker].url });      if (host) {
        // 先看服务器上有没有存档（换设备时用），再声明由这台设备当房主
        const remote = await conn.loadSave();
        if (disposed) { conn.close(); return; }
        conn.claimHost();
        created = new HostController(conn.asHost(), {
          remoteSave: isSavedGame(remote) ? remote : null,
          saveRemote: (saved) => conn.saveRemote(saved),
        });
      } else {
        created = new GuestClient(conn.asGuest());
      }
      if (disposed) created.dispose();
      else setClient(created);
    })().catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)));
    return () => { disposed = true; created?.dispose(); };
  }, [creds, host]);

  if (failure) return <div className="center-note">启动失败：{failure}</div>;
  if (!client) return <div className="center-note">正在连接…</div>;
  return <GameScreen client={client} creds={creds} onLeave={onLeave} />;
}

/** 单机测试：同一设备两个标签页 */
function LocalGame({ role }: { role: Role }) {
  const [client, setClient] = useState<GameClient | null>(null);
  useEffect(() => {
    const c = role === 'host' ? new HostController(createLocalTransport('host')) : new GuestClient(createLocalTransport('guest'));
    setClient(c);
    return () => c.dispose();
  }, [role]);
  return client ? <GameScreen client={client} creds={null} onLeave={() => { location.hash = ''; }} /> : null;
}

function GameScreen({ client, creds, onLeave }: { client: GameClient; creds: RoomCredentials | null; onLeave: () => void }) {
  const { view, error, connection, pending } = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [panel, setPanel] = useState<'invite' | 'hostLink' | 'install' | null>(null);
  const online = creds !== null;
  const host = client.role === 'host';
  useWakeLock(online);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => client.dismissError(), 3000);
    return () => clearTimeout(t);
  }, [error, client]);

  if (connection.superseded) {
    return (
      <main className="lobby">
        <h1>已在其他设备打开</h1>
        <p className="muted">房主在另一台设备上打开了这个房间，这台设备已停止。牌局进度在那台设备上继续。</p>
        <button type="button" className="btn btn-raise" onClick={() => location.reload()}>改回在这台设备上当房主</button>
      </main>
    );
  }

  return (
    <main className="game">
      {online && <StatusBanner role={client.role} connection={connection} hasView={view !== null} onInvite={() => setPanel('invite')} />}
      {view ? (
        <Table
          view={view}
          pending={pending}
          statusDot={online ? <StatusDot connection={connection} /> : null}
          onAct={(a) => client.act(a)}
          onNext={() => client.next()}
        />
      ) : (
        <div className="center-note">
          {online ? '正在等待房主…' : '正在连接房主…'}
          <div className="muted small">{online ? '房主打开游戏后会自动开始' : '请在另一个标签页以房主身份打开'}</div>
        </div>
      )}

      {creds && panel === 'invite' && (
        <LinkPanel
          title="邀请朋友"
          note="把这个链接私下发给朋友（例如微信）。朋友打开后就会进入这个房间。"
          url={guestLink(pageBase(), creds)}
          onClose={() => setPanel(null)}
        />
      )}
      {creds && panel === 'hostLink' && (
        <LinkPanel
          title="房主链接"
          note="换设备当房主时打开这个链接，牌局会接着打。只留给自己，不要发给任何人。"
          url={hostLink(pageBase(), creds)}
          warn
          onClose={() => setPanel(null)}
        />
      )}

      {creds && panel === 'install' && (
        <InstallPanel
          link={host ? hostLink(pageBase(), creds) : guestLink(pageBase(), creds)}
          isHostLink={host}
          onClose={() => setPanel(null)}
        />
      )}

      {error && <div className="toast" role="alert" onClick={() => client.dismissError()}>{error}</div>}

      <footer className="footer">
        <span className="muted small">{host ? '房主' : '玩家'}{online ? '' : '（单机测试）'}</span>
        {host && online && <button type="button" className="link small" onClick={() => setPanel('invite')}>邀请朋友</button>}
        {host && online && <button type="button" className="link small" onClick={() => setPanel('hostLink')}>换设备</button>}
        {online && !isStandalone() && (
          <button type="button" className="link small" onClick={() => setPanel('install')}>安装</button>
        )}
        {host && !online && <a className="link small" href="#local=guest" target="_blank" rel="noopener">打开玩家标签页</a>}
        {host && (
          <button
            type="button" className="link small"
            onClick={() => { if (confirm('确定清空当前对局，双方筹码和比分从头开始吗？')) (client as HostController).reset(); }}
          >重新开始</button>
        )}
        <button
          type="button" className="link small"
          onClick={() => {
            const msg = host && online
              ? '离开后这台设备不再是房主。以后要回来，需要打开房主链接（在"换设备"里）。确定离开吗？'
              : '确定离开这个房间吗？以后要回来，需要重新打开邀请链接。';
            if (confirm(msg)) onLeave();
          }}
        >离开</button>
      </footer>
    </main>
  );
}
