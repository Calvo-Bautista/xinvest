import { describe, expect, it } from 'vitest';
import { IolApiError, IolClient, type TokenSet, type TokenStore } from './client';
import { decryptJson, encryptJson } from './crypto';

const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ meta: { trace_id: 't' }, data, error: null }), { status });
const fail = (status: number, message = 'x') =>
  new Response(JSON.stringify({ meta: { trace_id: 't' }, data: null, error: { message } }), {
    status,
  });
const token = (id: string) => ({
  access_token: `A${id}`,
  refresh_token: `R${id}`,
  expires_in: 900,
});

function setup(initial: TokenSet | null = null) {
  let now = 1_000_000;
  let saved: TokenSet | null = initial;
  const store: TokenStore = {
    load: async () => saved,
    save: async (t) => {
      saved = t;
    },
  };
  const calls: { url: string; body?: any; auth?: string }[] = [];
  const handlers: ((url: string, init?: RequestInit) => Response | undefined)[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: input, body, auth: (init?.headers as any)?.authorization });
    for (const h of handlers) {
      const r = h(input, init);
      if (r) return r;
    }
    throw new Error(`fetch inesperado: ${input}`);
  }) as typeof fetch;
  const client = new IolClient({ username: 'u', password: 'p' }, store, {
    fetch: fetchImpl,
    baseUrl: 'https://iol.test',
    now: () => now,
  });
  return {
    client,
    calls,
    handlers,
    saved: () => saved,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('IolClient auth', () => {
  it('login con contraseña la primera vez y reutiliza el token vigente', async () => {
    const t = setup();
    t.handlers.push((url) => (url.endsWith('/auth/token') ? ok(token('1')) : undefined));
    t.handlers.push((url) => (url.includes('/activities?') ? ok([]) : undefined));
    await t.client.activities('2025-01-01', '2025-01-31');
    await t.client.activities('2025-01-01', '2025-01-31');
    const tokenCalls = t.calls.filter((c) => c.url.endsWith('/auth/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.body).toEqual({ grant_type: 'password', username: 'u', password: 'p' });
    expect(t.calls.at(-1)?.auth).toBe('Bearer A1');
    expect(t.saved()?.refreshToken).toBe('R1');
  });

  it('cuando vence el access token usa el refresh token, no la contraseña', async () => {
    const t = setup();
    let i = 0;
    t.handlers.push((url) => (url.endsWith('/auth/token') ? ok(token(String(++i))) : undefined));
    t.handlers.push(() => ok([]));
    await t.client.activities('2025-01-01', '2025-01-02');
    t.advance(16 * 60_000);
    await t.client.activities('2025-01-01', '2025-01-02');
    const bodies = t.calls.filter((c) => c.url.endsWith('/auth/token')).map((c) => c.body);
    expect(bodies[1]).toEqual({ grant_type: 'refresh_token', refresh_token: 'R1' });
    expect(t.calls.at(-1)?.auth).toBe('Bearer A2');
  });

  it('si el refresh es rechazado vuelve a loguearse con contraseña', async () => {
    const t = setup({
      accessToken: 'old',
      accessExpiresAt: 0,
      refreshToken: 'Rold',
      refreshExpiresAt: 9e15,
    });
    t.handlers.push((url, init) => {
      if (!url.endsWith('/auth/token')) return undefined;
      const body = JSON.parse(String(init?.body));
      return body.grant_type === 'refresh_token' ? fail(401) : ok(token('new'));
    });
    t.handlers.push(() => ok([]));
    await t.client.activities('2025-01-01', '2025-01-02');
    expect(t.calls.at(-1)?.auth).toBe('Bearer Anew');
  });

  it('un 401 en un endpoint fuerza renovar y reintenta una vez', async () => {
    const t = setup({
      accessToken: 'revocado',
      accessExpiresAt: 9e15,
      refreshToken: 'R',
      refreshExpiresAt: 9e15,
    });
    t.handlers.push((url) => (url.endsWith('/auth/token') ? ok(token('2')) : undefined));
    t.handlers.push((_url, init) =>
      (init?.headers as any)?.authorization === 'Bearer revocado' ? fail(401) : ok([]),
    );
    await expect(t.client.activities('2025-01-01', '2025-01-02')).resolves.toEqual([]);
  });

  it('credenciales inválidas dan un error claro', async () => {
    const t = setup();
    t.handlers.push(() => fail(401, 'invalid'));
    await expect(t.client.activities('2025-01-01', '2025-01-02')).rejects.toThrow(
      /usuario o contraseña/,
    );
  });

  it('valida la forma de la respuesta', async () => {
    const t = setup();
    t.handlers.push((url) => (url.endsWith('/auth/token') ? ok(token('1')) : undefined));
    t.handlers.push(() => ok([{ id: 1 }]));
    await expect(t.client.activities('2025-01-01', '2025-01-02')).rejects.toBeInstanceOf(
      IolApiError,
    );
  });

  it('dailyCloses arma el rango con hora y devuelve fecha + cierre', async () => {
    const t = setup();
    t.handlers.push((url) => (url.endsWith('/auth/token') ? ok(token('1')) : undefined));
    t.handlers.push((url) =>
      url.includes('/bars?')
        ? ok({
            bars: [
              {
                datetime: '2025-01-03T03:00:00Z',
                open: 1,
                high: 1,
                low: 1,
                close: 6250.5,
                volume: 1,
              },
            ],
          })
        : undefined,
    );
    expect(await t.client.dailyCloses('GGAL', '2025-01-01', '2025-01-31')).toEqual([
      { date: '2025-01-03', close: 6250.5 },
    ]);
    const url = new URL(t.calls.at(-1)?.url ?? '');
    expect(url.searchParams.get('from')).toBe('2025-01-01 00:00:00');
    expect(url.searchParams.get('market')).toBe('BCBA');
  });
});

describe('crypto', () => {
  it('cifra y descifra; con otra clave devuelve null', async () => {
    const enc = await encryptJson('k1', { a: 1 });
    expect(enc).not.toContain('"a"');
    expect(await decryptJson('k1', enc)).toEqual({ a: 1 });
    expect(await decryptJson('k2', enc)).toBeNull();
  });
});
