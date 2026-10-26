import { useEffect, useState } from 'react';
import { api, ServerConnection } from '../net/server';
import type { ServerRoom, User } from '../shared/server-protocol';

export function Lobby({ user, invite, onEnter, onUser, onLogout }: {
  user: User; invite: string | null; onEnter: (id: string) => void; onUser: (user: User) => void; onLogout: () => void;
}) {
  const [rooms, setRooms] = useState<ServerRoom[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState<ServerRoom | null>(null);
  const [pendingInvite, setPendingInvite] = useState(invite);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState('connecting');
  useEffect(() => {
    const socket = new ServerConnection((event) => {
      if (event.t === 'lobby') { setRooms(event.rooms); onUser(event.user); setLoaded(true); }
    }, setConnection);
    return () => socket.close();
  }, [onUser]);
  useEffect(() => {
    if (!pendingInvite || !loaded) return;
    const room = rooms.find((r) => r.roomId === pendingInvite);
    setPendingInvite(null);
    if (room) setJoining(room);
    else setError('邀请对应的房间不存在或已解散。旧版房间不能在新服务器继续使用。');
  }, [pendingInvite, loaded, rooms]);
  const dissolve = async (room: ServerRoom) => {
    if (!confirm(`确定解散“${room.name}”吗？未完成的牌局不计战绩。`)) return;
    try { await api(`/rooms/${room.roomId}`, 'DELETE'); } catch (e) { setError((e as Error).message); }
  };
  const section = (title: string, items: ServerRoom[], mine: boolean) => (
    <section><h2 className="lobby-sub">{title}</h2><ul className="room-list">
      {items.map((room) => <li key={room.roomId} className="room-row">
        <button type="button" className="room-main room-button" onClick={() => setJoining(room)} aria-label={`进入 ${room.name}`}>
          <span className="room-name">{room.locked ? '🔒 ' : ''}{room.name}</span>
          <span className="muted small">{room.seats[0] ?? '空位'} vs {room.seats[1] ?? '空位'} · 观战 {room.watchers}/{room.maxWatchers}</span>
        </button><div className="room-actions"><button type="button" className="btn btn-small btn-raise" onClick={() => setJoining(room)}>进入</button>
          {mine && <button type="button" className="link small danger" onClick={() => { void dissolve(room); }}>解散</button>}</div>
      </li>)}
    </ul>{loaded && !items.length && <p className="muted small">暂无房间，可以创建一个邀请朋友。</p>}</section>
  );
  return <main className="lobby lobby-wide">
    <header className="lobby-head"><h1>德州扑克</h1><div className="me"><strong>{user.username}</strong><span className="muted small">胜 {user.stats.won} · 负 {user.stats.lost}</span>
      <button type="button" className="link small" onClick={onLogout}>退出登录</button></div></header>
    {connection !== 'online' && <p role="status" className="sheet-warn">正在连接游戏服务器…</p>}
    {error && <p role="alert" className="sheet-warn">{error}</p>}
    <button type="button" className="btn btn-raise" onClick={() => setCreating(true)}>创建房间</button>
    {section('我的房间', rooms.filter((r) => r.ownerId === user.id), true)}
    {section('房间列表', rooms.filter((r) => r.ownerId !== user.id), false)}
    <p className="muted small">服务器负责发牌和保存进度。断线保留座位 60 秒，期间仍会自动行动。</p>
    <p className="muted small"><a className="link" href="#local=host">单机测试</a>（同一浏览器开几个标签页对打）</p>
    {creating && <CreateRoom onClose={() => setCreating(false)} username={user.username} onEnter={onEnter} />}
    {joining && <JoinRoom room={joining} onClose={() => setJoining(null)} onEnter={onEnter} />}
  </main>;
}
function CreateRoom({ username, onClose, onEnter }: { username: string; onClose: () => void; onEnter: (id: string) => void }) {
  const [name, setName] = useState(`${username}的房间`);
  const [password, setPassword] = useState('');
  const [maxWatchers, setMaxWatchers] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try { const result = await api<{ room: ServerRoom }>('/rooms', 'POST', { name, password, maxWatchers }); onEnter(result.room.roomId); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <div className="sheet-backdrop" onClick={onClose}>
    <form className="sheet form" role="dialog" aria-label="创建房间" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2>创建房间</h2><label>房间名<input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} required /></label>
      <label>房间密码<span className="muted small">（留空 = 任何人可以加入）</span><input value={password} onChange={(e) => setPassword(e.target.value)} maxLength={1024} autoComplete="off" /></label>
      <fieldset className="choices"><legend>观战席</legend>{[0, 2, 5, 10].map((n) => <button key={n} type="button" className={n === maxWatchers ? 'choice-on' : ''} aria-pressed={n === maxWatchers} onClick={() => setMaxWatchers(n)}>{n === 0 ? '不开放' : `${n} 人`}</button>)}</fieldset>
      <p className="muted small">玩家只能看到自己的底牌；观众在摊牌前看不到双方底牌。</p>
      {error && <p role="alert" className="sheet-warn">{error}</p>}
      <div className="sheet-buttons"><button type="submit" className="btn btn-raise" disabled={busy}>{busy ? '正在创建…' : '创建并进入'}</button><button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button></div>
    </form></div>;
}
function JoinRoom({ room, onClose, onEnter }: { room: ServerRoom; onClose: () => void; onEnter: (id: string) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = async (want: 'play' | 'watch') => {
    setBusy(true); setError(null);
    try { await api(`/rooms/${room.roomId}/join`, 'POST', { password, want }); onEnter(room.roomId); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <div className="sheet-backdrop" onClick={onClose}>
    <form className="sheet form" role="dialog" aria-label="进入房间" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void join('play'); }}>
      <h2>{room.name}</h2><p className="muted small">{room.seats[0] ?? '空位'} vs {room.seats[1] ?? '空位'} · 观战 {room.watchers}/{room.maxWatchers}</p>
      {room.locked && <label>房间密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={1024} autoComplete="off" /></label>}
      {error && <p role="alert" className="sheet-warn">{error}</p>}
      <div className="sheet-buttons"><button type="submit" className="btn btn-raise" disabled={busy}>{busy ? '正在进入…' : '坐下打牌 / 回到座位'}</button>
        {room.maxWatchers > 0 && <button type="button" className="btn" disabled={busy} onClick={() => { void join('watch'); }}>观战</button>}
        <button type="button" className="link" onClick={onClose} disabled={busy}>取消</button></div>
    </form></div>;
}
