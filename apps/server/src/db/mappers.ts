import {
  dec,
  type FxRatePoint,
  type Instrument,
  type Operation,
  type PricePoint,
} from '@xinvest/domain';
import type { FxRateRow, InstrumentRow, OperationRow, PriceRow } from './schema';

const opt = (v: string | null) => (v == null ? null : dec(v));

export const toInstrument = (r: InstrumentRow): Instrument => ({
  id: r.id,
  ticker: r.ticker,
  name: r.name,
  type: r.type,
  currency: r.currency,
  priceDivisor: dec(r.priceDivisor),
  cedearRatio: opt(r.cedearRatio),
});

export const toOperation = (r: OperationRow): Operation => ({
  id: r.id,
  date: r.date,
  type: r.type,
  instrumentId: r.instrumentId,
  quantity: opt(r.quantity),
  unitPrice: opt(r.unitPrice),
  amount: opt(r.amount),
  currency: r.currency,
  commission: dec(r.commission),
  marketFees: dec(r.marketFees),
  taxes: dec(r.taxes),
});

export const toPricePoint = (r: PriceRow): PricePoint => ({
  instrumentId: r.instrumentId,
  date: r.date,
  price: dec(r.price),
  currency: r.currency,
});

export const toFxRatePoint = (r: FxRateRow): FxRatePoint => ({
  date: r.date,
  pair: r.pair,
  rate: dec(r.rate),
});
