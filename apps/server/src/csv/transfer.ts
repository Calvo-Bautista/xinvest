import { dec } from '@xinvest/domain';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { fxRatesRepo, instrumentsRepo, operationsRepo, pricesRepo } from '../db/repositories';
import { fxRates, instruments, operations, prices } from '../db/schema';
import type { Db } from '../db/types';
import { toInstrumentRow } from '../routes/instruments';
import { fxRateInput, instrumentInput, operationInput, priceInput } from '../schemas';
import { assertConsistent, toOperationRow } from '../services/operations';
import { parseCsv, toCsv } from './csv';

export const CSV_ENTITIES = ['instruments', 'operations', 'prices', 'fx_rates'] as const;
export type CsvEntity = (typeof CSV_ENTITIES)[number];

const COLUMNS: Record<CsvEntity, string[]> = {
  instruments: ['ticker', 'name', 'type', 'currency', 'price_divisor', 'cedear_ratio', 'notes'],
  operations: [
    'date',
    'type',
    'ticker',
    'quantity',
    'unit_price',
    'amount',
    'currency',
    'commission',
    'market_fees',
    'taxes',
    'notes',
    'external_id',
  ],
  prices: ['ticker', 'date', 'price', 'currency', 'source'],
  fx_rates: ['date', 'pair', 'rate', 'source'],
};

export async function exportCsv(db: Db, entity: CsvEntity): Promise<string> {
  const insts = await instrumentsRepo(db).list();
  const tickerOf = new Map(insts.map((i) => [i.id, i.ticker]));
  switch (entity) {
    case 'instruments':
      return toCsv(
        COLUMNS.instruments,
        insts.map((i) => ({
          ...i,
          price_divisor: i.priceDivisor,
          cedear_ratio: i.cedearRatio,
        })),
      );
    case 'operations':
      return toCsv(
        COLUMNS.operations,
        (await operationsRepo(db).list()).map((o) => ({
          ...o,
          ticker: o.instrumentId ? tickerOf.get(o.instrumentId) : '',
          unit_price: o.unitPrice,
          market_fees: o.marketFees,
          external_id: o.externalId,
        })),
      );
    case 'prices':
      return toCsv(
        COLUMNS.prices,
        (await pricesRepo(db).list()).map((p) => ({ ...p, ticker: tickerOf.get(p.instrumentId) })),
      );
    case 'fx_rates':
      return toCsv(COLUMNS.fx_rates, await fxRatesRepo(db).list());
  }
}

export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: number;
}

/** Acepta "1.234,56" (es-AR) además de "1234.56"; vacío → undefined. */
const num = (s: string | undefined) => {
  const v = (s ?? '').trim();
  if (!v) return undefined;
  return v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v;
};
const str = (s: string | undefined) => {
  const v = (s ?? '').trim();
  return v === '' ? undefined : v;
};

class RowErrors {
  readonly items: string[] = [];
  add(row: number, msg: string) {
    // +2: fila 1 es el header y las filas se cuentan desde 1
    this.items.push(`Fila ${row + 2}: ${msg}`);
  }
  check<T extends z.ZodType>(row: number, schema: T, data: unknown): z.infer<T> | undefined {
    const r = schema.safeParse(data);
    if (r.success) return r.data;
    this.add(
      row,
      r.error.issues.map((i) => `${i.path.join('.') || 'fila'}: ${i.message}`).join('; '),
    );
    return undefined;
  }
  throwIfAny() {
    if (this.items.length === 0) return;
    const shown = this.items.slice(0, 20);
    const more = this.items.length > 20 ? ` (y ${this.items.length - 20} más)` : '';
    throw new HTTPException(422, {
      res: Response.json(
        { error: `El CSV tiene errores, no se importó nada${more}.`, issues: shown },
        { status: 422 },
      ),
    });
  }
}

/**
 * Importa un CSV de forma atómica: primero valida TODAS las filas (forma + consistencia de la
 * historia) y recién después escribe, en una transacción.
 * - instrumentos: upsert por ticker
 * - precios / cotizaciones: upsert por clave natural
 * - operaciones: alta; se saltean duplicados (mismo external_id o misma operación exacta)
 */
export async function importCsv(db: Db, entity: CsvEntity, text: string): Promise<ImportResult> {
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(text);
  } catch (e) {
    throw new HTTPException(400, { message: (e as Error).message });
  }
  const missing = COLUMNS[entity].filter((c) => rows[0] && !(c in rows[0]));
  const required: Record<CsvEntity, string[]> = {
    instruments: ['ticker', 'type', 'currency'],
    operations: ['date', 'type', 'currency'],
    prices: ['ticker', 'date', 'price'],
    fx_rates: ['date', 'pair', 'rate'],
  };
  const missingRequired = required[entity].filter((c) => missing.includes(c));
  if (missingRequired.length) {
    throw new HTTPException(400, { message: `Faltan columnas: ${missingRequired.join(', ')}` });
  }

  const errors = new RowErrors();
  const insts = await instrumentsRepo(db).list();
  const idOf = new Map(insts.map((i) => [i.ticker, i.id]));
  const instrumentIdFor = (i: number, ticker: string | undefined) => {
    if (!ticker) return undefined;
    const id = idOf.get(ticker.toUpperCase());
    if (id == null) errors.add(i, `ticker ${ticker} no existe (importá instrumentos primero)`);
    return id;
  };

  switch (entity) {
    case 'instruments': {
      const parsed = rows.map((r, i) =>
        errors.check(i, instrumentInput, {
          ticker: r.ticker,
          name: str(r.name) ?? null,
          type: r.type?.toUpperCase(),
          currency: r.currency?.toUpperCase(),
          priceDivisor: num(r.price_divisor),
          cedearRatio: num(r.cedear_ratio) ?? null,
          notes: str(r.notes) ?? null,
        }),
      );
      errors.throwIfAny();
      const result: ImportResult = { inserted: 0, updated: 0, skipped: 0 };
      await db.transaction(async (tx) => {
        for (const p of parsed) {
          // biome-ignore lint/style/noNonNullAssertion: validado arriba
          const row = toInstrumentRow(p!);
          if (idOf.has(row.ticker)) result.updated++;
          else result.inserted++;
          await tx
            .insert(instruments)
            .values(row)
            .onConflictDoUpdate({ target: instruments.ticker, set: row });
        }
      });
      return result;
    }

    case 'prices': {
      const parsed = rows.map((r, i) => {
        const instrumentId = instrumentIdFor(i, r.ticker);
        const p = errors.check(i, priceInput, {
          instrumentId: instrumentId ?? 0,
          date: r.date,
          price: num(r.price),
          currency: str(r.currency)?.toUpperCase(),
        });
        return p && { ...p, source: str(r.source) ?? 'manual' };
      });
      errors.throwIfAny();
      const currencyOf = new Map(insts.map((i) => [i.id, i.currency]));
      await db.transaction(async (tx) => {
        for (const p of parsed) {
          // biome-ignore lint/style/noNonNullAssertion: validado arriba
          const v = { ...p!, currency: p!.currency ?? currencyOf.get(p!.instrumentId)! };
          await tx
            .insert(prices)
            .values(v)
            .onConflictDoUpdate({
              target: [prices.instrumentId, prices.date, prices.source],
              set: { price: v.price, currency: v.currency },
            });
        }
      });
      return { inserted: parsed.length, updated: 0, skipped: 0 };
    }

    case 'fx_rates': {
      const parsed = rows.map((r, i) => {
        const p = errors.check(i, fxRateInput, {
          date: r.date,
          pair: r.pair?.toUpperCase(),
          rate: num(r.rate),
        });
        return p && { ...p, source: str(r.source) ?? 'manual' };
      });
      errors.throwIfAny();
      await db.transaction(async (tx) => {
        for (const p of parsed) {
          // biome-ignore lint/style/noNonNullAssertion: validado arriba
          const v = p!;
          await tx
            .insert(fxRates)
            .values(v)
            .onConflictDoUpdate({
              target: [fxRates.date, fxRates.pair, fxRates.source],
              set: { rate: v.rate },
            });
        }
      });
      return { inserted: parsed.length, updated: 0, skipped: 0 };
    }

    case 'operations': {
      const existing = await operationsRepo(db).list();
      const keyOf = (o: {
        date: string;
        type: string;
        instrumentId: number | null;
        quantity: string | null;
        unitPrice: string | null;
        amount: string | null;
        currency: string;
        commission: string;
        marketFees: string;
        taxes: string;
      }) =>
        [
          o.date,
          o.type,
          o.instrumentId ?? '',
          ...[o.quantity, o.unitPrice, o.amount].map((v) => (v == null ? '' : dec(v).toFixed())),
          o.currency,
          ...[o.commission, o.marketFees, o.taxes].map((v) => dec(v).toFixed()),
        ].join('|');
      const seenKeys = new Set(existing.map(keyOf));
      const seenExt = new Set(existing.map((o) => o.externalId).filter(Boolean));

      const toInsert: ReturnType<typeof toOperationRow>[] = [];
      let skipped = 0;
      rows.forEach((r, i) => {
        const type = r.type?.toUpperCase();
        const needsInstrument = type !== 'DEPOSIT' && type !== 'WITHDRAWAL';
        const input = errors.check(i, operationInput, {
          date: r.date,
          type,
          currency: r.currency?.toUpperCase(),
          instrumentId: needsInstrument ? (instrumentIdFor(i, r.ticker) ?? 0) : undefined,
          quantity: num(r.quantity),
          unitPrice: num(r.unit_price),
          amount: num(r.amount),
          commission: num(r.commission),
          marketFees: num(r.market_fees),
          taxes: num(r.taxes),
          notes: str(r.notes) ?? null,
          externalId: str(r.external_id) ?? null,
        });
        if (!input) return;
        const row = toOperationRow(input);
        const key = keyOf(row);
        if ((row.externalId && seenExt.has(row.externalId)) || seenKeys.has(key)) {
          skipped++;
          return;
        }
        seenKeys.add(key);
        if (row.externalId) seenExt.add(row.externalId);
        toInsert.push(row);
      });
      errors.throwIfAny();
      await assertConsistent(db, { extra: toInsert.map((r) => ({ ...r, source: 'csv' })) });
      await db.transaction(async (tx) => {
        for (const row of toInsert) await tx.insert(operations).values({ ...row, source: 'csv' });
      });
      return { inserted: toInsert.length, updated: 0, skipped };
    }
  }
}
