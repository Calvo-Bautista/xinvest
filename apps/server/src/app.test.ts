import { migrate } from 'drizzle-orm/libsql/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { createNodeDb, MIGRATIONS_FOLDER } from './db/node-client';

const noAuth = { password: '', sessionSecret: '', production: false };

async function setup(auth = noAuth) {
  const db = await createNodeDb(':memory:');
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const app = createApp({ db, auth });
  const req = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any, headers: res.headers };
  };
  return { app, req };
}

describe('API', () => {
  let req: Awaited<ReturnType<typeof setup>>['req'];
  beforeEach(async () => {
    ({ req } = await setup());
  });

  it('flujo completo: instrumento, operaciones, precio, cotización y portafolio', async () => {
    const inst = await req('POST', '/api/instruments', {
      ticker: 'al30',
      type: 'BOND',
      currency: 'ARS',
    });
    expect(inst.status).toBe(201);
    expect(inst.body.ticker).toBe('AL30');
    expect(inst.body.priceDivisor).toBe('100');

    expect(
      (
        await req('POST', '/api/operations', {
          type: 'DEPOSIT',
          date: '2025-01-02',
          currency: 'ARS',
          amount: '1000000',
        })
      ).status,
    ).toBe(201);
    const buy = await req('POST', '/api/operations', {
      type: 'BUY',
      date: '2025-01-03',
      currency: 'ARS',
      instrumentId: inst.body.id,
      quantity: '1000',
      unitPrice: '80000',
      commission: '400',
    });
    expect(buy.status).toBe(201);

    expect(
      (
        await req('POST', '/api/prices', {
          instrumentId: inst.body.id,
          date: '2025-02-01',
          price: '85000',
        })
      ).status,
    ).toBe(201);
    expect(
      (await req('POST', '/api/fx-rates', { date: '2025-01-01', pair: 'USD_MEP', rate: '1200' }))
        .status,
    ).toBe(201);

    const ars = await req('GET', '/api/portfolio?currency=ARS&asOf=2025-02-01');
    expect(ars.status).toBe(200);
    expect(ars.body.positions[0].marketValue).toBe('850000');
    expect(ars.body.positions[0].costBasis).toBe('800400');
    expect(ars.body.summary.totalValue).toBe('1049600'); // 850000 + caja 199600

    const usd = await req('GET', '/api/portfolio?currency=USD&asOf=2025-02-01');
    expect(usd.body.summary.netContributions).toBe('833.33333333');

    const tl = await req('GET', '/api/portfolio/timeline?currency=ARS&asOf=2025-02-01');
    expect(tl.body.points.at(-1).value).toBe('1049600');
  });

  it('rechaza una venta en descubierto con 422', async () => {
    const inst = await req('POST', '/api/instruments', {
      ticker: 'GGAL',
      type: 'STOCK',
      currency: 'ARS',
    });
    const res = await req('POST', '/api/operations', {
      type: 'SELL',
      date: '2025-01-03',
      currency: 'ARS',
      instrumentId: inst.body.id,
      quantity: '1',
      unitPrice: '1',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('GGAL');
  });

  it('rechaza borrar una compra que deja una venta en descubierto', async () => {
    const inst = await req('POST', '/api/instruments', {
      ticker: 'GGAL',
      type: 'STOCK',
      currency: 'ARS',
    });
    const buy = await req('POST', '/api/operations', {
      type: 'BUY',
      date: '2025-01-03',
      currency: 'ARS',
      instrumentId: inst.body.id,
      quantity: '10',
      unitPrice: '1',
    });
    await req('POST', '/api/operations', {
      type: 'SELL',
      date: '2025-01-04',
      currency: 'ARS',
      instrumentId: inst.body.id,
      quantity: '5',
      unitPrice: '1',
    });
    expect((await req('DELETE', `/api/operations/${buy.body.id}`)).status).toBe(422);
  });

  it('valida forma del payload (400) y tickers duplicados (409)', async () => {
    const bad = await req('POST', '/api/operations', {
      type: 'BUY',
      date: '2025-13-01',
      currency: 'ARS',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.issues.length).toBeGreaterThan(0);
    const badNum = await req('POST', '/api/operations', {
      type: 'DEPOSIT',
      date: '2025-01-01',
      currency: 'ARS',
      amount: '1.000,50',
    });
    expect(badNum.status).toBe(400);
    await req('POST', '/api/instruments', { ticker: 'GGAL', type: 'STOCK', currency: 'ARS' });
    expect(
      (await req('POST', '/api/instruments', { ticker: 'ggal', type: 'STOCK', currency: 'ARS' }))
        .status,
    ).toBe(409);
  });

  it('pide cotización MEP si se consulta en USD sin cotizaciones', async () => {
    await req('POST', '/api/operations', {
      type: 'DEPOSIT',
      date: '2025-01-02',
      currency: 'ARS',
      amount: '1',
    });
    const res = await req('GET', '/api/portfolio?currency=USD');
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('USD_MEP');
  });
});

describe('auth', () => {
  const auth = { password: 'secreta', sessionSecret: 'x'.repeat(32), production: false };

  it('bloquea sin sesión y permite tras login', async () => {
    const { req } = await setup(auth);
    expect((await req('GET', '/api/instruments')).status).toBe(401);
    expect((await req('GET', '/api/auth/me')).body.authenticated).toBe(false);
    const login = await req('POST', '/api/auth/login', { password: 'secreta' });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toMatch(/^xinvest_session=/);
    expect((await req('GET', '/api/instruments', undefined, { cookie })).status).toBe(200);
  });

  it('rechaza contraseña incorrecta', async () => {
    const { req } = await setup(auth);
    expect((await req('POST', '/api/auth/login', { password: 'nop' })).status).toBe(401);
  });

  it('en producción exige contraseña configurada', () => {
    expect(() => createApp({ db: {} as never, auth: { ...noAuth, production: true } })).toThrow();
  });
});
