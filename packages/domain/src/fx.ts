import type { Dec } from './decimal';
import { AsOfSeries } from './timeseries';
import type { Currency, FxPair, FxRatePoint, ReportingCurrency } from './types';

export class MissingFxRateError extends Error {
  constructor(public readonly pair: FxPair) {
    super(`No hay cotizaciones cargadas para ${pair}. Cargá al menos una en "Cotizaciones".`);
    this.name = 'MissingFxRateError';
  }
}

/** Tabla de cotizaciones (ARS por USD) por par, con búsqueda as-of. */
export class FxTable {
  private readonly series: Record<FxPair, AsOfSeries<Dec>>;

  constructor(rates: FxRatePoint[]) {
    const by = (pair: FxPair) =>
      new AsOfSeries(
        rates.filter((r) => r.pair === pair).map((r) => ({ date: r.date, value: r.rate })),
      );
    this.series = { USD_MEP: by('USD_MEP'), USD_CCL: by('USD_CCL') };
  }

  has(pair: FxPair): boolean {
    return !this.series[pair].isEmpty;
  }

  /**
   * Cotización vigente a `date`: la última cargada con fecha <= date.
   * Si no hay ninguna anterior se usa la primera posterior (exact = false).
   */
  rate(pair: FxPair, date: string): { rate: Dec; date: string; exact: boolean } {
    const s = this.series[pair];
    const p = s.at(date);
    if (p) return { rate: p.value, date: p.date, exact: true };
    const first = s.first();
    if (!first) throw new MissingFxRateError(pair);
    return { rate: first.value, date: first.date, exact: false };
  }
}

/**
 * Convierte montos de la moneda de la operación a la moneda de reporte usando la cotización
 * de la FECHA indicada (histórica), no la de hoy.
 *
 * - Reporte USD: USD MEP y USD cable se toman 1:1; ARS se divide por el MEP de la fecha.
 * - Reporte ARS: USD MEP × MEP de la fecha; USD cable × CCL de la fecha (o MEP si no hay CCL).
 */
export class CurrencyConverter {
  readonly warnings = new Set<string>();

  constructor(
    private readonly fx: FxTable,
    readonly reporting: ReportingCurrency,
  ) {}

  convert(amount: Dec, from: Currency, date: string): Dec {
    if (amount.isZero()) return amount;
    if (this.reporting === 'USD') {
      if (from !== 'ARS') return amount;
      return amount.div(this.lookup('USD_MEP', date));
    }
    if (from === 'ARS') return amount;
    if (from === 'USD_CCL' && this.fx.has('USD_CCL')) {
      return amount.times(this.lookup('USD_CCL', date));
    }
    if (from === 'USD_CCL') {
      this.warnings.add('No hay cotizaciones CCL: se usa el MEP para convertir USD cable.');
    }
    return amount.times(this.lookup('USD_MEP', date));
  }

  private lookup(pair: FxPair, date: string): Dec {
    const r = this.fx.rate(pair, date);
    if (!r.exact) {
      this.warnings.add(
        `No hay cotización ${pair} anterior a ${date}; se usó la del ${r.date}. Cargá cotizaciones más antiguas.`,
      );
    }
    return r.rate;
  }
}
