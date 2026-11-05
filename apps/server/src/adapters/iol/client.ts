/**
 * Cliente de la API oficial de IOL (https://developers.iolinversiones.com).
 *
 * Auth OAuth 2.0 "password grant": POST /auth/token con usuario y contraseña devuelve un
 * access_token (JWT, 15 min) y un refresh_token (30 días). Se reutiliza el access token mientras
 * esté vigente, se renueva con el refresh token y, sólo si ese también venció o fue rechazado,
 * se vuelve a enviar la contraseña. Los tokens se persisten vía TokenStore (DB cifrada).
 */
import { z } from 'zod';

export const IOL_BASE_URL = 'https://api.iolinversiones.com';

export interface IolCredentials {
  username: string;
  password: string;
}

export interface TokenSet {
  accessToken: string;
  /** epoch ms */
  accessExpiresAt: number;
  refreshToken: string;
  /** epoch ms */
  refreshExpiresAt: number;
}

export interface TokenStore {
  load(): Promise<TokenSet | null>;
  save(tokens: TokenSet | null): Promise<void>;
}

export class IolApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly traceId?: string,
  ) {
    super(message);
    this.name = 'IolApiError';
  }
}

const envelope = <T extends z.ZodType>(data: T) =>
  z.object({
    data,
    error: z
      .object({ message: z.string().optional(), code: z.unknown().optional() })
      .passthrough()
      .nullish(),
    meta: z.object({ trace_id: z.string().optional() }).passthrough().optional(),
  });

const tokenData = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  expires_at: z.string().optional(),
});

const num = z.coerce.number();
const nullableNum = z
  .union([z.number(), z.string(), z.null()])
  .transform((v) => (v == null ? 0 : Number(v)));

export const iolActivity = z
  .object({
    id: z.coerce.string(),
    ticket_id: z.coerce.string().nullish(),
    activity_type: z.string(),
    account_type: z.string().nullish(),
    trade_date: z.string(),
    settlement_date: z.string().nullish(),
    qty: nullableNum,
    price: nullableNum,
    currency: z.string(),
    net_amount: num,
    fees: z
      .object({ commission: nullableNum, vat: nullableNum, other: nullableNum })
      .partial()
      .nullish(),
    status: z.string(),
  })
  .passthrough();
export type IolActivity = z.infer<typeof iolActivity>;

export const iolOperation = z
  .object({
    order_id: z.coerce.string().nullish(),
    ticket_id: z.coerce.string().nullish(),
    type: z.string().nullish(),
    status: z.string().nullish(),
    symbol: z.string().nullish(),
    description: z.string().nullish(),
    asset_type: z.string().nullish(),
    currency: z.string().nullish(),
    term: z.string().nullish(),
    execution_date: z.string().nullish(),
  })
  .passthrough();
export type IolOperation = z.infer<typeof iolOperation>;

const iolBars = z.object({
  bars: z.array(z.object({ datetime: z.string(), close: num }).passthrough()),
});

/** Margen para no usar un token a punto de vencer. */
const SKEW_MS = 60_000;
const REFRESH_TTL_MS = 29 * 86_400_000; // la doc dice 30 días; dejamos 1 de margen

export class IolClient {
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private memo: TokenSet | null | undefined;
  /** Renovación en curso: requests paralelas comparten un solo refresh/login. */
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly creds: IolCredentials,
    private readonly store: TokenStore,
    opts: { fetch?: typeof fetch; baseUrl?: string; now?: () => number; timeoutMs?: number } = {},
  ) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = opts.baseUrl ?? IOL_BASE_URL;
    this.now = opts.now ?? Date.now;
    // Menor al límite de la función en Vercel, para responder un error claro antes de que corte.
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /**
   * fetch con timeout y log de duración (va a los Runtime Logs; nunca loguea credenciales:
   * el label es sólo el path).
   */
  private async http(label: string, url: string, init: RequestInit): Promise<Response> {
    const started = Date.now();
    try {
      const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      console.log(`[iol] ${label} -> ${res.status} en ${Date.now() - started} ms`);
      return res;
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        console.error(`[iol] ${label} sin respuesta tras ${this.timeoutMs} ms`);
        throw new IolApiError(
          `IOL no respondió en ${Math.round(this.timeoutMs / 1000)} s (${label}). Probá de nuevo o con un rango de fechas más corto.`,
          504,
        );
      }
      throw new IolApiError(`No se pudo conectar con IOL (${label}): ${(e as Error).message}`, 502);
    }
  }

  // ---------- auth ----------

  private async requestToken(body: Record<string, string>): Promise<TokenSet> {
    const res = await this.http(
      `POST /auth/token (${body.grant_type})`,
      `${this.baseUrl}/auth/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg =
        body.grant_type === 'password' && res.status === 401
          ? 'IOL rechazó usuario o contraseña (revisá IOL_USERNAME / IOL_PASSWORD).'
          : `IOL /auth/token respondió ${res.status}: ${errorMessage(json)}`;
      throw new IolApiError(msg, res.status, traceOf(json));
    }
    const parsed = envelope(tokenData).safeParse(json);
    if (!parsed.success) throw new IolApiError('Respuesta de token inesperada de IOL', 502);
    const t = parsed.data.data;
    const now = this.now();
    return {
      accessToken: t.access_token,
      accessExpiresAt: now + t.expires_in * 1000,
      refreshToken: t.refresh_token,
      refreshExpiresAt: now + REFRESH_TTL_MS,
    };
  }

  private async tokens(): Promise<TokenSet | null> {
    if (this.memo === undefined) this.memo = await this.store.load();
    return this.memo;
  }

  private async persist(t: TokenSet | null) {
    this.memo = t;
    await this.store.save(t);
  }

  /** Access token vigente: reutiliza, renueva con refresh o hace login, en ese orden. */
  async accessToken(force = false): Promise<string> {
    const t = await this.tokens();
    if (!force && t && t.accessExpiresAt - SKEW_MS > this.now()) return t.accessToken;
    if (!this.inflight) {
      this.inflight = this.renew().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async renew(): Promise<string> {
    const now = this.now();
    const t = await this.tokens();
    if (t && t.refreshExpiresAt - SKEW_MS > now) {
      try {
        const next = await this.requestToken({
          grant_type: 'refresh_token',
          refresh_token: t.refreshToken,
        });
        await this.persist(next);
        return next.accessToken;
      } catch (e) {
        // Refresh revocado/vencido: caemos al login con contraseña.
        if (!(e instanceof IolApiError) || e.status >= 500) throw e;
      }
    }
    const next = await this.requestToken({
      grant_type: 'password',
      username: this.creds.username,
      password: this.creds.password,
    });
    await this.persist(next);
    return next.accessToken;
  }

  async disconnect() {
    await this.persist(null);
  }

  async status() {
    const t = await this.tokens();
    return t
      ? {
          accessValidUntil: new Date(t.accessExpiresAt).toISOString(),
          refreshValidUntil: new Date(t.refreshExpiresAt).toISOString(),
        }
      : null;
  }

  // ---------- requests ----------

  private async get<T extends z.ZodType>(
    path: string,
    query: Record<string, string>,
    schema: T,
  ): Promise<z.infer<T>> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(query)}`;
    const send = async (force: boolean) =>
      this.http(`GET ${path}`, url, {
        headers: {
          authorization: `Bearer ${await this.accessToken(force)}`,
          accept: 'application/json',
        },
      });
    let res = await send(false);
    // Token invalidado del lado de IOL antes de su vencimiento: renovamos una vez.
    if (res.status === 401) res = await send(true);
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new IolApiError(
        `IOL ${path} respondió ${res.status}: ${errorMessage(json)}`,
        res.status,
        traceOf(json),
      );
    }
    const parsed = envelope(schema).safeParse(json);
    if (!parsed.success) {
      throw new IolApiError(
        `Respuesta inesperada de IOL en ${path}: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
        502,
        traceOf(json),
      );
    }
    return (parsed.data as { data: unknown }).data as z.infer<T>;
  }

  /** Movimientos de cuenta (incluyen gastos desglosados, pero no el ticker). */
  activities(from: string, to: string) {
    return this.get(
      '/broker/accounts/activities',
      { start_date: from, end_date: to, state: 'completed', country: 'AR' },
      z.array(iolActivity),
    );
  }

  /** Operaciones de trading (tienen ticker y tipo de asset; se cruzan con activities por ticket_id). */
  operations(from: string, to: string) {
    return this.get(
      '/broker/accounts/activities/operations',
      { start_date: from, end_date: to, country: 'AR' },
      z.array(iolOperation),
    );
  }

  /** Cierres diarios (OHLCV) en BCBA. */
  async dailyCloses(symbol: string, from: string, to: string) {
    const data = await this.get(
      `/broker/market-data/${encodeURIComponent(symbol)}/bars`,
      { market: 'BCBA', from: `${from} 00:00:00`, to: `${to} 23:59:59` },
      iolBars,
    );
    return data.bars.map((b) => ({ date: b.datetime.slice(0, 10), close: b.close }));
  }
}

function errorMessage(json: unknown): string {
  const e = (json as { error?: { message?: string } } | null)?.error;
  return e?.message ?? 'sin detalle';
}
function traceOf(json: unknown): string | undefined {
  return (json as { meta?: { trace_id?: string } } | null)?.meta?.trace_id;
}
