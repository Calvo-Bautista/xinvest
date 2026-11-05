import type {
  FxPair,
  FxRatePoint,
  FxRateProvider,
  Instrument,
  PricePoint,
  PriceProvider,
} from '@xinvest/domain';
import { toFxRatePoint, toPricePoint } from '../db/mappers';
import { fxRatesRepo, pricesRepo } from '../db/repositories';
import type { Db } from '../db/types';

/**
 * Si para la misma clave (instrumento/par + fecha) hay varias fuentes, gana la carga manual:
 * es una corrección explícita del usuario sobre lo que trajo IOL.
 */
export function preferManual<T extends { source: string }>(rows: T[], key: (r: T) => string): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const cur = best.get(k);
    if (!cur || (r.source === 'manual' && cur.source !== 'manual')) best.set(k, r);
  }
  return [...best.values()];
}

/**
 * Precios desde la tabla `prices`: cargados a mano (source = 'manual') o traídos de IOL por la
 * sincronización (source = 'iol'). La historia siempre sale de la DB, así el timeline funciona
 * igual con cualquiera de las dos fuentes.
 */
export class DbPriceProvider implements PriceProvider {
  readonly name = 'db';
  constructor(private readonly db: Db) {}

  async getHistory(instruments: Instrument[], range: { to: string }): Promise<PricePoint[]> {
    const ids = new Set(instruments.map((i) => i.id));
    const rows = await pricesRepo(this.db).list({ to: range.to });
    return preferManual(
      rows.filter((r) => ids.has(r.instrumentId)),
      (r) => `${r.instrumentId}|${r.date}`,
    ).map(toPricePoint);
  }
}

export class DbFxRateProvider implements FxRateProvider {
  readonly name = 'db';
  constructor(private readonly db: Db) {}

  async getHistory(pairs: FxPair[], range: { to: string }): Promise<FxRatePoint[]> {
    const rows = await fxRatesRepo(this.db).list({ to: range.to });
    return preferManual(
      rows.filter((r) => pairs.includes(r.pair)),
      (r) => `${r.pair}|${r.date}`,
    ).map(toFxRatePoint);
  }
}
