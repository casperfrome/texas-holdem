import { useEffect, useState, useSyncExternalStore } from 'react';
import { type GameClient, GuestClient, HostController } from '../game/client';
import { createLocalTransport } from '../net/local';
import type { Role } from '../net/protocol';
import { Table } from './Table';

function useHashRole(): Role | null {
  const read = (): Role | null => {
    const h = location.hash.slice(1);
    return h === 'host' || h === 'guest' ? h : null;
  };
  const [role, setRole] = useState(read);
  useEffect(() => {
    const onHash = () => setRole(read());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  return role;
}

export function App() {
  const role = useHashRole();
  return role ? <Game key={role} role={role} /> : <Lobby />;
}

function Lobby() {
  return (
    <main className="lobby">
      <h1>德州扑克单挑</h1>
      <p className="muted">单机测试版：在同一台设备上开两个标签页，一个当房主，一个当玩家，互相对打。</p>
      <a className="btn btn-raise" href="#host">以房主身份进入</a>
      <a className="btn btn-call" href="#guest" target="_blank" rel="noopener">在新标签页打开玩家</a>
      <p className="muted small">房主负责洗牌发牌并保存进度，刷新页面会接着打。</p>
    </main>
  );
}

function Game({ role }: { role: Role }) {
  // 在 effect 里创建：卸载时（包括开发模式下 StrictMode 的二次挂载）能正确释放连接
  const [client, setClient] = useState<GameClient | null>(null);
  useEffect(() => {
    const c = role === 'host' ? new HostController(createLocalTransport('host')) : new GuestClient(createLocalTransport('guest'));
    setClient(c);
    return () => c.dispose();
  }, [role]);
  return client ? <GameScreen client={client} role={role} /> : null;
}

function GameScreen({ client, role }: { client: GameClient; role: Role }) {
  const { view, error } = useSyncExternalStore(client.subscribe, client.getSnapshot);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => client.dismissError(), 3000);
    return () => clearTimeout(t);
  }, [error, client]);

  return (
    <main className="game">
      {view ? (
        <Table view={view} onAct={(a) => client.act(a)} onNext={() => client.next()} />
      ) : (
        <div className="center-note">
          正在连接房主…
          <div className="muted small">请在另一个标签页以房主身份打开</div>
        </div>
      )}
      {error && <div className="toast" role="alert" onClick={() => client.dismissError()}>{error}</div>}
      <footer className="footer">
        <span className="muted small">{role === 'host' ? '房主' : '玩家'}</span>
        {role === 'host' && (
          <>
            <a className="link small" href="#guest" target="_blank" rel="noopener">打开玩家标签页</a>
            <button
              type="button" className="link small"
              onClick={() => { if (confirm('确定清空当前对局，从头开始吗？')) (client as HostController).reset(); }}
            >重新开始</button>
          </>
        )}
      </footer>
    </main>
  );
}
