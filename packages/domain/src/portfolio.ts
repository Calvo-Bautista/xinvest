import { type Dec, safeDiv, sum, ZERO } from './decimal';
import { CurrencyConverter, FxTable } from './fx';
import { AsOfSeries } from './timeseries';
import {
  CURRENCIES,
  type Currency,
  type FxRatePoint,
  type Instrument,
  type InstrumentType,
  type Operation,
  type PricePoint,
  type ReportingCurrency,
} from './types';

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly operationId?: number,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export interface PortfolioInput {
  instruments: Instrument[];
  operations: Operation[];
  prices: PricePoint[];
  fxRates: FxRatePoint[];
}

export interface PositionView {
  instrumentId: number;
  ticker: string;
  name: string | null;
  type: InstrumentType;
  quantity: Dec;
  /** Precio promedio ponderado (incluye gastos), en moneda de reporte y en unidades de cotización. */
  avgPrice: Dec | null;
  /** Costo de lo que queda en cartera (moneda de reporte, convertido a la fecha de cada operación). */
  costBasis: Dec;
  /** Último precio conocido a la fecha de corte, convertido a moneda de reporte. */
  price: Dec | null;
  priceDate: string | null;
  /** Valuación. Si no hay precio, se valúa al costo para no distorsionar totales. */
  marketValue: Dec;
  unrealizedPnl: Dec;
  unrealizedPct: Dec | null;
  realizedPnl: Dec;
  /** Realizado sobre el costo de lo vendido. */
  realizedPct: Dec | null;
  /** Dividendos y rentas netos cobrados. */
  income: Dec;
  /** Amortizaciones cobradas (devolución de capital, ya descontadas del costo). */
  amortized: Dec;
  /** Gastos pagados en compras/ventas/cobros de este instrumento. */
  fees: Dec;
  totalPnl: Dec;
  open: boolean;
}

export interface CashView {
  currency: Currency;
  /** Saldo en la moneda original. */
  balance: Dec;
  /** Saldo convertido a la moneda de reporte con la cotización de la fecha de corte. */
  value: Dec;
}

export interface AllocationSlice {
  key: string;
  label: string;
  value: Dec;
  weight: Dec | null;
}

export interface PortfolioSummary {
  totalValue: Dec;
  positionsValue: Dec;
  cashValue: Dec;
  /** Depósitos − retiros, cada uno convertido con la cotización de su fecha. */
  netContributions: Dec;
  /** totalValue − netContributions. */
  totalPnl: Dec;
  totalPnlPct: Dec | null;
  realizedPnl: Dec;
  unrealizedPnl: Dec;
  income: Dec;
  /** Diferencia de cambio sobre la caja (ej.: pesos que se devalúan en la vista USD). */
  cashFxResult: Dec;
  /** Gastos de depósitos/retiros (no imputables a un instrumento). */
  otherFees: Dec;
  feesPaid: Dec;
}

export interface PortfolioSnapshot {
  asOf: string;
  reporting: ReportingCurrency;
  positions: PositionView[];
  cash: CashView[];
  summary: PortfolioSummary;
  allocationByInstrument: AllocationSlice[];
  allocationByType: AllocationSlice[];
  warnings: string[];
}

interface Acc {
  quantity: Dec;
  costBasis: Dec;
  realized: Dec;
  soldCost: Dec;
  income: Dec;
  amortized: Dec;
  fees: Dec;
}

const newAcc = (): Acc => ({
  quantity: ZERO,
  costBasis: ZERO,
  realized: ZERO,
  soldCost: ZERO,
  income: ZERO,
  amortized: ZERO,
  fees: ZERO,
});

export const TYPE_LABELS: Record<InstrumentType | 'CASH', string> = {
  STOCK: 'Acciones',
  CEDEAR: 'CEDEARs',
  BOND: 'Bonos',
  ON: 'ONs',
  FCI: 'FCIs',
  CAUCION: 'Cauciones',
  OTHER: 'Otros',
  CASH: 'Efectivo',
};

const CASH_LABELS: Record<Currency, string> = {
  ARS: 'Efectivo ARS',
  USD_MEP: 'Efectivo USD MEP',
  USD_CCL: 'Efectivo USD cable',
};

const byDateThenId = (a: Operation, b: Operation) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id;

const feesOf = (op: Operation) => op.commission.plus(op.marketFees).plus(op.taxes);

/** Tablas precalculadas para evaluar el portafolio en muchas fechas (timeline). */
export class PortfolioContext {
  readonly instruments: Map<number, Instrument>;
  readonly operations: Operation[];
  readonly fx: FxTable;
  private readonly prices: Map<number, AsOfSeries<{ price: Dec; currency: Currency }>>;

  constructor(input: PortfolioInput) {
    this.instruments = new Map(input.instruments.map((i) => [i.id, i]));
    this.operations = [...input.operations].sort(byDateThenId);
    this.fx = new FxTable(input.fxRates);
    const grouped = new Map<
      number,
      { date: string; value: { price: Dec; currency: Currency } }[]
    >();
    for (const p of input.prices) {
      const list = grouped.get(p.instrumentId) ?? [];
      list.push({ date: p.date, value: { price: p.price, currency: p.currency } });
      grouped.set(p.instrumentId, list);
    }
    this.prices = new Map([...grouped].map(([id, pts]) => [id, new AsOfSeries(pts)]));
  }

  priceAt(instrumentId: number, date: string) {
    return this.prices.get(instrumentId)?.at(date);
  }

  get firstDate(): string | undefined {
    return this.operations[0]?.date;
  }
}

/**
 * Reconstruye posiciones y P&L reproduciendo las operaciones hasta `asOf`.
 *
 * Costo: precio promedio ponderado (PPP). Cada compra suma (cantidad × precio / divisor + gastos)
 * al costo; cada venta retira costo a razón de PPP × cantidad vendida, sin cambiar el PPP.
 * Cada monto se convierte a la moneda de reporte con la cotización de SU fecha.
 */
export function computeSnapshot(
  ctx: PortfolioContext,
  opts: { asOf: string; reporting: ReportingCurrency },
): PortfolioSnapshot {
  const { asOf, reporting } = opts;
  const conv = new CurrencyConverter(ctx.fx, reporting);
  const accs = new Map<number, Acc>();
  const cash: Record<Currency, Dec> = { ARS: ZERO, USD_MEP: ZERO, USD_CCL: ZERO };
  const cashBook: Record<Currency, Dec> = { ARS: ZERO, USD_MEP: ZERO, USD_CCL: ZERO };
  let netContributions = ZERO;
  let otherFees = ZERO;
  const warnings: string[] = [];

  const flow = (currency: Currency, native: Dec, date: string) => {
    cash[currency] = cash[currency].plus(native);
    cashBook[currency] = cashBook[currency].plus(conv.convert(native, currency, date));
  };

  for (const op of ctx.operations) {
    if (op.date > asOf) break;
    const fees = feesOf(op);
    const c = (v: Dec) => conv.convert(v, op.currency, op.date);

    if (op.type === 'DEPOSIT' || op.type === 'WITHDRAWAL') {
      const amount = required(op.amount, op, 'amount');
      const sign = op.type === 'DEPOSIT' ? 1 : -1;
      netContributions = netContributions.plus(c(amount).times(sign));
      otherFees = otherFees.plus(c(fees));
      flow(op.currency, amount.times(sign).minus(fees), op.date);
      continue;
    }

    const instrument = op.instrumentId != null ? ctx.instruments.get(op.instrumentId) : undefined;
    if (!instrument) throw new DomainError(`Operación ${op.id}: instrumento inexistente`, op.id);
    let acc = accs.get(instrument.id);
    if (!acc) {
      acc = newAcc();
      accs.set(instrument.id, acc);
    }
    acc.fees = acc.fees.plus(c(fees));

    switch (op.type) {
      case 'BUY': {
        const qty = required(op.quantity, op, 'quantity');
        const gross = qty
          .times(required(op.unitPrice, op, 'unitPrice'))
          .div(instrument.priceDivisor);
        acc.costBasis = acc.costBasis.plus(c(gross.plus(fees)));
        acc.quantity = acc.quantity.plus(qty);
        flow(op.currency, gross.plus(fees).neg(), op.date);
        break;
      }
      case 'SELL': {
        const qty = required(op.quantity, op, 'quantity');
        if (qty.gt(acc.quantity)) {
          throw new DomainError(
            `Operación ${op.id} (${op.date}): se venden ${qty.toFixed()} ${instrument.ticker} pero solo hay ${acc.quantity.toFixed()} en cartera`,
            op.id,
          );
        }
        const gross = qty
          .times(required(op.unitPrice, op, 'unitPrice'))
          .div(instrument.priceDivisor);
        const proceeds = c(gross.minus(fees));
        const costOut = acc.quantity.eq(qty)
          ? acc.costBasis
          : acc.costBasis.div(acc.quantity).times(qty);
        acc.realized = acc.realized.plus(proceeds.minus(costOut));
        acc.soldCost = acc.soldCost.plus(costOut);
        acc.costBasis = acc.costBasis.minus(costOut);
        acc.quantity = acc.quantity.minus(qty);
        flow(op.currency, gross.minus(fees), op.date);
        break;
      }
      case 'DIVIDEND':
      case 'COUPON': {
        const net = required(op.amount, op, 'amount').minus(fees);
        acc.income = acc.income.plus(c(net));
        flow(op.currency, net, op.date);
        break;
      }
      case 'AMORTIZATION': {
        // Devolución de capital: reduce el costo, no es ganancia. Si devuelve más que el costo
        // remanente (p. ej. bono comprado bajo la par), el excedente sí es resultado realizado.
        const net = required(op.amount, op, 'amount').minus(fees);
        const netConv = c(net);
        acc.amortized = acc.amortized.plus(netConv);
        acc.costBasis = acc.costBasis.minus(netConv);
        if (acc.costBasis.isNeg()) {
          acc.realized = acc.realized.plus(acc.costBasis.neg());
          acc.costBasis = ZERO;
        }
        flow(op.currency, net, op.date);
        break;
      }
    }
  }

  const positions: PositionView[] = [];
  for (const [id, acc] of accs) {
    // biome-ignore lint/style/noNonNullAssertion: validado en el loop
    const instrument = ctx.instruments.get(id)!;
    const open = !acc.quantity.isZero();
    const p = open ? ctx.priceAt(id, asOf) : undefined;
    let price: Dec | null = null;
    let marketValue = acc.costBasis;
    if (p) {
      price = conv.convert(p.value.price, p.value.currency, asOf);
      marketValue = acc.quantity.times(price).div(instrument.priceDivisor);
    } else if (open) {
      warnings.push(`${instrument.ticker}: sin precio cargado a ${asOf}, se valúa al costo.`);
    }
    const unrealizedPnl = marketValue.minus(acc.costBasis);
    positions.push({
      instrumentId: id,
      ticker: instrument.ticker,
      name: instrument.name,
      type: instrument.type,
      quantity: acc.quantity,
      avgPrice: open ? acc.costBasis.div(acc.quantity).times(instrument.priceDivisor) : null,
      costBasis: acc.costBasis,
      price,
      priceDate: p?.date ?? null,
      marketValue,
      unrealizedPnl,
      unrealizedPct: safeDiv(unrealizedPnl, acc.costBasis),
      realizedPnl: acc.realized,
      realizedPct: safeDiv(acc.realized, acc.soldCost),
      income: acc.income,
      amortized: acc.amortized,
      fees: acc.fees,
      totalPnl: acc.realized.plus(unrealizedPnl).plus(acc.income),
      open,
    });
  }
  positions.sort((a, b) => b.marketValue.cmp(a.marketValue) || a.ticker.localeCompare(b.ticker));

  const cashViews: CashView[] = CURRENCIES.filter((cur) => !cash[cur].isZero()).map((cur) => ({
    currency: cur,
    balance: cash[cur],
    value: conv.convert(cash[cur], cur, asOf),
  }));
  for (const cv of cashViews) {
    if (cv.balance.isNeg()) {
      warnings.push(
        `${CASH_LABELS[cv.currency]} negativo (${cv.balance.toFixed(2)}): ¿falta registrar un depósito?`,
      );
    }
  }

  const positionsValue = sum(positions.map((p) => p.marketValue));
  const cashValue = sum(cashViews.map((c) => c.value));
  const totalValue = positionsValue.plus(cashValue);
  const totalPnl = totalValue.minus(netContributions);
  const cashFxResult = cashValue.minus(sum(CURRENCIES.map((cur) => cashBook[cur])));

  const instrumentSlices: AllocationSlice[] = [
    ...positions
      .filter((p) => p.open)
      .map((p) => ({ key: String(p.instrumentId), label: p.ticker, value: p.marketValue })),
    ...cashViews
      .filter((c) => c.value.isPos())
      .map((c) => ({ key: `CASH_${c.currency}`, label: CASH_LABELS[c.currency], value: c.value })),
  ].map((s) => ({ ...s, weight: safeDiv(s.value, totalValue) }));

  const typeTotals = new Map<string, Dec>();
  for (const p of positions.filter((x) => x.open)) {
    typeTotals.set(p.type, (typeTotals.get(p.type) ?? ZERO).plus(p.marketValue));
  }
  if (cashValue.isPos()) typeTotals.set('CASH', cashValue);
  const typeSlices = [...typeTotals]
    .map(([key, value]) => ({
      key,
      label: TYPE_LABELS[key as InstrumentType | 'CASH'],
      value,
      weight: safeDiv(value, totalValue),
    }))
    .sort((a, b) => b.value.cmp(a.value));

  return {
    asOf,
    reporting,
    positions,
    cash: cashViews,
    summary: {
      totalValue,
      positionsValue,
      cashValue,
      netContributions,
      totalPnl,
      totalPnlPct: safeDiv(totalPnl, netContributions),
      realizedPnl: sum(positions.map((p) => p.realizedPnl)),
      unrealizedPnl: sum(positions.map((p) => p.unrealizedPnl)),
      income: sum(positions.map((p) => p.income)),
      cashFxResult,
      otherFees,
      feesPaid: sum(positions.map((p) => p.fees)).plus(otherFees),
    },
    allocationByInstrument: instrumentSlices.sort((a, b) => b.value.cmp(a.value)),
    allocationByType: typeSlices,
    warnings: [...warnings, ...conv.warnings],
  };
}

export function computePortfolio(
  input: PortfolioInput,
  opts: { asOf: string; reporting: ReportingCurrency },
): PortfolioSnapshot {
  return computeSnapshot(new PortfolioContext(input), opts);
}

/**
 * Valida que la secuencia de operaciones sea consistente (p. ej. no vender más de lo que hay).
 * Se usa antes de persistir altas/modificaciones. No requiere cotizaciones.
 */
export function validateOperations(instruments: Instrument[], operations: Operation[]): void {
  const ctx = new PortfolioContext({ instruments, operations, prices: [], fxRates: [] });
  const qty = new Map<number, Dec>();
  for (const op of ctx.operations) {
    if (op.type !== 'BUY' && op.type !== 'SELL') continue;
    // biome-ignore lint/style/noNonNullAssertion: BUY/SELL siempre tienen instrumento y cantidad
    const id = op.instrumentId!;
    const instrument = ctx.instruments.get(id);
    if (!instrument) throw new DomainError(`Operación ${op.id}: instrumento inexistente`, op.id);
    // biome-ignore lint/style/noNonNullAssertion: idem
    const q = op.quantity!;
    const current = qty.get(id) ?? ZERO;
    if (op.type === 'SELL' && q.gt(current)) {
      throw new DomainError(
        `Venta del ${op.date}: se venden ${q.toFixed()} ${instrument.ticker} pero a esa fecha solo hay ${current.toFixed()}`,
        op.id,
      );
    }
    qty.set(id, op.type === 'BUY' ? current.plus(q) : current.minus(q));
  }
}

function required(v: Dec | null, op: Operation, field: string): Dec {
  if (v == null) throw new DomainError(`Operación ${op.id} (${op.type}): falta ${field}`, op.id);
  return v;
}
