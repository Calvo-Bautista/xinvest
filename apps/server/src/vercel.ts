/**
 * Entry de Vercel (Node.js function). Usa el cliente libSQL "web" (HTTP puro, sin binarios
 * nativos) para hablar con Turso. Lo empaqueta scripts/build-vercel.mjs con esbuild.
 */
import { getRequestListener } from '@hono/node-server';
import { createClient } from '@libsql/client/web';
import { drizzle } from 'drizzle-orm/libsql/web';
import { authConfigFromEnv, createApp } from './app';
import * as schema from './db/schema';

const url = process.env.DATABASE_URL;
if (!url || url.startsWith('file:')) {
  throw new Error('DATABASE_URL debe apuntar a Turso (libsql://...) en Vercel');
}

const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
const db = drizzle(client, { schema });
const app = createApp({ db, auth: authConfigFromEnv(process.env) });

export default getRequestListener(app.fetch);
