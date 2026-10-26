import type { Action, PlayerView, Seat } from '../engine';

export interface User {
  id: string;
  username: string;
  stats: { won: number; lost: number };
}

export interface ServerRoom {
  roomId: string;
  name: string;
  ownerId: string;
  ownerName: string;
  locked: boolean;
  seats: [string | null, string | null];
  online: [boolean, boolean];
  watchers: number;
  maxWatchers: number;
}

export interface RoomState {
  t: 'state';
  v: 3;
  room: ServerRoom;
  seat: Seat | null;
  owner: boolean;
  watcherNames: string[];
  epoch: string;
  version: number;
  view: PlayerView;
  remainingMs: number | null;
  stats: User['stats'];
}

export type Command = {
  t: 'command';
  v: 3;
  id: string;
  roomId: string;
  epoch: string;
  version: number;
} & (
  | { op: 'action'; action: Action }
  | { op: 'next' | 'sit' | 'stand' | 'nudge' | 'reset' }
);

export type ServerEvent = RoomState
  | { t: 'lobby'; rooms: ServerRoom[]; user: User }
  | { t: 'ack'; id: string; error?: string }
  | { t: 'error'; error: string }
  | { t: 'closed'; error: string }
  | { t: 'superseded' }
  | { t: 'nudge'; from: string };
