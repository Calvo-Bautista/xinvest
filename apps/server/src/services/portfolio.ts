import {
  computeSnapshot,
  computeTimeline,
  FX_PAIRS,
  type FxRateProvider,
  PortfolioContext,
  type PriceProvider,
  type ReportingCurrency,
} from '@xinvest/domain';
import { toInstrument, toOperation } from '../db/mappers';
import { instrumentsRepo, operationsRepo } from '../db/repositories';
import type { Db } from '../db/types';

export interface Providers {
  prices: PriceProvider;
  fx: FxRateProvider;
}

async function loadContext(db: Db, providers: Providers, asOf: string) {
  const [instRows, opRows] = await Promise.all([
    instrumentsRepo(db).list(),
    operationsRepo(db).list(),
  ]);
  const instruments = instRows.map(toInstrument);
  const [prices, fxRates] = await Promise.all([
    providers.prices.getHistory(instruments, { to: asOf }),
    providers.fx.getHistory([...FX_PAIRS], { to: asOf }),
  ]);
  return new PortfolioContext({
    instruments,
    operations: opRows.map(toOperation),
    prices,
    fxRates,
  });
}

export async function getSnapshot(
  db: Db,
  providers: Providers,
  opts: { asOf: string; reporting: ReportingCurrency },
) {
  return computeSnapshot(await loadContext(db, providers, opts.asOf), opts);
}

export async function getTimeline(
  db: Db,
  providers: Providers,
  opts: { to: string; reporting: ReportingCurrency },
) {
  return computeTimeline(await loadContext(db, providers, opts.to), opts);
}
