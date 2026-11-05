/**
 * Sincronización con IOL:
 *  - Operaciones: trae movimientos, los mapea, detecta los ya importados (external_id) y los que
 *    ya cargaste a mano (los "vincula" en vez de duplicarlos), valida la historia resultante y
 *    recién entonces escribe. Soporta dry-run para previsualizar.
 *  - Precios: cierres diarios de cada instrumento + dólar MEP/CCL implícito de AL30.
 */
import {
  Dec,
  DomainError,
  dec,
  type Instrument,
  type Operation,
  validateOperations,
} from '@xinvest/domain';
import { eq, inArray } from 'drizzle-orm';
import type { IolActivity, IolClient, IolOperation } from '../adapters/iol/client';
import {
  type MappedOperation,
  mapIolActivities,
  type UnmappedActivity,
} from '../adapters/iol/mapping';
import { IOL, integrationsRepo } from '../adapters/iol/store';
import { toInstrument, toOperation } from '../db/mappers';
import { instrumentsRepo, operationsRepo } from '../db/repositories';
import { fxRates, instruments, operations, prices } from '../db/schema';
import type { Db } from '../db/types';
import { todayAR } from '../serialize';

const DAY = 86_400_000;
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Partes [from, to] en tramos de `size` días (la API exige rango y no documenta el máximo). */
export function dateChunks(from: string, to: string, size = 180): [string, string][] {
  const out: [string, string][] = [];
  for (let start = from; start <= to; start = addDays(start, size)) {
    const end = addDays(start, size - 1);
    out.push([start, end < to ? end : to]);
  }
  return out;
}

type BatchItem = Parameters<Db['batch']>[0][number];

/**
 * Ejecuta muchas sentencias en un solo viaje a la DB (db.batch es atómico en libSQL).
 * Con Turso, hacer cientos de inserts sueltos superaría el límite de tiempo de la función.
 */
async function runBatch(db: Db, items: BatchItem[]): Promise<unknown[]> {
  if (items.length === 0) return [];
  return db.batch(items as [BatchItem, ...BatchItem[]]);
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      // biome-ignore lint/style/noNonNullAssertion: idx < length
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- operaciones

export type PreviewStatus = 'new' | 'linked' | 'existing';
export interface PreviewRow {
  externalId: string;
  status: PreviewStatus;
  linkedOperationId: number | null;
  date: string;
  type: MappedOperation['type'];
  ticker: string | null;
  quantity: string | null;
  unitPrice: string | null;
  amount: string | null;
  currency: MappedOperation['currency'];
  fees: string;
  notes: string;
}

export interface OperationsSyncReport {
  from: string;
  to: string;
  dryRun: boolean;
  applied: boolean;
  rows: PreviewRow[];
  newInstruments: { ticker: string; type: string; priceDivisor: string }[];
  unmapped: UnmappedActivity[];
  counts: { new: number; linked: number; existing: number; unmapped: number };
  /** Si la historia resultante es inconsistente (p. ej. venta sin compra previa) no se aplica. */
  validationError: string | null;
}

const isTrade = (t: string) => t === 'BUY' || t === 'SELL';

/** ¿La operación cargada a mano es la misma que vino de IOL? */
function sameOperation(
  manual: Operation,
  m: MappedOperation,
  instrumentId: number | null,
): boolean {
  if (manual.date !== m.date || manual.type !== m.type || manual.instrumentId !== instrumentId) {
    return false;
  }
  if (isTrade(m.type)) return manual.quantity?.eq(m.quantity ?? '0') ?? false;
  if (manual.amount == null || m.amount == null) return false;
  // Montos: tolerancia de 1 % (el neto de IOL puede diferir por redondeos o gastos)
  return manual.amount.minus(m.amount).abs().lte(dec(m.amount).times('0.01'));
}

export async function syncIolOperations(
  db: Db,
  client: IolClient,
  opts: { from: string; to: string; dryRun: boolean },
): Promise<OperationsSyncReport> {
  const { from, to, dryRun } = opts;
  const acts: IolActivity[] = [];
  const iolOps: IolOperation[] = [];
  for (const [a, b] of dateChunks(from, to)) {
    const [x, y] = await Promise.all([client.activities(a, b), client.operations(a, b)]);
    acts.push(...x);
    iolOps.push(...y);
  }
  const mapped = mapIolActivities(acts, iolOps);

  const [instRows, opRows] = await Promise.all([
    instrumentsRepo(db).list(),
    operationsRepo(db).list(),
  ]);
  const byTicker = new Map(instRows.map((i) => [i.ticker, i]));
  const existingExt = new Set(opRows.map((o) => o.externalId).filter(Boolean));
  const linkPool = opRows.filter((o) => !o.externalId).map(toOperation);

  // Instrumentos nuevos (ids temporales negativos para validar antes de insertar)
  const newInstruments = new Map<
    string,
    { id: number; hint: NonNullable<MappedOperation['instrument']> }
  >();
  let tempInst = -1;
  const instrumentIdOf = (m: MappedOperation): number | null => {
    if (!m.ticker || !m.instrument) return null;
    const existing = byTicker.get(m.ticker);
    if (existing) return existing.id;
    let n = newInstruments.get(m.ticker);
    if (!n) {
      n = { id: tempInst--, hint: m.instrument };
      newInstruments.set(m.ticker, n);
    }
    return n.id;
  };

  const rows: PreviewRow[] = [];
  const toInsert: { m: MappedOperation; instrumentId: number | null }[] = [];
  const toLink: { operationId: number; externalId: string }[] = [];
  for (const m of mapped.operations) {
    const instrumentId = instrumentIdOf(m);
    let status: PreviewStatus = 'new';
    let linkedOperationId: number | null = null;
    if (existingExt.has(m.externalId)) status = 'existing';
    else {
      const idx = linkPool.findIndex((o) => sameOperation(o, m, instrumentId));
      if (idx >= 0) {
        // biome-ignore lint/style/noNonNullAssertion: idx válido
        linkedOperationId = linkPool[idx]!.id;
        linkPool.splice(idx, 1);
        status = 'linked';
        toLink.push({ operationId: linkedOperationId, externalId: m.externalId });
      } else toInsert.push({ m, instrumentId });
    }
    rows.push({
      externalId: m.externalId,
      status,
      linkedOperationId,
      date: m.date,
      type: m.type,
      ticker: m.ticker,
      quantity: m.quantity,
      unitPrice: m.unitPrice,
      amount: m.amount,
      currency: m.currency,
      fees: dec(m.commission).plus(m.marketFees).plus(m.taxes).toFixed(),
      notes: m.notes,
    });
  }

  // Validar la historia completa con lo nuevo
  let validationError: string | null = null;
  const allInstruments: Instrument[] = [
    ...instRows.map(toInstrument),
    ...[...newInstruments.entries()].map(([ticker, n]) => ({
      id: n.id,
      ticker,
      name: n.hint.name,
      type: n.hint.type,
      currency: n.hint.currency,
      priceDivisor: dec(n.hint.priceDivisor),
      cedearRatio: null,
    })),
  ];
  let tempOp = Number.MAX_SAFE_INTEGER - 10_000_000;
  const hypothetical: Operation[] = [
    ...opRows.map(toOperation),
    ...toInsert.map(({ m, instrumentId }) => ({
      id: tempOp++,
      date: m.date,
      type: m.type,
      instrumentId,
      quantity: m.quantity != null ? dec(m.quantity) : null,
      unitPrice: m.unitPrice != null ? dec(m.unitPrice) : null,
      amount: m.amount != null ? dec(m.amount) : null,
      currency: m.currency,
      commission: dec(m.commission),
      marketFees: dec(m.marketFees),
      taxes: dec(m.taxes),
    })),
  ];
  try {
    validateOperations(allInstruments, hypothetical);
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    validationError = `${e.message}. Probablemente la posición se compró antes de ${from}: sincronizá desde una fecha anterior o cargá la compra original a mano.`;
  }

  const applied = !dryRun && !validationError;
  if (applied) {
    // 1) instrumentos nuevos (necesitamos sus ids), 2) vínculos + operaciones en un solo batch atómico
    const realIds = new Map<number, number>();
    const newList = [...newInstruments.entries()];
    if (newList.length) {
      const inserted = await runBatch(
        db,
        newList.map(([ticker, n]) =>
          db
            .insert(instruments)
            .values({
              ticker,
              name: n.hint.name,
              type: n.hint.type,
              currency: n.hint.currency,
              priceDivisor: n.hint.priceDivisor,
              notes: 'Creado por la sincronización con IOL',
            })
            .returning({ id: instruments.id }),
        ),
      );
      newList.forEach(([, n], k) => {
        const id = (inserted[k] as { id: number }[] | undefined)?.[0]?.id;
        if (id != null) realIds.set(n.id, id);
      });
    }
    await runBatch(db, [
      ...toLink.map((l) =>
        db
          .update(operations)
          .set({ externalId: l.externalId })
          .where(eq(operations.id, l.operationId)),
      ),
      ...toInsert.map(({ m, instrumentId }) =>
        db.insert(operations).values({
          date: m.date,
          type: m.type,
          instrumentId:
            instrumentId != null && instrumentId < 0
              ? (realIds.get(instrumentId) ?? null)
              : instrumentId,
          quantity: m.quantity,
          unitPrice: m.unitPrice,
          amount: m.amount,
          currency: m.currency,
          commission: m.commission,
          marketFees: m.marketFees,
          taxes: m.taxes,
          notes: m.notes,
          source: 'iol',
          externalId: m.externalId,
        }),
      ),
    ]);
  }

  const counts = {
    new: rows.filter((r) => r.status === 'new').length,
    linked: rows.filter((r) => r.status === 'linked').length,
    existing: rows.filter((r) => r.status === 'existing').length,
    unmapped: mapped.unmapped.length,
  };
  if (applied) {
    await integrationsRepo(db).upsert(IOL, {
      lastOperationsSyncAt: new Date().toISOString(),
      lastOperationsSyncTo: to,
      lastResult: JSON.stringify({ kind: 'operations', from, to, counts }),
    });
  }
  return {
    from,
    to,
    dryRun,
    applied,
    rows: rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    newInstruments: [...newInstruments.entries()].map(([ticker, n]) => ({
      ticker,
      type: n.hint.type,
      priceDivisor: n.hint.priceDivisor,
    })),
    unmapped: mapped.unmapped,
    counts,
    validationError,
  };
}

/** Desde dónde sincronizar operaciones si no se indica: 10 días antes de la última sync. */
export async function defaultOperationsFrom(db: Db): Promise<string | null> {
  const row = await integrationsRepo(db).get(IOL);
  return row?.lastOperationsSyncTo ? addDays(row.lastOperationsSyncTo, -10) : null;
}

// ---------------------------------------------------------------- precios

/** Ticker de la especie que cotiza en la moneda del instrumento. */
export function quoteSymbol(i: { ticker: string; type: string; currency: string }): string {
  if (i.currency === 'ARS') return i.ticker;
  const suffix = i.currency === 'USD_CCL' ? 'C' : 'D';
  return i.type === 'ON' && i.ticker.endsWith('O')
    ? `${i.ticker.slice(0, -1)}${suffix}`
    : `${i.ticker}${suffix}`;
}

export interface PricesSyncReport {
  from: string;
  to: string;
  instruments: { ticker: string; symbol: string; points: number; error?: string }[];
  fx: { mep: number; ccl: number; error?: string };
}

const SKIP_PRICE_TYPES = new Set(['CAUCION', 'FCI']);

export async function syncIolPrices(
  db: Db,
  client: IolClient,
  opts: { from?: string; to?: string } = {},
): Promise<PricesSyncReport> {
  const to = opts.to ?? todayAR();
  const state = await integrationsRepo(db).get(IOL);
  const opRows = await operationsRepo(db).list();
  const firstDate = opRows[0]?.date ?? addDays(to, -365);
  const from =
    opts.from ?? (state?.lastPricesSyncTo ? addDays(state.lastPricesSyncTo, -5) : firstDate);

  const usedIds = [
    ...new Set(opRows.map((o) => o.instrumentId).filter((x): x is number => x != null)),
  ];
  const insts = usedIds.length
    ? await db.select().from(instruments).where(inArray(instruments.id, usedIds))
    : [];

  const writes: (typeof prices.$inferInsert)[] = [];
  const results = await pool(
    insts.filter((i) => !SKIP_PRICE_TYPES.has(i.type)),
    4,
    async (i) => {
      const symbol = quoteSymbol(i);
      try {
        const bars = await client.dailyCloses(symbol, from, to);
        for (const b of bars) {
          if (b.close > 0) {
            writes.push({
              instrumentId: i.id,
              date: b.date,
              price: new Dec(String(b.close)).toFixed(),
              currency: i.currency,
              source: 'iol',
            });
          }
        }
        return { ticker: i.ticker, symbol, points: bars.length };
      } catch (e) {
        return { ticker: i.ticker, symbol, points: 0, error: (e as Error).message };
      }
    },
  );
  const skipped = insts
    .filter((i) => SKIP_PRICE_TYPES.has(i.type))
    .map((i) => ({
      ticker: i.ticker,
      symbol: '—',
      points: 0,
      error:
        i.type === 'FCI'
          ? 'FCI: el valor de cuotaparte se carga a mano'
          : 'Caución: no necesita precio',
    }));

  // Dólar implícito: MEP = AL30 (ARS) / AL30D (USD), CCL = AL30 / AL30C. Ambos cotizan cada 100 VN.
  const fxWrites: (typeof fxRates.$inferInsert)[] = [];
  const fx: PricesSyncReport['fx'] = { mep: 0, ccl: 0 };
  try {
    const [ars, mep, ccl] = await Promise.all(
      ['AL30', 'AL30D', 'AL30C'].map((s) => client.dailyCloses(s, from, to)),
    );
    const arsBy = new Map((ars ?? []).map((b) => [b.date, b.close]));
    for (const [pair, series] of [
      ['USD_MEP', mep],
      ['USD_CCL', ccl],
    ] as const) {
      for (const b of series ?? []) {
        const p = arsBy.get(b.date);
        if (!p || b.close <= 0) continue;
        const rate = new Dec(String(p)).div(String(b.close)).toDecimalPlaces(2).toFixed();
        fxWrites.push({ date: b.date, pair, rate, source: 'iol' });
        if (pair === 'USD_MEP') fx.mep++;
        else fx.ccl++;
      }
    }
  } catch (e) {
    fx.error = (e as Error).message;
  }

  await runBatch(db, [
    ...writes.map((w) =>
      db
        .insert(prices)
        .values(w)
        .onConflictDoUpdate({
          target: [prices.instrumentId, prices.date, prices.source],
          set: { price: w.price, currency: w.currency },
        }),
    ),
    ...fxWrites.map((w) =>
      db
        .insert(fxRates)
        .values(w)
        .onConflictDoUpdate({
          target: [fxRates.date, fxRates.pair, fxRates.source],
          set: { rate: w.rate },
        }),
    ),
  ]);

  const report: PricesSyncReport = { from, to, instruments: [...results, ...skipped], fx };
  await integrationsRepo(db).upsert(IOL, {
    lastPricesSyncAt: new Date().toISOString(),
    lastPricesSyncTo: to,
  });
  return report;
}
