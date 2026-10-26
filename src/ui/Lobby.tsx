import { useEffect, useState } from 'react';
import type { PubSub } from '../net/broker';
import { exportKey } from '../net/crypto';
import type { AccountService, HostedRoom, Session } from '../net/accounts';
import {
  createHostedRoom, listingFor, type LobbyRoom, publishListing, removeListing, type RoomListing, unlockRoom, watchLobby,
} from '../net/lobby';
import type { Want } from '../net/protocol';
import { BrokerPicker } from './RoomUI';

export type RoomEntry =
  | { kind: 'host'; roomId: string }
  | { kind: 'guest'; roomId: string; name: string; roomKey: string; hostPublic: JsonWebKey; want: Want };

const WATCHER_CHOICES = [0, 2, 5, 10];

interface Props {
  bus: PubSub;
  accounts: AccountService;
  session: Session;
  /** 从邀请链接进来时要打开的房间 */
  invite: string | null;
  onSession: (s: Session) => void;
  onEnter: (entry: RoomEntry) => void;
  onLogout: () => void;
}

export function Lobby({ bus, accounts, session, invite, onSession, onEnter, onLogout }: Props) {
  const [rooms, setRooms] = useState<LobbyRoom[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState<RoomListing | null>(null);
  const [pendingInvite, setPendingInvite] = useState(invite);
  const { username, stats } = session.data;
  const mine = new Set(session.data.rooms.map((r) => r.roomId));

  useEffect(() => watchLobby(bus, setRooms), [bus]);

  // 别的设备上建的房间也要出现在"我的房间"里
  useEffect(() => {
    accounts.refresh(session).then((s) => { if (s !== session) onSession(s); }).catch(() => {});
  }, []);

  // 邀请链接：房间出现在列表里后直接打开进房窗口
  useEffect(() => {
    if (!pendingInvite || !rooms) return;
    const room = rooms.find((r) => r.roomId === pendingInvite);
    if (!room) return;
    setPendingInvite(null);
    if (mine.has(room.roomId)) onEnter({ kind: 'host', roomId: room.roomId });
    else setJoining(room);
  }, [rooms, pendingInvite]);

  const dissolve = async (room: HostedRoom) => {
    if (!confirm(`确定解散"${room.name}"吗？房间会从列表里消失，牌局进度也不再保留。`)) return;
    await removeListing(bus, room.roomId);
    onSession(await accounts.update(session, (d) => ({ ...d, rooms: d.rooms.filter((r) => r.roomId !== room.roomId) })));
  };

  const others = (rooms ?? []).filter((r) => !mine.has(r.roomId));
  const online = new Map((rooms ?? []).map((r) => [r.roomId, r]));

  return (
    <main className="lobby lobby-wide">
      <header className="lobby-head">
        <h1>德州扑克</h1>
        <div className="me">
          <strong>{username}</strong>
          <span className="muted small">胜 {stats.won} · 负 {stats.lost}</span>
          <button type="button" className="link small" onClick={() => { if (confirm('确定退出登录吗？')) onLogout(); }}>退出登录</button>
        </div>
      </header>

      <button type="button" className="btn btn-raise" onClick={() => setCreating(true)}>创建房间</button>

      {session.data.rooms.length > 0 && (
        <section>
          <h2 className="lobby-sub">我的房间</h2>
          <ul className="room-list">
            {session.data.rooms.map((r) => {
              const live = online.get(r.roomId);
              return (
                <li key={r.roomId} className="room-row">
                  <div className="room-main">
                    <span className="room-name">{r.locked && <span aria-label="有密码">🔒 </span>}{r.name}</span>
                    <span className="muted small">
                      {live?.seats[1] ? `对手：${live.seats[1]}` : '还没有对手'} · 观战席 {r.maxWatchers === 0 ? '不开放' : `${live?.watchers ?? 0}/${r.maxWatchers}`}
                    </span>
                  </div>
                  <div className="room-actions">
                    <button type="button" className="btn btn-small btn-raise" onClick={() => onEnter({ kind: 'host', roomId: r.roomId })}>进入</button>
                    <button type="button" className="link small danger" onClick={() => { void dissolve(r); }}>解散</button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <h2 className="lobby-sub">房间列表</h2>
        {rooms === null ? (
          <p className="muted small">正在加载…</p>
        ) : others.length === 0 ? (
          <p className="muted small">现在还没有别人的房间。可以自己建一个，把邀请链接发给朋友。</p>
        ) : (
          <ul className="room-list">
            {others.map((r) => (
              <li key={r.roomId}>
                <button type="button" className="room-row room-button" aria-label={`进入 ${r.name}`} onClick={() => setJoining(r)}>
                  <div className="room-main">
                    <span className="room-name">
                      <span className={`status-dot ${r.online ? 'status-online' : 'status-offline'}`} title={r.online ? '房主在线' : '房主不在线'} />
                      {r.locked && <span aria-label="有密码">🔒 </span>}{r.name}
                    </span>
                    <span className="muted small">
                      {r.seats[0]} vs {r.seats[1] ?? '空位'} · 观战 {r.maxWatchers === 0 ? '不开放' : `${r.watchers}/${r.maxWatchers}`}
                      {r.online ? '' : ' · 房主不在线'}
                    </span>
                  </div>
                  <span className="room-go">›</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BrokerPicker />
      <p className="muted small"><a className="link" href="#local=host">单机测试</a>（同一设备开几个标签页对打）</p>

      {creating && (
        <CreateRoomSheet
          defaultName={`${username}的房间`}
          onClose={() => setCreating(false)}
          onCreate={async (opts) => {
            const room = await createHostedRoom(opts);
            const next = await accounts.update(session, (d) => ({ ...d, rooms: [...d.rooms, room] }));
            onSession(next);
            await publishListing(bus, listingFor(room, username, [username, null], 0));
            onEnter({ kind: 'host', roomId: room.roomId });
          }}
        />
      )}
      {joining && <JoinSheet room={joining} onClose={() => setJoining(null)} onEnter={onEnter} />}
    </main>
  );
}

function CreateRoomSheet({ defaultName, onClose, onCreate }: {
  defaultName: string;
  onClose: () => void;
  onCreate: (opts: { name: string; password: string; maxWatchers: number }) => Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const [password, setPassword] = useState('');
  const [maxWatchers, setMaxWatchers] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name, password, maxWatchers });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet form" role="dialog" aria-label="创建房间" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h2>创建房间</h2>
        <label>
          房间名
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
        </label>
        <label>
          房间密码<span className="muted small">（留空 = 不要密码，谁都能进）</span>
          <input value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </label>
        <fieldset className="choices">
          <legend>观战席</legend>
          {WATCHER_CHOICES.map((n) => (
            <button
              key={n} type="button" className={maxWatchers === n ? 'choice-on' : ''} aria-pressed={maxWatchers === n}
              onClick={() => setMaxWatchers(n)}
            >{n === 0 ? '不开放' : `${n} 人`}</button>
          ))}
        </fieldset>
        <p className="muted small">观众看得到公共牌和下注，看不到任何人的底牌（摊牌时除外）。</p>
        {error && <p className="sheet-warn small" role="alert">{error}</p>}
        <div className="sheet-buttons">
          <button type="submit" className="btn btn-raise" disabled={busy}>{busy ? '正在创建…' : '创建并进入'}</button>
          <button type="button" className="btn" onClick={onClose}>取消</button>
        </div>
      </form>
    </div>
  );
}

function JoinSheet({ room, onClose, onEnter }: { room: RoomListing; onClose: () => void; onEnter: (e: RoomEntry) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seatFree = room.seats[1] === null;
  const watchFree = room.watchers < room.maxWatchers;

  const join = async (want: Want) => {
    setBusy(true);
    setError(null);
    const key = await unlockRoom(room, password);
    if (!key) {
      setError('密码不对');
      setBusy(false);
      return;
    }
    onEnter({ kind: 'guest', roomId: room.roomId, name: room.name, roomKey: await exportKey(key), hostPublic: room.hostPublic, want });
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet form" role="dialog" aria-label="进入房间" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (seatFree || watchFree) void join(seatFree ? 'play' : 'watch'); }}>
        <h2>{room.name}</h2>
        <p className="muted">房主 {room.seats[0]} · 对手 {room.seats[1] ?? '空位'} · 观战 {room.maxWatchers === 0 ? '不开放' : `${room.watchers}/${room.maxWatchers}`}</p>
        {room.locked && (
          <label>
            房间密码
            <input
              value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} autoFocus
              autoComplete="off" autoCapitalize="off" spellCheck={false}
            />
          </label>
        )}
        {error && <p className="sheet-warn small" role="alert">{error}</p>}
        {!seatFree && !watchFree && <p className="sheet-warn small">座位和观战席都满了。</p>}
        <div className="sheet-buttons">
          <button type="button" className="btn btn-raise" disabled={busy || !seatFree} onClick={() => { void join('play'); }}>
            {seatFree ? '坐下打牌' : '座位已满'}
          </button>
          <button type="button" className="btn" disabled={busy || !watchFree} onClick={() => { void join('watch'); }}>
            {room.maxWatchers === 0 ? '不开放观战' : watchFree ? '观战' : '观战席已满'}
          </button>
          <button type="button" className="btn" onClick={onClose}>取消</button>
        </div>
      </form>
    </div>
  );
}
