import Decimal from 'decimal.js';

/**
 * Instancia de Decimal aislada para el dominio, con 40 dígitos significativos.
 * Internamente nunca se redondea; el redondeo es responsabilidad de la presentación.
 */
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof Dec>;

export const ZERO = new Dec(0);
export const ONE = new Dec(1);

export const dec = (v: Decimal.Value | Dec): Dec => new Dec(v as Decimal.Value);

export const sum = (values: Dec[]): Dec => values.reduce((acc, v) => acc.plus(v), ZERO);

/** Regex de string decimal canónico aceptado en la frontera (API/CSV/DB). */
export const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** Serializa sin notación exponencial. */
export const toStr = (v: Dec): string => v.toFixed();

/** a / b, o null si b es 0. Útil para porcentajes. */
export const safeDiv = (a: Dec, b: Dec): Dec | null => (b.isZero() ? null : a.div(b));
