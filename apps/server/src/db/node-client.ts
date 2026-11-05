import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema';
import type { Db } from './types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** URL de la DB. Por defecto, archivo SQLite en <repo>/data/xinvest.db. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL || 'file:./data/xinvest.db';
  if (!url.startsWith('file:')) return url;
  // Rutas relativas se resuelven desde la raíz del repo, no desde el cwd del workspace.
  const path = resolve(ROOT, url.slice('file:'.length));
  mkdirSync(dirname(path), { recursive: true });
  return `file:${path}`;
}

/** Cliente para Node (dev local, scripts). Soporta file: y libsql:// (Turso). */
export async function createNodeDb(url = databaseUrl()): Promise<Db> {
  const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
  await client.execute('PRAGMA foreign_keys = ON');
  return drizzle(client, { schema });
}

export const MIGRATIONS_FOLDER = resolve(ROOT, 'apps/server/drizzle');
