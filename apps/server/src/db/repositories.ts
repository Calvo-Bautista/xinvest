import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { fxRates, instruments, operations, prices } from './schema';
import type { Db } from './types';

type NewInstrument = typeof instruments.$inferInsert;
type NewOperation = typeof operations.$inferInsert;
type NewPrice = typeof prices.$inferInsert;
type NewFxRate = typeof fxRates.$inferInsert;

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const instrumentsRepo = (db: Db) => ({
  list: () => db.select().from(instruments).orderBy(asc(instruments.ticker)),
  get: async (id: number) => (await db.select().from(instruments).where(eq(instruments.id, id)))[0],
  getByTicker: async (ticker: string) =>
    (await db.select().from(instruments).where(eq(instruments.ticker, ticker)))[0],
  create: async (data: NewInstrument) =>
    // biome-ignore lint/style/noNonNullAssertion: returning de un insert siempre trae la fila
    (await db.insert(instruments).values(data).returning())[0]!,
  update: async (id: number, data: Partial<NewInstrument>) =>
    (
      await db
        .update(instruments)
        .set({ ...data, updatedAt: now })
        .where(eq(instruments.id, id))
        .returning()
    )[0],
  remove: async (id: number) =>
    (await db.delete(instruments).where(eq(instruments.id, id)).returning()).length > 0,
  countOperations: async (id: number) =>
    (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(operations)
        .where(eq(operations.instrumentId, id))
    )[0]?.n ?? 0,
});

export const operationsRepo = (db: Db) => ({
  list: () => db.select().from(operations).orderBy(asc(operations.date), asc(operations.id)),
  /** Listado para la UI: más recientes primero, con ticker. */
  listWithTicker: () =>
    db
      .select({ op: operations, ticker: instruments.ticker })
      .from(operations)
      .leftJoin(instruments, eq(operations.instrumentId, instruments.id))
      .orderBy(desc(operations.date), desc(operations.id)),
  get: async (id: number) => (await db.select().from(operations).where(eq(operations.id, id)))[0],
  create: async (data: NewOperation) =>
    // biome-ignore lint/style/noNonNullAssertion: returning de un insert siempre trae la fila
    (await db.insert(operations).values(data).returning())[0]!,
  update: async (id: number, data: Partial<NewOperation>) =>
    (
      await db
        .update(operations)
        .set({ ...data, updatedAt: now })
        .where(eq(operations.id, id))
        .returning()
    )[0],
  remove: async (id: number) =>
    (await db.delete(operations).where(eq(operations.id, id)).returning()).length > 0,
});

export const pricesRepo = (db: Db) => ({
  list: (opts: { instrumentId?: number; to?: string } = {}) =>
    db
      .select()
      .from(prices)
      .where(
        and(
          opts.instrumentId != null ? eq(prices.instrumentId, opts.instrumentId) : undefined,
          opts.to ? lte(prices.date, opts.to) : undefined,
        ),
      )
      .orderBy(asc(prices.instrumentId), asc(prices.date)),
  upsert: (data: NewPrice) =>
    db
      .insert(prices)
      .values(data)
      .onConflictDoUpdate({
        target: [prices.instrumentId, prices.date, prices.source],
        set: { price: data.price, currency: data.currency },
      }),
  remove: async (instrumentId: number, date: string, source = 'manual') =>
    (
      await db
        .delete(prices)
        .where(
          and(
            eq(prices.instrumentId, instrumentId),
            eq(prices.date, date),
            eq(prices.source, source),
          ),
        )
        .returning()
    ).length > 0,
});

export const fxRatesRepo = (db: Db) => ({
  list: (opts: { to?: string } = {}) =>
    db
      .select()
      .from(fxRates)
      .where(opts.to ? lte(fxRates.date, opts.to) : undefined)
      .orderBy(asc(fxRates.date), asc(fxRates.pair)),
  upsert: (data: NewFxRate) =>
    db
      .insert(fxRates)
      .values(data)
      .onConflictDoUpdate({
        target: [fxRates.date, fxRates.pair, fxRates.source],
        set: { rate: data.rate },
      }),
  remove: async (date: string, pair: 'USD_MEP' | 'USD_CCL', source = 'manual') =>
    (
      await db
        .delete(fxRates)
        .where(and(eq(fxRates.date, date), eq(fxRates.pair, pair), eq(fxRates.source, source)))
        .returning()
    ).length > 0,
});
