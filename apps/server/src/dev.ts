import { serve } from '@hono/node-server';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { authConfigFromEnv, createApp } from './app';
import { authEnabled } from './auth';
import { createNodeDb, databaseUrl, MIGRATIONS_FOLDER } from './db/node-client';

const url = databaseUrl();
const db = await createNodeDb(url);
// En dev aplicamos migraciones pendientes al arrancar.
await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

const auth = authConfigFromEnv(process.env);
if (!auth.sessionSecret) auth.sessionSecret = 'dev-only-secret-not-for-production-use!!';
const app = createApp({ db, auth });
const port = Number(process.env.API_PORT ?? 8787);

serve({ fetch: app.fetch, port }, () => {
  console.log(`API en http://localhost:${port}/api  ·  DB: ${url}`);
  if (!authEnabled(auth)) console.log('Auth deshabilitada (APP_PASSWORD vacío, modo dev).');
});
