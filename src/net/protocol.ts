// 房主和参与者（对手、观众）之间的消息格式。传输层（本地标签页 / MQTT 中转）只负责把这些消息送到对面。
import type { Action, PlayerView, Seat } from '../engine';

export const PROTOCOL_VERSION = 2;

export type Role = 'host' | 'guest';

/** 进房时想坐下打还是观战 */
export type Want = 'play' | 'watch';

/** 参与者 → 房主 */
export type GuestMessage =
  /** 进房 / 重新连上：报上名字和座位凭证；凭证和座位上的人一致就认回座位 */
  | { t: 'hello'; name: string; token: string; want: Want }
  | { t: 'action'; seq: number; action: Action }
  /** 下一手 / 再来一局 */
  | { t: 'next'; seq: number }
  /** 观众坐到空座位上 */
  | { t: 'sit'; seq: number }
  /** 玩家站起来变成观众；这一局就此结束 */
  | { t: 'stand'; seq: number }
  /** 催对手快点 */
  | { t: 'nudge' }
  /** 离开房间：玩家让出座位，观众让出观战席 */
  | { t: 'bye' };

export type SeatedMessage = Extract<GuestMessage, { seq: number }>;

export interface RoomInfo {
  name: string;
  /** 0 号位是房主，1 号位为 null 表示空位 */
  seats: [string | null, string | null];
  /** 在线服务器上的房间管理权限，独立于座位 */
  owner?: boolean;
  /** 观众的名字 */
  watchers: string[];
  maxWatchers: number;
  /** 收到这条消息的人自己的身份 */
  you: 'host' | 'player' | 'watcher';
}

/** 轮到谁、还剩多久。用剩余时间而不是时刻，两台设备的时钟不一致也没关系 */
export interface TurnInfo {
  seat: Seat;
  remainingMs: number;
}

/** 房主 → 参与者。每次都发完整画面，断线重连后不需要补发中间的消息 */
export type HostMessage =
  | {
    t: 'state';
    /** 对局编号：重新开始或换了对手时改变 */
    epoch: string;
    /** 同一对局内单调递增 */
    version: number;
    /** 房主已处理的这位参与者的消息序号，据此停止重发 */
    ackSeq: number;
    room: RoomInfo;
    view: PlayerView;
    turn: TurnInfo | null;
  }
  | { t: 'reject'; seq: number; message: string }
  /** 对手催你了 */
  | { t: 'nudge'; from: string }
  /** 不让进（观战席已满等），不要再重试 */
  | { t: 'denied'; message: string }
  /** 房主不认识你（例如房主刚换了设备）：请重新打招呼 */
  | { t: 'rehello' };

export interface ConnectionInfo {
  /** 自己和中转服务器的连接 */
  self: 'connecting' | 'online' | 'offline';
  /** 对方是否在线：参与者看房主，房主看坐在对面的玩家 */
  peer: 'unknown' | 'online' | 'offline';
  /** 房主在另一台设备上打开了，这里不再生效 */
  superseded: boolean;
}

export const LOCAL_CONNECTION: ConnectionInfo = { self: 'online', peer: 'unknown', superseded: false };

/** 房主这一端：可以发给任意参与者，收到的消息带着发送者编号 */
export interface HostTransport {
  send(to: string, msg: HostMessage): void;
  /** 清掉发给某人的保留画面（观众离开后） */
  forget?(to: string): void;
  onMessage(handler: (from: string, msg: GuestMessage) => void): () => void;
  /** 参与者上线 / 掉线 */
  onPresence?(handler: (from: string, online: boolean) => void): () => void;
  /** 自己的连接状态；本地传输没有这个 */
  onConnection?(handler: (info: ConnectionInfo) => void): () => void;
  close(): void;
}

/** 参与者这一端：只和房主通信 */
export interface GuestTransport {
  send(msg: GuestMessage): void;
  onMessage(handler: (msg: HostMessage) => void): () => void;
  onConnection?(handler: (info: ConnectionInfo) => void): () => void;
  close(): void;
}
