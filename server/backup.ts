import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const folder = process.env.BACKUP_DIR ?? 'backups';
mkdirSync(folder, { recursive: true });
const database = new Database(process.env.DB_PATH ?? 'data/game.sqlite', { readonly: true, fileMustExist: true });
const path = join(folder, `game-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
await database.backup(path);
database.close();
for (const name of readdirSync(folder)) {
  const file = join(folder, name);
  if (/^game-[\dTZ-]+\.sqlite$/.test(name) && Date.now() - statSync(file).mtimeMs > 7 * 86400_000) unlinkSync(file);
}
console.log(`Backup saved: ${path}`);
