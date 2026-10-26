import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  browserStore, canNudge, type GameClient, GuestClient, HostController, isSavedGame, type KeyValueStore,
} from '../game/client';
import { AccountService, recordMatch, seatTokenFor, type Session } from '../net/accounts';
import { Broker, BROKERS, loadBrokerChoice, saveBrokerChoice } from '../net/broker';
import { type EcdhPair, generateEcdh, importKey } from '../net/crypto';
import { createLocalGuestTransport, createLocalHostTransport } from '../net/local';
import { hostKeyOf, listingFor, publishListing, roomKeyOf } from '../net/lobby';
import { GuestLink, HostLink } from '../net/room-conn';
import { inviteLink, parseInviteHash } from '../net/room';
import { Lobby, type RoomEntry } from './Lobby';
import { Login } from './Login';
import { isStandalone } from './pwa';
import { alertNudge, InstallPanel, LinkPanel, StatusBanner, StatusDot, useWakeLock } from './RoomUI';
import { Table } from './Table';

type LocalRole = 'host' | 'guest' | 'watch';

const parseLocal = (): LocalRole | null => /^#local=(host|guest|watch)$/.exec(location.hash)?.[1] as LocalRole ?? null;

const pageBase = () => location.origin + location.pathname;

const brokerUrl = () => BROKERS[loadBrokerChoice(browserStore)].url;

/** 账号和房间列表共用一条连接；进了房间另开一条（带掉线遗嘱） */
let mainBroker: Broker | null = null;
const getMainBroker = () => (mainBroker ??= new Broker({ url: brokerUrl() }));

const currentKey = (accountId: string) => `thp.v2.current.${accountId}`;

function loadCurrent(store: KeyValueStore, accountId: string): RoomEntry | null {
  const raw = store.get(currentKey(accountId));
  if (!raw) return null;
  try { return JSON.parse(raw) as RoomEntry; } catch { return null; }
}

const ecdhPending = new Map<string, Promise<EcdhPair>>();

/** 每个账号在每个房间用一对固定的密钥，刷新页面后还是同一个参与者 */
function ecdhFor(store: KeyValueStore, accountId: string, roomId: string): Promise<EcdhPair> {
  const key = `thp.v2.ecdh.${accountId}.${roomId}`;
  const raw = store.get(key);
  if (raw) {
    try { return Promise.resolve(JSON.parse(raw) as EcdhPair); } catch { /* 重新生成 */ }
  }
  // 同时进来两次（例如开发模式下组件挂载两次）也只生成一对
  let pending = ecdhPending.get(key);
  if (!pending) {
    pending = generateEcdh().then((pair) => { store.set(key, JSON.stringify(pair)); return pair; });
    ecdhPending.set(key, pending);
  }
  return pending;
}

export function App() {
  const [local, setLocal] = useState(parseLocal);
  useEffect(() => {
    const onHash = () => {
      // 页面开着时又打开了邀请链接：重新加载，按链接里的中转服务器重新连接
      if (parseInviteHash(location.hash)) location.reload();
      else setLocal(parseLocal());
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  if (local) return <LocalGame key={local} role={local} />;
  return <Online />;
}

function Online() {
  // 邀请链接：记下来再从地址栏去掉，登录后打开对应房间；房主用的中转服务器跟着换（要在连接之前）
  const [invite] = useState(() => {
    const parsed = parseInviteHash(location.hash);
    if (!parsed) return null;
    history.replaceState(null, '', location.pathname + location.search);
    saveBrokerChoice(browserStore, parsed.broker);
    return parsed.roomId;
  });
  const [accounts] = useState(() => new AccountService(getMainBroker(), browserStore));
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [entry, setEntry] = useState<RoomEntry | null>(null);

  useEffect(() => {
    void accounts.restore().then((s) => {
      setSession(s);
      if (s && !invite) setEntry(loadCurrent(browserStore, s.id));
    });
  }, [accounts, invite]);

  const enter = useCallback((e: RoomEntry | null) => {
    if (session) browserStore.set(currentKey(session.id), e ? JSON.stringify(e) : '');
    setEntry(e);
  }, [session]);

  // 战绩更新等会连续修改账号，用 ref 保证每次都在最新的基础上改
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const onMatchOver = useCallback((matchKey: string, won: boolean) => {
    const s = sessionRef.current;
    if (!s) return;
    const next = recordMatch(s.data, matchKey, won);
    if (next) void accounts.update(s, () => next).then(setSession);
  }, [accounts]);

  if (session === undefined) return <div className="center-note">正在加载…</div>;
  if (!session) return <Login accounts={accounts} onDone={setSession} />;
  if (entry) {
    return (
      <RoomGame
        key={`${entry.kind}-${entry.roomId}`} entry={entry} session={session}
        onLeave={() => enter(null)} onMatchOver={onMatchOver}
      />
    );
  }
  return (
    <Lobby
      bus={getMainBroker()} accounts={accounts} session={session} invite={invite}
      onSession={setSession} onEnter={enter}
      onLogout={() => { accounts.logout(); setSession(null); setEntry(null); }}
    />
  );
}

/** 联机：通过加密中转连接 */
function RoomGame({ entry, session, onLeave, onMatchOver }: {
  entry: RoomEntry;
  session: Session;
  onLeave: () => void;
  onMatchOver: (matchKey: string, won: boolean) => void;
}) {
  const [client, setClient] = useState<GameClient | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { username } = session.data;

  useEffect(() => {
    let disposed = false;
    let created: GameClient | null = null;
    (async () => {
      if (entry.kind === 'host') {
        const room = session.data.rooms.find((r) => r.roomId === entry.roomId);
        if (!room) throw new Error('这个房间已经解散了');
        const [roomKey, hostKey] = await Promise.all([roomKeyOf(room), hostKeyOf(room)]);
        if (disposed) return;
        const link = new HostLink({ roomId: room.roomId, roomKey, hostKey, ecdh: room.ecdh, brokerUrl: brokerUrl() });
        // 先看服务器上有没有存档（换设备时用），再声明由这台设备当房主
        const remote = await link.loadSave();
        if (disposed) { link.close(); return; }
        link.claimHost();
        created = new HostController(link, {
          name: username,
          roomName: room.name,
          maxWatchers: room.maxWatchers,
          saveKey: `thp.v2.host.${room.roomId}`,
          remoteSave: isSavedGame(remote) ? remote : null,
          saveRemote: (saved) => link.saveRemote(saved),
          onRoomChange: (s) => { void publishListing(getMainBroker(), listingFor(room, username, s.seats, s.watchers)); },
        });
      } else {
        const [roomKey, ecdh, token] = await Promise.all([
          importKey(entry.roomKey), ecdhFor(browserStore, session.id, entry.roomId), seatTokenFor(session.data, entry.roomId),
        ]);
        if (disposed) return;
        const link = new GuestLink({ roomId: entry.roomId, roomKey, hostPublic: entry.hostPublic, ecdh, brokerUrl: brokerUrl() });
        created = new GuestClient(link, { name: username, token, want: entry.want });
      }
      if (disposed) created.dispose();
      else setClient(created);
    })().catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)));
    return () => { disposed = true; created?.dispose(); };
    // 账号内容变化（例如记了战绩）不需要重连
  }, [entry]);

  if (failure) {
    return (
      <main className="lobby">
        <p>进不去房间：{failure}</p>
        <button type="button" className="btn" onClick={onLeave}>回到大厅</button>
      </main>
    );
  }
  if (!client) return <div className="center-note">正在连接…</div>;
  return (
    <GameScreen
      client={client} online inviteUrl={inviteLink(pageBase(), entry.roomId, loadBrokerChoice(browserStore))}
      onLeave={() => { client.leave(); onLeave(); }}
      onMatchOver={(epoch, matchNumber, won) => onMatchOver(`${entry.roomId}:${epoch}:${matchNumber}`, won)}
    />
  );
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
  const host = client.role === 'host';
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
        <p className="muted">你在另一台设备上以房主身份进入了这个房间，这台设备已停止。牌局进度在那台设备上继续。</p>
        <button type="button" className="btn btn-raise" onClick={() => location.reload()}>改回在这台设备上当房主</button>
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
      {online && (
        <StatusBanner
          role={client.role} connection={connection} opponent={room?.seats[1] ?? null} hasView={view !== null}
          onInvite={() => setPanel('invite')}
        />
      )}
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
          <div className="muted small">{online ? '房主在线时会自动进入' : '请在另一个标签页以房主身份打开'}</div>
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
              ? '离开后房间暂停，别人进不来。以后在大厅"我的房间"里可以回来。确定离开吗？'
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
