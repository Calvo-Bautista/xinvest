/**
 * Traduce movimientos de IOL a operaciones de Xinvest. Función pura (sin I/O) para poder testearla.
 *
 * - `activities` es la fuente principal: trae cantidad, precio, monto neto y gastos desglosados.
 * - El ticker no viene en activities: se obtiene de `operations` cruzando por ticket_id.
 * - Especies en dólares: IOL usa otro ticker para la misma tenencia (AL30 → AL30D MEP / AL30C
 *   cable; en ONs YMCXO → YMCXD / YMCXC). Se normalizan al ticker base para que compra en pesos
 *   y venta en dólares afecten la misma posición (es lo que pasa al hacer "dólar MEP").
 * - Lo que no se puede mapear con certeza se devuelve en `unmapped` con el motivo, nunca se
 *   inventa.
 */
import { type Currency, Dec, type InstrumentType } from '@xinvest/domain';
import type { IolActivity, IolOperation } from './client';

export type MappedType =
  | 'BUY'
  | 'SELL'
  | 'DIVIDEND'
  | 'COUPON'
  | 'AMORTIZATION'
  | 'DEPOSIT'
  | 'WITHDRAWAL';

export interface InstrumentHint {
  ticker: string;
  name: string | null;
  type: InstrumentType;
  /** Moneda en la que cotiza el ticker base (para cargar precios). */
  currency: Currency;
  priceDivisor: '1' | '100';
}

export interface MappedOperation {
  externalId: string;
  date: string;
  type: MappedType;
  ticker: string | null;
  quantity: string | null;
  unitPrice: string | null;
  amount: string | null;
  currency: Currency;
  commission: string;
  marketFees: string;
  taxes: string;
  notes: string;
  instrument: InstrumentHint | null;
}

export interface UnmappedActivity {
  externalId: string;
  date: string;
  activityType: string;
  netAmount: string;
  currency: string;
  reason: string;
}

const D = (n: number | string) => new Dec(String(n));
const s = (d: Dec) => d.toFixed();

const ASSET_TYPES: Record<string, InstrumentType> = {
  cedears: 'CEDEAR',
  cedear: 'CEDEAR',
  stocks: 'STOCK',
  stock: 'STOCK',
  acciones: 'STOCK',
  adrs: 'STOCK',
  ons: 'ON',
  on: 'ON',
  obligaciones_negociables: 'ON',
  government_bonds: 'BOND',
  bonds: 'BOND',
  titulos_publicos: 'BOND',
  letters: 'BOND',
  letras: 'BOND',
  fci: 'FCI',
  collateral: 'CAUCION',
  collateral_usd: 'CAUCION',
  cauciones: 'CAUCION',
};

export function instrumentTypeOf(assetType: string | null | undefined): InstrumentType {
  if (!assetType) return 'OTHER';
  return ASSET_TYPES[assetType.toLowerCase().replace(/\s+/g, '_')] ?? 'OTHER';
}

/**
 * Ticker base y moneda de liquidación a partir del símbolo operado.
 * Sólo se quita el sufijo D/C cuando la operación es en dólares (YPFD en pesos es YPF, no "YPF D").
 */
export function normalizeSymbol(
  symbol: string,
  currency: string,
  type: InstrumentType,
): { ticker: string; currency: Currency } {
  const sym = symbol.trim().toUpperCase();
  if (currency.toUpperCase() !== 'USD') return { ticker: sym, currency: 'ARS' };
  const last = sym.at(-1);
  if (sym.length > 3 && (last === 'D' || last === 'C') && type !== 'CAUCION' && type !== 'FCI') {
    const base = type === 'ON' ? `${sym.slice(0, -1)}O` : sym.slice(0, -1);
    return { ticker: base, currency: last === 'C' ? 'USD_CCL' : 'USD_MEP' };
  }
  return { ticker: sym, currency: 'USD_MEP' };
}

const TRADE: Record<string, 'BUY' | 'SELL'> = {
  Buy: 'BUY',
  Sell: 'SELL',
  'Mutual Fund (FCI) Subscription': 'BUY',
  'Mutual Fund (FCI) Redemption': 'SELL',
  'Stock Subscription': 'BUY',
  'OTC Subscription': 'BUY',
};
const INCOME: Record<string, 'DIVIDEND' | 'COUPON' | 'AMORTIZATION'> = {
  'Rent Payment': 'COUPON',
  'Amortization Payment': 'AMORTIZATION',
  'Dividend Payment': 'DIVIDEND',
};
const CASH: Record<string, 'DEPOSIT' | 'WITHDRAWAL'> = {
  Deposit: 'DEPOSIT',
  Withdrawal: 'WITHDRAWAL',
};
const COLLATERAL_OPEN = 'Collateral';
const COLLATERAL_CLOSE = 'Collateral Liquidation';

const UNSUPPORTED_REASON: Record<string, string> = {
  'Balance Remuneration':
    'Remuneración de saldos: es ganancia sin instrumento; cargala a mano si querés registrarla.',
  Debit: 'Débito genérico: revisá en IOL qué es y cargalo a mano.',
  Credit: 'Crédito genérico: revisá en IOL qué es y cargalo a mano.',
  'Securities Transfer In':
    'Transferencia de títulos entrante: no tiene precio de compra. Cargala como compra con tu costo original.',
  'Securities Transfer Out': 'Transferencia de títulos saliente: cargala a mano.',
  'Collateral Taker': 'Caución tomadora (te prestaste plata): no soportada todavía.',
  'Collateral Taker Liquidation': 'Caución tomadora: no soportada todavía.',
  'Short Sale': 'Venta en corto: no soportada.',
  'Call Writing': 'Lanzamiento de opciones: no soportado.',
  'Put Writing': 'Lanzamiento de opciones: no soportado.',
};

/**
 * Detecta si el precio viene "cada 100 VN" comparando el monto con cantidad × precio.
 * Bonos/ONs cotizan así; si los números no alcanzan para decidir, se usa el tipo.
 */
function detectDivisor(a: IolActivity, type: InstrumentType): '1' | '100' {
  const qp = D(a.qty).times(a.price).abs();
  const fees = feeTotal(a);
  const gross = D(a.net_amount).abs().minus(fees).abs();
  if (qp.gt(0) && gross.gt(0)) {
    const ratio = gross.div(qp);
    if (ratio.gt('0.005') && ratio.lt('0.02')) return '100';
    if (ratio.gt('0.5') && ratio.lt('2')) return '1';
  }
  return type === 'BOND' || type === 'ON' ? '100' : '1';
}

function feeParts(a: IolActivity) {
  const f = a.fees ?? {};
  return {
    commission: D(f.commission ?? 0).abs(),
    taxes: D(f.vat ?? 0).abs(),
    marketFees: D(f.other ?? 0).abs(),
  };
}
const feeTotal = (a: IolActivity) => {
  const f = feeParts(a);
  return f.commission.plus(f.taxes).plus(f.marketFees);
};

const dateOf = (a: IolActivity) => a.trade_date.slice(0, 10);

/**
 * La doc REST habla de estados/tipos en inglés ("completed", "Buy"), pero el MCP oficial de IOL
 * devuelve abreviaturas en español ("Terminada", "Comp", "Depo"). Aceptamos ambas formas.
 */
const NOT_SETTLED = new Set([
  'cancelled',
  'cancelada',
  'pending',
  'pendiente',
  'rejected',
  'rechazada',
]);
const isSettled = (a: IolActivity) => !NOT_SETTLED.has(a.status.trim().toLowerCase());

const TYPE_ALIASES: Record<string, string> = {
  comp: 'Buy',
  compra: 'Buy',
  vta: 'Sell',
  vent: 'Sell',
  venta: 'Sell',
  depo: 'Deposit',
  depósito: 'Deposit',
  deposito: 'Deposit',
  extr: 'Withdrawal',
  extracción: 'Withdrawal',
  extraccion: 'Withdrawal',
};
const canonicalType = (t: string) => TYPE_ALIASES[t.trim().toLowerCase()] ?? t.trim();

export function mapIolActivities(
  activities: IolActivity[],
  operations: IolOperation[],
): { operations: MappedOperation[]; unmapped: UnmappedActivity[] } {
  const byTicket = new Map<string, IolOperation>();
  for (const o of operations) if (o.ticket_id) byTicket.set(String(o.ticket_id), o);

  const sorted = [...activities]
    .filter(isSettled)
    .map((a) => ({ ...a, activity_type: canonicalType(a.activity_type) }))
    .sort(
      (x, y) =>
        dateOf(x).localeCompare(dateOf(y)) || x.id.localeCompare(y.id, 'en', { numeric: true }),
    );

  const out: MappedOperation[] = [];
  const unmapped: UnmappedActivity[] = [];
  /** Cauciones abiertas (FIFO por moneda) para emparejar con su liquidación. */
  const openRepos: Record<'ARS' | 'USD', Dec[]> = { ARS: [], USD: [] };

  const skip = (a: IolActivity, reason: string) =>
    unmapped.push({
      externalId: extId(a),
      date: dateOf(a),
      activityType: a.activity_type,
      netAmount: s(D(a.net_amount)),
      currency: a.currency,
      reason,
    });

  for (const a of sorted) {
    const fees = feeParts(a);
    const base = {
      externalId: extId(a),
      date: dateOf(a),
      commission: s(fees.commission),
      marketFees: s(fees.marketFees),
      taxes: s(fees.taxes),
    };
    const op = a.ticket_id ? byTicket.get(String(a.ticket_id)) : undefined;
    const net = D(a.net_amount).abs();
    const usd = a.currency.toUpperCase() === 'USD';

    if (a.activity_type in CASH) {
      const type = CASH[a.activity_type] as 'DEPOSIT' | 'WITHDRAWAL';
      const total = feeTotal(a);
      // Que el efecto en caja coincida con el neto de IOL:
      // depósito: caja += amount − gastos ; retiro: caja −= amount + gastos
      const amount = type === 'DEPOSIT' ? net.plus(total) : net.minus(total);
      if (!amount.isPos()) {
        skip(a, 'Monto no positivo');
        continue;
      }
      out.push({
        ...base,
        type,
        ticker: null,
        quantity: null,
        unitPrice: null,
        amount: s(amount),
        currency: usd ? 'USD_MEP' : 'ARS',
        notes: `IOL ${a.activity_type}`,
        instrument: null,
      });
      continue;
    }

    if (a.activity_type === COLLATERAL_OPEN || a.activity_type === COLLATERAL_CLOSE) {
      const ccy = usd ? 'USD' : 'ARS';
      const ticker = usd ? 'CAUCION_USD' : 'CAUCION';
      const instrument: InstrumentHint = {
        ticker,
        name: usd ? 'Caución colocadora USD' : 'Caución colocadora',
        type: 'CAUCION',
        currency: usd ? 'USD_MEP' : 'ARS',
        priceDivisor: '1',
      };
      // Capital = lo que sale de la cuenta (neto − gastos ya incluidos en el neto)
      if (a.activity_type === COLLATERAL_OPEN) {
        const capital = net.minus(feeTotal(a));
        openRepos[ccy].push(capital);
        out.push({
          ...base,
          type: 'BUY',
          ticker,
          quantity: s(capital),
          unitPrice: '1',
          amount: null,
          currency: instrument.currency,
          notes: 'IOL caución colocadora',
          instrument,
        });
      } else {
        const capital = openRepos[ccy].shift();
        if (!capital) {
          skip(
            a,
            'Liquidación de caución sin apertura en el rango: sincronizá desde una fecha anterior.',
          );
          continue;
        }
        // precio de cierre tal que capital × precio − gastos = neto cobrado
        const price = net.plus(feeTotal(a)).div(capital);
        out.push({
          ...base,
          type: 'SELL',
          ticker,
          quantity: s(capital),
          unitPrice: s(price.toDecimalPlaces(10)),
          amount: null,
          currency: instrument.currency,
          notes: 'IOL liquidación de caución',
          instrument,
        });
      }
      continue;
    }

    const isTrade = a.activity_type in TRADE;
    const isIncome = a.activity_type in INCOME;
    if (!isTrade && !isIncome) {
      skip(
        a,
        UNSUPPORTED_REASON[a.activity_type] ??
          `Tipo "${a.activity_type}" no soportado: cargalo a mano.`,
      );
      continue;
    }
    if (!op?.symbol) {
      skip(a, 'No se encontró el ticker (sin operación asociada por ticket_id).');
      continue;
    }

    let type = instrumentTypeOf(op.asset_type);
    if (a.activity_type.startsWith('Mutual Fund')) type = 'FCI';
    const norm = normalizeSymbol(op.symbol, a.currency, type);
    const instrument: InstrumentHint = {
      ticker: norm.ticker,
      name: op.description?.trim() || null,
      type,
      // El ticker base (AL30, AAPL) cotiza en pesos. Si el símbolo en USD no tenía sufijo
      // (p. ej. un FCI en dólares), el instrumento mismo cotiza en USD.
      currency: usd && norm.ticker === op.symbol.trim().toUpperCase() ? 'USD_MEP' : 'ARS',
      priceDivisor: isTrade
        ? detectDivisor(a, type)
        : type === 'BOND' || type === 'ON'
          ? '100'
          : '1',
    };

    if (isTrade) {
      const qty = D(a.qty).abs();
      const price = D(a.price).abs();
      if (!qty.isPos()) {
        skip(a, 'Cantidad 0');
        continue;
      }
      out.push({
        ...base,
        type: TRADE[a.activity_type] as 'BUY' | 'SELL',
        ticker: norm.ticker,
        quantity: s(qty),
        unitPrice: s(price),
        amount: null,
        currency: norm.currency,
        notes: `IOL ${op.symbol}${op.term ? ` ${op.term}` : ''}`,
        instrument,
      });
    } else {
      // Ingreso: monto bruto = neto cobrado + retenciones/gastos (el motor los vuelve a restar)
      const amount = net.plus(feeTotal(a));
      if (!amount.isPos()) {
        skip(a, 'Monto 0');
        continue;
      }
      out.push({
        ...base,
        type: INCOME[a.activity_type] as 'DIVIDEND' | 'COUPON' | 'AMORTIZATION',
        ticker: norm.ticker,
        quantity: null,
        unitPrice: null,
        amount: s(amount),
        currency: usd ? 'USD_MEP' : 'ARS',
        notes: `IOL ${a.activity_type} ${op.symbol}`,
        instrument,
      });
    }
  }
  return { operations: out, unmapped };
}

export const extId = (a: IolActivity) => `iol:${a.id}`;
