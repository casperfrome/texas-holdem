// 测试用：内存里的"中转服务器"，支持保留消息和 + 通配符。多个 MemoryBus 可以连到同一个 MemoryServer。
import { type LinkStatus, type MessageHandler, type PubSub, type Subscription, topicMatches, type Will } from './broker';

export class MemoryServer {
  readonly retained = new Map<string, string>();
  readonly clients = new Set<MemoryBus>();

  deliver(topic: string, text: string, retain: boolean) {
    if (retain) {
      if (text) this.retained.set(topic, text);
      else this.retained.delete(topic);
    }
    for (const c of this.clients) c.receive(topic, text);
  }
}

export class MemoryBus implements PubSub {
  private readonly subs = new Map<string, Set<MessageHandler>>();
  private chain: Promise<unknown> = Promise.resolve();
  closed = false;

  constructor(readonly server = new MemoryServer()) {
    server.clients.add(this);
  }

  subscribe(filter: string, handler: MessageHandler): Subscription {
    let set = this.subs.get(filter);
    if (!set) this.subs.set(filter, (set = new Set()));
    set.add(handler);
    // 和真服务器一样：订阅后推送已有的保留消息
    const ready = Promise.resolve().then(() => {
      for (const [topic, text] of this.server.retained) if (topicMatches(filter, topic)) handler(topic, text);
    });
    return { ready, off: () => set.delete(handler) };
  }

  publish(topic: string, payload: string | Promise<string>, opts: { retain?: boolean } = {}): Promise<void> {
    const done = this.chain.then(async () => {
      const text = await payload;
      if (!this.closed) this.server.deliver(topic, text, opts.retain ?? false);
    });
    this.chain = done.catch(() => {});
    return done;
  }

  async fetchRetained(topic: string): Promise<string | null> {
    await this.chain;
    return this.server.retained.get(topic) ?? null;
  }

  forget() {}

  onStatus(handler: (s: LinkStatus) => void): () => void {
    handler('online');
    return () => {};
  }

  close(final?: Will | Promise<Will>) {
    void this.chain.then(async () => {
      const last = await final;
      if (last) this.server.deliver(last.topic, last.payload, last.retain);
      this.closed = true;
      this.server.clients.delete(this);
    });
  }

  receive(topic: string, text: string) {
    if (this.closed) return;
    for (const [filter, handlers] of this.subs) {
      if (topicMatches(filter, topic)) for (const h of handlers) h(topic, text);
    }
  }

  /** 等所有发送和收到的处理都完成 */
  settle = async () => {
    for (let i = 0; i < 20; i++) {
      await this.chain;
      await new Promise((r) => setTimeout(r, 0));
    }
  };
}
