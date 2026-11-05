import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Montos y cantidades se guardan como TEXT con un decimal canónico ("1234.5678").
 * SQLite no tiene tipo decimal y REAL es float binario: nunca se usa para dinero.
 * Las agregaciones se hacen en el dominio con decimal.js, no con SUM() en SQL.
 */
const decimal = (name: string) => text(name);
const timestamps = {
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
};

export const instruments = sqliteTable(
  'instruments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ticker: text('ticker').notNull().unique(),
    name: text('name'),
    type: text('type', {
      enum: ['STOCK', 'CEDEAR', 'BOND', 'ON', 'FCI', 'CAUCION', 'OTHER'],
    }).notNull(),
    currency: text('currency', { enum: ['ARS', 'USD_MEP', 'USD_CCL'] }).notNull(),
    priceDivisor: decimal('price_divisor').notNull().default('1'),
    cedearRatio: decimal('cedear_ratio'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    check(
      'instruments_type_chk',
      sql`${t.type} IN ('STOCK','CEDEAR','BOND','ON','FCI','CAUCION','OTHER')`,
    ),
    check('instruments_currency_chk', sql`${t.currency} IN ('ARS','USD_MEP','USD_CCL')`),
  ],
);

export const operations = sqliteTable(
  'operations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    date: text('date').notNull(),
    type: text('type', {
      enum: ['BUY', 'SELL', 'DIVIDEND', 'COUPON', 'AMORTIZATION', 'DEPOSIT', 'WITHDRAWAL'],
    }).notNull(),
    instrumentId: integer('instrument_id').references(() => instruments.id, {
      onDelete: 'restrict',
    }),
    quantity: decimal('quantity'),
    unitPrice: decimal('unit_price'),
    amount: decimal('amount'),
    currency: text('currency', { enum: ['ARS', 'USD_MEP', 'USD_CCL'] }).notNull(),
    commission: decimal('commission').notNull().default('0'),
    marketFees: decimal('market_fees').notNull().default('0'),
    taxes: decimal('taxes').notNull().default('0'),
    notes: text('notes'),
    source: text('source', { enum: ['manual', 'csv', 'iol'] })
      .notNull()
      .default('manual'),
    /** Fase 2: id de la operación en IOL, para que el sync sea idempotente. */
    externalId: text('external_id').unique(),
    ...timestamps,
  },
  (t) => [
    index('operations_date_idx').on(t.date),
    index('operations_instrument_idx').on(t.instrumentId),
    check(
      'operations_shape_chk',
      sql`(
        (${t.type} IN ('BUY','SELL') AND ${t.instrumentId} IS NOT NULL AND ${t.quantity} IS NOT NULL AND ${t.unitPrice} IS NOT NULL AND ${t.amount} IS NULL)
        OR (${t.type} IN ('DIVIDEND','COUPON','AMORTIZATION') AND ${t.instrumentId} IS NOT NULL AND ${t.amount} IS NOT NULL AND ${t.quantity} IS NULL AND ${t.unitPrice} IS NULL)
        OR (${t.type} IN ('DEPOSIT','WITHDRAWAL') AND ${t.instrumentId} IS NULL AND ${t.amount} IS NOT NULL AND ${t.quantity} IS NULL AND ${t.unitPrice} IS NULL)
      )`,
    ),
  ],
);

export const prices = sqliteTable(
  'prices',
  {
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    price: decimal('price').notNull(),
    currency: text('currency', { enum: ['ARS', 'USD_MEP', 'USD_CCL'] }).notNull(),
    source: text('source').notNull().default('manual'),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.date, t.source] })],
);

export const fxRates = sqliteTable(
  'fx_rates',
  {
    date: text('date').notNull(),
    pair: text('pair', { enum: ['USD_MEP', 'USD_CCL'] }).notNull(),
    /** ARS por 1 USD */
    rate: decimal('rate').notNull(),
    source: text('source').notNull().default('manual'),
  },
  (t) => [primaryKey({ columns: [t.date, t.pair, t.source] })],
);

/**
 * Estado de integraciones externas (hoy sólo IOL). En serverless no hay memoria entre
 * requests, así que los tokens OAuth viven acá, cifrados con AES-GCM.
 */
export const integrations = sqliteTable('integrations', {
  provider: text('provider').primaryKey(),
  /** JSON cifrado con los tokens (ver adapters/iol/crypto.ts). */
  tokenData: text('token_data'),
  lastOperationsSyncAt: text('last_operations_sync_at'),
  /** Fecha (YYYY-MM-DD) hasta la que se sincronizaron operaciones. */
  lastOperationsSyncTo: text('last_operations_sync_to'),
  lastPricesSyncAt: text('last_prices_sync_at'),
  lastPricesSyncTo: text('last_prices_sync_to'),
  /** JSON con el resumen de la última sincronización (para la UI). */
  lastResult: text('last_result'),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export type InstrumentRow = typeof instruments.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;
export type PriceRow = typeof prices.$inferSelect;
export type FxRateRow = typeof fxRates.$inferSelect;
