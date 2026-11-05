import { migrate } from 'drizzle-orm/libsql/migrator';
import { createNodeDb, databaseUrl, MIGRATIONS_FOLDER } from './node-client';

const url = databaseUrl();
const db = await createNodeDb(url);
await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
console.log(`Migraciones aplicadas en ${url.replace(/\?.*$/, '')}`);
