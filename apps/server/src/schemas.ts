import { CURRENCIES, Dec, FX_PAIRS, INSTRUMENT_TYPES, REPORTING_CURRENCIES } from '@xinvest/domain';
import { z } from 'zod';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Fecha calendario real (rechaza 2025-02-30). */
export const isoDate = z
  .string()
  .trim()
  .regex(ISO_DATE_RE, 'Fecha inválida (YYYY-MM-DD)')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Fecha inválida');

const decimalString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, 'Número inválido (usar punto decimal, sin separador de miles)');
/** Forma canónica para guardar: "010.50" → "10.5". */
const canonical = (s: string) => new Dec(s).toFixed();

/** Decimal no negativo como string canónico. */
export const nonNegDecimal = decimalString.transform(canonical);
export const posDecimal = decimalString
  .refine((s) => /[1-9]/.test(s), 'Debe ser mayor a 0')
  .transform(canonical);

export const currency = z.enum(CURRENCIES);
export const reportingCurrency = z.enum(REPORTING_CURRENCIES);
export const instrumentType = z.enum(INSTRUMENT_TYPES);
export const fxPair = z.enum(FX_PAIRS);
const notes = z.string().trim().max(2000).nullish();

export const instrumentInput = z.object({
  ticker: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .transform((s) => s.toUpperCase()),
  name: z.string().trim().max(200).nullish(),
  type: instrumentType,
  currency,
  /** Si se omite: 100 para bonos y ONs, 1 para el resto. */
  priceDivisor: posDecimal.optional(),
  cedearRatio: posDecimal.nullish(),
  notes,
});
export type InstrumentInput = z.infer<typeof instrumentInput>;

const opBase = {
  date: isoDate,
  currency,
  commission: nonNegDecimal.default('0'),
  marketFees: nonNegDecimal.default('0'),
  taxes: nonNegDecimal.default('0'),
  notes,
  externalId: z.string().trim().max(100).nullish(),
};
const instrumentId = z.coerce.number().int().positive();

export const operationInput = z.discriminatedUnion('type', [
  z.object({
    ...opBase,
    type: z.enum(['BUY', 'SELL']),
    instrumentId,
    quantity: posDecimal,
    unitPrice: nonNegDecimal,
  }),
  z.object({
    ...opBase,
    type: z.enum(['DIVIDEND', 'COUPON', 'AMORTIZATION']),
    instrumentId,
    amount: posDecimal,
  }),
  z.object({
    ...opBase,
    type: z.enum(['DEPOSIT', 'WITHDRAWAL']),
    amount: posDecimal,
  }),
]);
export type OperationInput = z.infer<typeof operationInput>;

export const priceInput = z.object({
  instrumentId,
  date: isoDate,
  price: posDecimal,
  /** Si se omite se usa la moneda del instrumento. */
  currency: currency.optional(),
});
export type PriceInput = z.infer<typeof priceInput>;

export const fxRateInput = z.object({
  date: isoDate,
  pair: fxPair,
  rate: posDecimal,
});
export type FxRateInput = z.infer<typeof fxRateInput>;

export const portfolioQuery = z.object({
  currency: reportingCurrency.default('ARS'),
  asOf: isoDate.optional(),
});

export const idParam = z.object({ id: z.coerce.number().int().positive() });
