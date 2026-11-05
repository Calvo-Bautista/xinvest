import { migrate } from 'drizzle-orm/libsql/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { IolClient } from '../adapters/iol/client';
import { dbTokenStore } from '../adapters/iol/store';
import { createApp } from '../app';
import { createNodeDb, MIGRATIONS_FOLDER } from '../db/node-client';
import type { Db } from '../db/types';
import { dateChunks, quoteSymbol } from './iol-sync';

const env = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ meta: { trace_id: 't' }, data, error: null }), { status });

/** IOL falsa: devuelve las fixtures según el path. */
function fakeIol(fixtures: {
  activities: any[];
  operations: any[];
  bars: Record<string, [string, number][]>;
}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.pathname === '/auth/token')
      return env({ access_token: 'A', refresh_token: 'R', expires_in: 900 });
    if (url.pathname === '/broker/accounts/activities') {
      const [s, e] = [
        url.searchParams.get('start_date') ?? '',
        url.searchParams.get('end_date') ?? '',
      ];
      return env(
        fixtures.activities.filter(
          (a) => a.trade_date.slice(0, 10) >= s && a.trade_date.slice(0, 10) <= e,
        ),
      );
    }
    if (url.pathname === '/broker/accounts/activities/operations') return env(fixtures.operations);
    const m = url.pathname.match(/^\/broker\/market-data\/([^/]+)\/bars$/);
    if (m) {
      const sym = decodeURIComponent(m[1] ?? '');
      const bars = fixtures.bars[sym];
      if (!bars)
        return new Response(JSON.stringify({ data: null, error: { message: 'not found' } }), {
          status: 404,
        });
      return env({
        symbol: sym,
        bars: bars.map(([d, close]) => ({ datetime: `${d}T03:00:00Z`, close })),
      });
    }
    throw new Error(`inesperado ${input}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const A = (o: any) => ({
  account_type: 'CI AR$',
  settlement_date: null,
  qty: 0,
  price: 0,
  currency: 'ARS',
  fees: { commission: 0, vat: 0, other: 0 },
  status: 'completed',
  ...o,
});

const FIXTURES = {
  activities: [
    A({ id: 1, activity_type: 'Deposit', trade_date: '2025-01-02', net_amount: 1000000 }),
    A({
      id: 2,
      ticket_id: 'T2',
      activity_type: 'Buy',
      trade_date: '2025-01-03',
      qty: 100,
      price: 6200,
      net_amount: -623000,
      fees: { commission: 2000, vat: 420, other: 580 },
    }),
    A({
      id: 3,
      ticket_id: 'T3',
      activity_type: 'Buy',
      trade_date: '2025-01-03',
      qty: 1000,
      price: 85000,
      net_amount: -850000,
    }),
    A({
      id: 4,
      ticket_id: 'T4',
      activity_type: 'Sell',
      trade_date: '2025-01-04',
      qty: 1000,
      price: 60,
      currency: 'USD',
      net_amount: 600,
    }),
    A({ id: 5, activity_type: 'Balance Remuneration', trade_date: '2025-01-05', net_amount: 50 }),
  ],
  operations: [
    { ticket_id: 'T2', symbol: 'GGAL', asset_type: 'stocks', description: 'Galicia' },
    { ticket_id: 'T3', symbol: 'AL30', asset_type: 'government_bonds', description: 'Bonar 2030' },
    { ticket_id: 'T4', symbol: 'AL30D', asset_type: 'government_bonds', description: 'Bonar 2030' },
  ],
  bars: {
    GGAL: [
      ['2025-01-03', 6200],
      ['2025-01-06', 6400],
    ],
    AL30: [
      ['2025-01-03', 85000],
      ['2025-01-06', 86000],
    ],
    AL30D: [
      ['2025-01-03', 70],
      ['2025-01-06', 71.5],
    ],
    AL30C: [['2025-01-03', 68]],
  } as Record<string, [string, number][]>,
};

async function setup(fixtures = FIXTURES) {
  const db: Db = await createNodeDb(':memory:');
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const iol = fakeIol(fixtures);
  const make = () =>
    new IolClient({ username: 'u', password: 'p' }, dbTokenStore(db, 'k'.repeat(32)), {
      fetch: iol.fetchImpl,
      baseUrl: 'https://iol.test',
    });
  const app = createApp({
    db,
    auth: { password: '', sessionSecret: '', production: false },
    iol: make,
    cronSecret: 'cron-secret',
  });
  const req = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const r = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { db, req, iol };
}

describe('sync de operaciones IOL', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });

  it('dry-run previsualiza sin escribir', async () => {
    const r = await t.req('POST', '/api/iol/sync/operations', {
      from: '2025-01-01',
      to: '2025-01-31',
      dryRun: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(false);
    expect(r.body.counts).toEqual({ new: 4, linked: 0, existing: 0, unmapped: 1 });
    expect(r.body.newInstruments).toEqual([
      { ticker: 'GGAL', type: 'STOCK', priceDivisor: '1' },
      { ticker: 'AL30', type: 'BOND', priceDivisor: '100' },
    ]);
    expect((await t.req('GET', '/api/operations')).body).toHaveLength(0);
  });

  it('aplica, vincula lo cargado a mano y es idempotente', async () => {
    // Depósito que el usuario ya había cargado a mano
    await t.req('POST', '/api/operations', {
      type: 'DEPOSIT',
      date: '2025-01-02',
      currency: 'ARS',
      amount: '1000000',
    });

    const r = await t.req('POST', '/api/iol/sync/operations', {
      from: '2025-01-01',
      to: '2025-01-31',
      dryRun: false,
    });
    expect(r.body.applied).toBe(true);
    expect(r.body.counts).toEqual({ new: 3, linked: 1, existing: 0, unmapped: 1 });

    const ops = (await t.req('GET', '/api/operations')).body as any[];
    expect(ops).toHaveLength(4);
    expect(ops.every((o) => o.externalId?.startsWith('iol:'))).toBe(true);
    const sell = ops.find((o) => o.type === 'SELL');
    expect(sell).toMatchObject({ ticker: 'AL30', currency: 'USD_MEP', source: 'iol' });
    const ggal = ops.find((o) => o.ticker === 'GGAL');
    expect(ggal).toMatchObject({ commission: '2000', taxes: '420', marketFees: '580' });

    const again = await t.req('POST', '/api/iol/sync/operations', {
      from: '2025-01-01',
      to: '2025-01-31',
      dryRun: false,
    });
    expect(again.body.counts).toEqual({ new: 0, linked: 0, existing: 4, unmapped: 1 });
    expect((await t.req('GET', '/api/operations')).body).toHaveLength(4);
  });

  it('no aplica si la historia queda inconsistente (venta sin compra en el rango)', async () => {
    const r = await t.req('POST', '/api/iol/sync/operations', {
      from: '2025-01-04',
      to: '2025-01-31',
      dryRun: false,
    });
    expect(r.body.applied).toBe(false);
    expect(r.body.validationError).toMatch(/AL30.*sincronizá desde una fecha anterior/);
    expect((await t.req('GET', '/api/operations')).body).toHaveLength(0);
  });

  it('la primera sync exige fecha de inicio; las siguientes la infieren', async () => {
    expect((await t.req('POST', '/api/iol/sync/operations', { dryRun: true })).status).toBe(400);
    await t.req('POST', '/api/iol/sync/operations', {
      from: '2025-01-01',
      to: '2025-01-31',
      dryRun: false,
    });
    const st = (await t.req('GET', '/api/iol/status')).body;
    expect(st).toMatchObject({
      configured: true,
      lastOperationsSyncTo: '2025-01-31',
      defaultFrom: '2025-01-21',
    });
    expect(st.session.refreshValidUntil).toBeTruthy();
  });

  it('guarda los tokens cifrados', async () => {
    await t.req('POST', '/api/iol/connect');
    const rows = await t.db.query.integrations.findMany();
    expect(rows[0]?.tokenData).toMatch(/^v1\./);
    expect(rows[0]?.tokenData).not.toContain('"accessToken"');
  });
});

describe('sync de precios IOL', () => {
  it('trae cierres por instrumento y calcula MEP/CCL implícito de AL30', async () => {
    const t = await setup();
    await t.req('POST', '/api/iol/sync/operations', {
      from: '2025-01-01',
      to: '2025-01-31',
      dryRun: false,
    });
    const r = await t.req('POST', '/api/iol/sync/prices', { from: '2025-01-01', to: '2025-01-31' });
    expect(r.status).toBe(200);
    expect(r.body.fx).toEqual({ mep: 2, ccl: 1 });
    expect(r.body.instruments.map((i: any) => [i.ticker, i.points])).toEqual(
      expect.arrayContaining([
        ['GGAL', 2],
        ['AL30', 2],
      ]),
    );
    const fx = (await t.req('GET', '/api/fx-rates')).body as any[];
    expect(fx.find((x) => x.date === '2025-01-03' && x.pair === 'USD_MEP')?.rate).toBe('1214.29'); // 85000/70
    expect(fx.find((x) => x.date === '2025-01-03' && x.pair === 'USD_CCL')?.rate).toBe('1250');

    // Un precio manual del mismo día gana sobre el de IOL
    const ggalId = ((await t.req('GET', '/api/instruments')).body as any[]).find(
      (i) => i.ticker === 'GGAL',
    ).id;
    await t.req('POST', '/api/prices', { instrumentId: ggalId, date: '2025-01-06', price: '9999' });
    const snap = (await t.req('GET', '/api/portfolio?currency=ARS&asOf=2025-01-06')).body;
    expect(snap.positions.find((p: any) => p.ticker === 'GGAL').price).toBe('9999');
  });
});

describe('cron', () => {
  it('exige CRON_SECRET y no usa la sesión', async () => {
    const t = await setup();
    expect((await t.req('GET', '/api/cron/iol')).status).toBe(401);
    const ok = await t.req('GET', '/api/cron/iol', undefined, {
      authorization: 'Bearer cron-secret',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.operations).toMatch(/primera/);
  });

  it('sin credenciales los endpoints de IOL responden 409', async () => {
    const db: Db = await createNodeDb(':memory:');
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const app = createApp({ db, auth: { password: '', sessionSecret: '', production: false } });
    const r = await app.request('/api/iol/connect', { method: 'POST' });
    expect(r.status).toBe(409);
  });
});

describe('helpers', () => {
  it('dateChunks parte rangos largos sin huecos ni solapes', () => {
    expect(dateChunks('2025-01-01', '2025-01-10', 4)).toEqual([
      ['2025-01-01', '2025-01-04'],
      ['2025-01-05', '2025-01-08'],
      ['2025-01-09', '2025-01-10'],
    ]);
  });
  it('quoteSymbol arma la especie en la moneda del instrumento', () => {
    expect(quoteSymbol({ ticker: 'AL30', type: 'BOND', currency: 'ARS' })).toBe('AL30');
    expect(quoteSymbol({ ticker: 'AAPL', type: 'CEDEAR', currency: 'USD_MEP' })).toBe('AAPLD');
    expect(quoteSymbol({ ticker: 'YMCXO', type: 'ON', currency: 'USD_CCL' })).toBe('YMCXC');
  });
});
