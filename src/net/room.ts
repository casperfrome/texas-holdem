// 邀请链接：#room=<房间号>，房主用的不是默认中转服务器时再加 &b=<中转服务器>。
// 只是快捷方式，打开后照常登录，再输入房间密码（如果有）。放在 # 后面，不会发给托管网站。
import { type BrokerId, DEFAULT_BROKER, isBrokerId } from './broker';
import { ROOM_ID_RE } from './lobby';

export interface Invite {
  roomId: string;
  broker: BrokerId;
}

export function parseInviteHash(hash: string): Invite | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const room = params.get('room');
  if (!room || !ROOM_ID_RE.test(room)) return null;
  const b = params.get('b');
  return { roomId: room, broker: isBrokerId(b) ? b : DEFAULT_BROKER };
}

export const inviteLink = (base: string, roomId: string, broker: BrokerId) =>
  `${base}#room=${roomId}${broker === DEFAULT_BROKER ? '' : `&b=${broker}`}`;
