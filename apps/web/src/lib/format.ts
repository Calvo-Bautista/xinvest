import type { Currency, InstrumentType, OperationType, ReportingCurrency } from '@xinvest/domain';

// Nota: la conversión a Number es SOLO para mostrar. Los cálculos se hacen en el server con decimales.
const n = (v: string | number | null | undefined) => (v == null || v === '' ? null : Number(v));

const moneyFmt = (digits: number) =>
  new Intl.NumberFormat('es-AR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const CURRENCY_SYMBOL: Record<Currency | ReportingCurrency, string> = {
  ARS: '$',
  USD: 'US$',
  USD_MEP: 'US$',
  USD_CCL: 'US$ C',
};

/** digits por defecto: 2, o 4 si el monto es menor a 1 (cuotapartes, precios de caución). */
export function fmtMoney(
  v: string | number | null | undefined,
  cur: Currency | ReportingCurrency,
  digits?: number,
) {
  const x = n(v);
  if (x == null) return '—';
  const d = digits ?? (x !== 0 && Math.abs(x) < 1 ? 4 : 2);
  return `${CURRENCY_SYMBOL[cur]} ${moneyFmt(d).format(x)}`;
}

/** Compacto para KPIs y ejes: $ 12,3 M */
export function fmtCompact(v: string | number | null | undefined, cur: ReportingCurrency) {
  const x = n(v);
  if (x == null) return '—';
  return `${CURRENCY_SYMBOL[cur]} ${new Intl.NumberFormat('es-AR', { notation: 'compact', maximumFractionDigits: 1 }).format(x)}`;
}

export function fmtNum(v: string | number | null | undefined, maxDigits = 4) {
  const x = n(v);
  if (x == null) return '—';
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: maxDigits }).format(x);
}

export function fmtPct(v: string | number | null | undefined, signed = true) {
  const x = n(v);
  if (x == null) return '—';
  const s = new Intl.NumberFormat('es-AR', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(x);
  return s;
}

export const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

/** Clase de color para P&L. */
export const pnlClass = (v: string | number | null | undefined) => {
  const x = n(v);
  if (x == null || x === 0) return 'text-zinc-500';
  return x > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400';
};

/**
 * Normaliza lo que escribe el usuario a decimal canónico.
 * "1.234,56" → "1234.56" ; "1234,5" → "1234.5" ; "1234.5" → "1234.5"
 */
export function normalizeDecimal(input: string): string {
  const s = input.trim().replace(/\s/g, '');
  if (s.includes(',')) return s.replace(/\./g, '').replace(',', '.');
  return s;
}

export const OPERATION_LABELS: Record<OperationType, string> = {
  BUY: 'Compra',
  SELL: 'Venta',
  DIVIDEND: 'Dividendo',
  COUPON: 'Renta',
  AMORTIZATION: 'Amortización',
  DEPOSIT: 'Depósito',
  WITHDRAWAL: 'Retiro',
};

export const INSTRUMENT_LABELS: Record<InstrumentType, string> = {
  STOCK: 'Acción',
  CEDEAR: 'CEDEAR',
  BOND: 'Bono',
  ON: 'ON',
  FCI: 'FCI',
  CAUCION: 'Caución',
  OTHER: 'Otro',
};

export const CURRENCY_LABELS: Record<Currency, string> = {
  ARS: 'ARS',
  USD_MEP: 'USD MEP',
  USD_CCL: 'USD cable',
};

export const todayISO = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(
    new Date(),
  );
