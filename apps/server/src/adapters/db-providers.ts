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
 * MVP: los precios se cargan a mano y viven en la tabla `prices`.
 * Fase 2: un IolPriceProvider implementará getQuote() y un job persistirá los precios
 * obtenidos en esta misma tabla (source = 'iol'), así la historia sigue saliendo de acá.
 */
export class DbPriceProvider implements PriceProvider {
  readonly name = 'db';
  constructor(private readonly db: Db) {}

  async getHistory(instruments: Instrument[], range: { to: string }): Promise<PricePoint[]> {
    const ids = new Set(instruments.map((i) => i.id));
    const rows = await pricesRepo(this.db).list({ to: range.to });
    return rows.filter((r) => ids.has(r.instrumentId)).map(toPricePoint);
  }
}

export class DbFxRateProvider implements FxRateProvider {
  readonly name = 'db';
  constructor(private readonly db: Db) {}

  async getHistory(pairs: FxPair[], range: { to: string }): Promise<FxRatePoint[]> {
    const rows = await fxRatesRepo(this.db).list({ to: range.to });
    return rows.filter((r) => pairs.includes(r.pair)).map(toFxRatePoint);
  }
}
