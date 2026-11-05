import { eq, sql } from 'drizzle-orm';
import { integrations } from '../../db/schema';
import type { Db } from '../../db/types';
import type { TokenSet, TokenStore } from './client';
import { decryptJson, encryptJson } from './crypto';

export const IOL = 'iol';
type IntegrationRow = typeof integrations.$inferSelect;
type IntegrationPatch = Partial<Omit<IntegrationRow, 'provider' | 'updatedAt'>>;

export const integrationsRepo = (db: Db) => ({
  get: async (provider: string): Promise<IntegrationRow | undefined> =>
    (await db.select().from(integrations).where(eq(integrations.provider, provider)))[0],
  upsert: async (provider: string, patch: IntegrationPatch) => {
    const set = { ...patch, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` };
    await db
      .insert(integrations)
      .values({ provider, ...patch })
      .onConflictDoUpdate({ target: integrations.provider, set });
  },
});

/** Tokens de IOL persistidos cifrados en la tabla integrations. */
export function dbTokenStore(db: Db, secret: string): TokenStore {
  const repo = integrationsRepo(db);
  return {
    async load() {
      const row = await repo.get(IOL);
      return row?.tokenData ? decryptJson<TokenSet>(secret, row.tokenData) : null;
    },
    async save(tokens) {
      await repo.upsert(IOL, { tokenData: tokens ? await encryptJson(secret, tokens) : null });
    },
  };
}
