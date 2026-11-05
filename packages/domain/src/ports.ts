import type { Dec } from './decimal';
import type { Currency, FxPair, FxRatePoint, Instrument, PricePoint } from './types';

/**
 * Fuente de precios. MVP: precios cargados a mano en la DB.
 * Fase 2: IOL (/api/v2/{mercado}/Titulos/{simbolo}/Cotizacion), con un adapter que además
 * persista lo obtenido para tener historia.
 */
export interface PriceProvider {
  readonly name: string;
  /** Historia de precios (para valuación as-of y timeline). */
  getHistory(instruments: Instrument[], range: { to: string }): Promise<PricePoint[]>;
  /** Precio actual de un instrumento, si la fuente lo puede obtener en línea. */
  getQuote?(
    instrument: Instrument,
  ): Promise<{ price: Dec; currency: Currency; date: string } | null>;
}

/** Fuente de cotizaciones del dólar. MVP: manual. Fase 2: fuente pública de MEP/CCL. */
export interface FxRateProvider {
  readonly name: string;
  getHistory(pairs: FxPair[], range: { to: string }): Promise<FxRatePoint[]>;
  getLatest?(pair: FxPair): Promise<FxRatePoint | null>;
}

/**
 * Fase 2: origen externo de operaciones (p. ej. /api/v2/operaciones de IOL).
 * El sync hace upsert por `externalId`, por eso las operaciones tienen esa columna desde el MVP.
 */
export interface ExternalOperation {
  externalId: string;
  date: string;
  type: string;
  ticker: string | null;
  quantity: string | null;
  unitPrice: string | null;
  amount: string | null;
  currency: Currency;
  fees: string;
  raw: unknown;
}

export interface OperationSource {
  readonly name: string;
  fetchSince(date: string): Promise<ExternalOperation[]>;
}
