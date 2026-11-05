import type { AppType } from '@xinvest/server';
import { hc, type InferResponseType } from 'hono/client';

/** Cliente RPC tipado: rutas, params y respuestas inferidos del server. */
export const client = hc<AppType>('/', { init: { credentials: 'same-origin' } });
export const api = client.api;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Evento global para que la app muestre el login si la sesión vence. */
export const UNAUTHORIZED_EVENT = 'xinvest:unauthorized';

type AnyRes = { ok: boolean; status: number; json(): Promise<unknown> };
/** De la unión de respuestas tipadas, la(s) exitosa(s). */
type OkJson<R extends AnyRes> = Awaited<
  ReturnType<([Extract<R, { ok: true }>] extends [never] ? R : Extract<R, { ok: true }>)['json']>
>;

/** Espera la respuesta, tira ApiError con el mensaje del server si no es 2xx, y devuelve el JSON. */
export async function unwrap<R extends AnyRes>(p: Promise<R>): Promise<OkJson<R>> {
  const res = await p;
  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* respuesta sin JSON */
    }
    if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as OkJson<R>;
}

export type Instrument = InferResponseType<typeof api.instruments.$get, 200>[number];
export type OperationListItem = InferResponseType<typeof api.operations.$get, 200>[number];
export type PriceRow = InferResponseType<typeof api.prices.$get, 200>[number];
export type FxRateRow = InferResponseType<(typeof api)['fx-rates']['$get'], 200>[number];
export type Snapshot = InferResponseType<typeof api.portfolio.$get, 200>;
export type Position = Snapshot['positions'][number];
export type Timeline = InferResponseType<typeof api.portfolio.timeline.$get, 200>;
