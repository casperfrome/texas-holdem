// 房主和玩家之间的消息格式。传输层（本地标签页 / 以后的 MQTT）只负责把这些消息送到对面。
import type { Action, PlayerView } from '../engine';

export const PROTOCOL_VERSION = 1;

export type Role = 'host' | 'guest';

/** 玩家 → 房主 */
export type GuestMessage =
  | { t: 'hello' }
  | { t: 'action'; seq: number; action: Action }
  /** 下一手 / 再来一局 */
  | { t: 'next'; seq: number };

/** 房主 → 玩家。每次都发完整画面，断线重连后不需要补发中间的消息 */
export type HostMessage =
  | { t: 'state'; version: number; view: PlayerView }
  | { t: 'reject'; seq: number; message: string };

export interface Envelope {
  v: typeof PROTOCOL_VERSION;
  from: Role;
  msg: GuestMessage | HostMessage;
}

/** 双向消息通道。In 是收到的消息类型，Out 是发出的消息类型 */
export interface Transport<In, Out> {
  send(msg: Out): void;
  /** 返回取消订阅的函数 */
  onMessage(handler: (msg: In) => void): () => void;
  close(): void;
}

export type HostTransport = Transport<GuestMessage, HostMessage>;
export type GuestTransport = Transport<HostMessage, GuestMessage>;
