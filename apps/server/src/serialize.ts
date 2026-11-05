import { Dec } from '@xinvest/domain';

/** Tipo serializado: cada Decimal pasa a string (JSON no tiene decimales exactos). */
export type Serialized<T> = T extends Dec
  ? string
  : T extends (infer U)[]
    ? Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;

/** Decimales a string con hasta 8 decimales (suficiente para precios y cuotapartes). */
export function serialize<T>(value: T): Serialized<T> {
  if (value instanceof Dec) return value.toDecimalPlaces(8).toFixed() as Serialized<T>;
  if (Array.isArray(value)) return value.map(serialize) as Serialized<T>;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out as Serialized<T>;
  }
  return value as Serialized<T>;
}

/** Fecha de hoy en Argentina (YYYY-MM-DD), independiente del huso del server (Vercel = UTC). */
export function todayAR(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(
    new Date(),
  );
}
