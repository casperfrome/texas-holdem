// 房主和玩家之间的消息格式。传输层（本地标签页 / MQTT 中转）只负责把这些消息送到对面。
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
  | {
    t: 'state';
    /** 对局编号：房主重新开始时改变 */
    epoch: string;
    /** 同一对局内单调递增 */
    version: number;
    /** 房主已处理的玩家消息序号，玩家据此停止重发 */
    ackSeq: number;
    view: PlayerView;
  }
  | { t: 'reject'; seq: number; message: string };

export interface Envelope {
  v: typeof PROTOCOL_VERSION;
  from: Role;
  msg: GuestMessage | HostMessage;
}

export interface ConnectionInfo {
  /** 自己和中转服务器的连接 */
  self: 'connecting' | 'online' | 'offline';
  /** 对方是否在线（根据对方的在线记录） */
  peer: 'unknown' | 'online' | 'offline';
  /** 房主在另一台设备上打开了，这里不再生效 */
  superseded: boolean;
}

export const LOCAL_CONNECTION: ConnectionInfo = { self: 'online', peer: 'unknown', superseded: false };

/** 双向消息通道。In 是收到的消息类型，Out 是发出的消息类型 */
export interface Transport<In, Out> {
  send(msg: Out): void;
  /** 返回取消订阅的函数 */
  onMessage(handler: (msg: In) => void): () => void;
  /** 连接状态变化；本地传输没有这个 */
  onConnection?(handler: (info: ConnectionInfo) => void): () => void;
  close(): void;
}

export type HostTransport = Transport<GuestMessage, HostMessage>;
export type GuestTransport = Transport<HostMessage, GuestMessage>;
