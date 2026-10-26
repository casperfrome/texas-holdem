import { buildApp } from './app';

const { app } = await buildApp({
  database: process.env.DB_PATH ?? 'data/game.sqlite',
  origin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173',
  logger: true,
});
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '127.0.0.1' });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
