import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { User } from '../src/shared/server-protocol';

export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL, won INTEGER NOT NULL DEFAULT 0, lost INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (
        room_id TEXT NOT NULL, user_id TEXT NOT NULL, id TEXT NOT NULL,
        error TEXT, created INTEGER NOT NULL, PRIMARY KEY(room_id,user_id,id)
      );
      CREATE TABLE IF NOT EXISTS results (
        id TEXT PRIMARY KEY, winner TEXT NOT NULL, loser TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  }
  user(id: string): User {
    const row = this.db.prepare('SELECT id,name,won,lost FROM users WHERE id=?').get(id) as
      { id: string; name: string; won: number; lost: number } | undefined;
    if (!row) throw new Error('账号不存在');
    return { id: row.id, username: row.name, stats: { won: row.won, lost: row.lost } };
  }
  saveRoom(room: { id: string }) {
    this.db.prepare('INSERT INTO rooms(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(room.id, JSON.stringify(room));
  }
  result(id: string, winner: string, loser: string) {
    if (this.db.prepare('INSERT OR IGNORE INTO results VALUES(?,?,?)').run(id, winner, loser).changes) {
      this.db.prepare('UPDATE users SET won=won+1 WHERE id=?').run(winner);
      this.db.prepare('UPDATE users SET lost=lost+1 WHERE id=?').run(loser);
    }
  }
  close() { this.db.close(); }
}
