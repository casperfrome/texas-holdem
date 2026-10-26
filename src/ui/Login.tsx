import { useState } from 'react';
import { api } from '../net/server';
import type { User } from '../shared/server-protocol';

/** 登录 / 注册：只要用户名和密码 */
export function Login({ onDone }: { onDone: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ user: User }>(`/auth/${mode}`, 'POST', { username, password });
      onDone(result.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <main className="lobby">
      <h1>德州扑克</h1>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'tab-on' : ''} onClick={() => { setMode('login'); setError(null); }}>登录</button>
        <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'tab-on' : ''} onClick={() => { setMode('register'); setError(null); }}>注册</button>
      </div>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label>
          用户名
          <input
            value={username} onChange={(e) => setUsername(e.target.value)} maxLength={16}
            autoComplete="username" autoCapitalize="off" spellCheck={false} required
          />
        </label>
        <label>
          密码
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required
          />
        </label>
        {error && <p className="sheet-warn small" role="alert">{error}</p>}
        <button type="submit" className="btn btn-raise" disabled={busy || !username.trim() || !password}>
          {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>
      </form>
      <p className="muted small">账号、战绩和牌局保存在游戏服务器上。旧版账号需要重新注册。</p>
      <p className="muted small"><a className="link" href="#local=host">单机测试</a>（同一设备开几个标签页对打，不用登录）</p>
    </main>
  );
}
