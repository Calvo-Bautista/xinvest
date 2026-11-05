import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type * as schema from './schema';

export type Db = LibSQLDatabase<typeof schema>;
