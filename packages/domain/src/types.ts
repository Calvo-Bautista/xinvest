import type { Dec } from './decimal';

/** Moneda en la que se liquida una operación o cotiza un precio. */
export const CURRENCIES = ['ARS', 'USD_MEP', 'USD_CCL'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Moneda de reporte del dashboard. USD = dólar MEP; USD cable se toma 1:1 con MEP. */
export const REPORTING_CURRENCIES = ['ARS', 'USD'] as const;
export type ReportingCurrency = (typeof REPORTING_CURRENCIES)[number];

export const INSTRUMENT_TYPES = [
  'STOCK',
  'CEDEAR',
  'BOND',
  'ON',
  'FCI',
  'CAUCION',
  'OTHER',
] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

export const OPERATION_TYPES = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'COUPON',
  'AMORTIZATION',
  'DEPOSIT',
  'WITHDRAWAL',
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

/** Operaciones que mueven cantidad del instrumento. */
export const TRADE_TYPES: readonly OperationType[] = ['BUY', 'SELL'];
/** Eventos que pagan un monto asociado a un instrumento. */
export const INCOME_TYPES: readonly OperationType[] = ['DIVIDEND', 'COUPON', 'AMORTIZATION'];
/** Movimientos de caja sin instrumento. */
export const CASH_TYPES: readonly OperationType[] = ['DEPOSIT', 'WITHDRAWAL'];

export const FX_PAIRS = ['USD_MEP', 'USD_CCL'] as const;
export type FxPair = (typeof FX_PAIRS)[number];

export interface Instrument {
  id: number;
  ticker: string;
  name: string | null;
  type: InstrumentType;
  /** Moneda en la que se cargan/obtienen sus precios. */
  currency: Currency;
  /**
   * Divisor del precio. Bonos y ONs cotizan "cada 100 de valor nominal" → 100.
   * valuación = cantidad × precio / divisor.
   */
  priceDivisor: Dec;
  /** Informativo: cuántos CEDEARs equivalen a 1 acción subyacente. No afecta el P&L. */
  cedearRatio: Dec | null;
}

export interface Operation {
  id: number;
  /** ISO YYYY-MM-DD */
  date: string;
  type: OperationType;
  instrumentId: number | null;
  /** BUY/SELL: unidades (o VN en bonos). */
  quantity: Dec | null;
  /** BUY/SELL: precio por unidad (por 100 VN en bonos). */
  unitPrice: Dec | null;
  /** DIVIDEND/COUPON/AMORTIZATION/DEPOSIT/WITHDRAWAL: monto bruto. */
  amount: Dec | null;
  currency: Currency;
  commission: Dec;
  marketFees: Dec;
  taxes: Dec;
}

export interface PricePoint {
  instrumentId: number;
  date: string;
  price: Dec;
  currency: Currency;
}

export interface FxRatePoint {
  date: string;
  pair: FxPair;
  /** ARS por 1 USD */
  rate: Dec;
}
