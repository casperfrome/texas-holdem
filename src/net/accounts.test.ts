import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from '../game/client';
import { accountId, accountTopic, AccountService, normalizeUsername, recordMatch, seatTokenFor } from './accounts';
import { MemoryBus, MemoryServer } from './test-bus';

const ITER = 1000; // 测试里用少量迭代，跑得快

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return { get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

function device(server: MemoryServer, store = memoryStore()) {
  return { accounts: new AccountService(new MemoryBus(server), store, ITER), store };
}

describe('账号', () => {
  it('注册后在另一台设备用同样的用户名密码登录', async () => {
    const server = new MemoryServer();
    const a = device(server);
    const s = await a.accounts.register(' 小王 ', 'x');
    expect(s.data.username).toBe('小王');
    // 服务器上只有密文
    const stored = server.retained.get(accountTopic(s.id))!;
    expect(stored).not.toContain('小王');

    const b = device(server);
    const t = await b.accounts.login('小王', 'x');
    expect(t.data.seatToken).toBe(s.data.seatToken);
    // 用户名不区分大小写
    expect(await accountId('Bob')).toBe(await accountId('bob'));
  });

  it('用户名重复、密码不对、用户不存在都给出提示', async () => {
    const server = new MemoryServer();
    const { accounts } = device(server);
    await accounts.register('小王', 'x');
    await expect(accounts.register('小王', 'y')).rejects.toThrow('已经被注册');
    await expect(device(server).accounts.login('小王', 'y')).rejects.toThrow('密码不对');
    await expect(device(server).accounts.login('老李', 'y')).rejects.toThrow('先注册');
    expect(() => normalizeUsername('   ')).toThrow('请输入用户名');
    expect(() => normalizeUsername('一二三四五六七八九十一二三四五六七')).toThrow('最多 16 个字');
  });

  it('下次打开免登录；退出后需要重新登录', async () => {
    const server = new MemoryServer();
    const a = device(server);
    await a.accounts.register('小王', 'x');
    const again = new AccountService(new MemoryBus(server), a.store, ITER);
    expect((await again.restore())?.data.username).toBe('小王');
    again.logout();
    expect(await again.restore()).toBeNull();
  });

  it('服务器丢了记录：登录时用本机副本补回去', async () => {
    const server = new MemoryServer();
    const a = device(server);
    const s = await a.accounts.register('小王', 'x');
    server.retained.clear();
    await a.accounts.login('小王', 'x');
    expect(server.retained.has(accountTopic(s.id))).toBe(true);
  });

  it('另一台设备改过的内容，刷新后能拿到', async () => {
    const server = new MemoryServer();
    const a = device(server);
    const s = await a.accounts.register('小王', 'x');
    const b = device(server);
    const t = await b.accounts.login('小王', 'x');
    await b.accounts.update(t, (d) => ({ ...d, stats: { won: 3, lost: 1 } }));
    const refreshed = await a.accounts.refresh(s);
    expect(refreshed.data.stats).toEqual({ won: 3, lost: 1 });
  });

  it('战绩同一局只记一次；不同房间的座位凭证不同', async () => {
    const { accounts } = device(new MemoryServer());
    const s = await accounts.register('小王', 'x');
    const once = recordMatch(s.data, 'room:e:1', true)!;
    expect(once.stats).toEqual({ won: 1, lost: 0 });
    expect(recordMatch(once, 'room:e:1', true)).toBeNull();
    expect(recordMatch(once, 'room:e:2', false)!.stats).toEqual({ won: 1, lost: 1 });
    expect(await seatTokenFor(s.data, 'room-a')).not.toBe(await seatTokenFor(s.data, 'room-b'));
  });
});
