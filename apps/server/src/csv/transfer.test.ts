import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { createNodeDb, MIGRATIONS_FOLDER } from '../db/node-client';
import { CSV_ENTITIES } from './transfer';

async function newApp() {
  const db = await createNodeDb(':memory:');
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const app = createApp({ db, auth: { password: '', sessionSecret: '', production: false } });
  const json = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  const csvPost = async (entity: string, text: string) => {
    const r = await app.request(`/api/csv/${entity}`, { method: 'POST', body: text });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { app, json, csvPost };
}

describe('CSV import/export', () => {
  it('backup completo: exportar e importar en una base vacía da el mismo portafolio', async () => {
    const a = await newApp();
    const inst = (await (
      await a.json('POST', '/api/instruments', {
        ticker: 'AL30',
        type: 'BOND',
        currency: 'USD_MEP',
        notes: 'con, coma',
      })
    ).json()) as any;
    await a.json('POST', '/api/operations', {
      type: 'DEPOSIT',
      date: '2025-01-02',
      currency: 'USD_MEP',
      amount: '1000',
    });
    await a.json('POST', '/api/operations', {
      type: 'BUY',
      date: '2025-01-03',
      currency: 'USD_MEP',
      instrumentId: inst.id,
      quantity: '1000',
      unitPrice: '64.2',
      commission: '3.2',
    });
    await a.json('POST', '/api/operations', {
      type: 'AMORTIZATION',
      date: '2025-01-09',
      currency: 'USD_MEP',
      instrumentId: inst.id,
      amount: '40',
      notes: 'línea "uno"\nlínea dos',
    });
    await a.json('POST', '/api/prices', { instrumentId: inst.id, date: '2025-02-01', price: '60' });
    await a.json('POST', '/api/fx-rates', { date: '2025-01-01', pair: 'USD_MEP', rate: '1200' });

    const files: Record<string, string> = {};
    for (const e of CSV_ENTITIES) {
      const r = await a.app.request(`/api/csv/${e}`);
      expect(r.headers.get('content-type')).toContain('text/csv');
      files[e] = await r.text();
    }

    const b = await newApp();
    for (const e of CSV_ENTITIES) expect((await b.csvPost(e, files[e] as string)).status).toBe(200);

    const pa = await (await a.app.request('/api/portfolio?currency=ARS&asOf=2025-03-01')).json();
    const pb = await (await b.app.request('/api/portfolio?currency=ARS&asOf=2025-03-01')).json();
    expect(pb).toEqual(pa);

    // Reimportar las operaciones no las duplica
    const again = await b.csvPost('operations', files.operations as string);
    expect(again.body).toMatchObject({ inserted: 0, skipped: 3 });
  });

  it('acepta ";" y decimales con coma (Excel es-AR)', async () => {
    const a = await newApp();
    await a.csvPost('instruments', 'ticker;type;currency\nGGAL;stock;ars\n');
    const r = await a.csvPost(
      'operations',
      'date;type;ticker;quantity;unit_price;amount;currency;commission\n2025-01-02;DEPOSIT;;;;1.000.000,50;ARS;\n2025-01-03;BUY;GGAL;10;6.200,5;;ARS;31\n',
    );
    expect(r.body).toEqual({ inserted: 2, updated: 0, skipped: 0 });
    const ops = (await (await a.app.request('/api/operations')).json()) as any[];
    expect(ops.map((o) => o.amount ?? o.unitPrice).sort()).toEqual(['1000000.5', '6200.5']);
  });

  it('valida todo antes de escribir y reporta filas con error', async () => {
    const a = await newApp();
    const r = await a.csvPost(
      'operations',
      'date,type,ticker,quantity,unit_price,amount,currency\n2025-01-02,DEPOSIT,,,,100,ARS\n2025-02-30,BUY,NOPE,1,1,,ARS\n',
    );
    expect(r.status).toBe(422);
    expect(r.body.issues.join(' ')).toMatch(/Fila 3/);
    expect(r.body.issues.join(' ')).toMatch(/NOPE/);
    const ops = (await (await a.app.request('/api/operations')).json()) as any[];
    expect(ops).toHaveLength(0);
  });

  it('rechaza importar una venta en descubierto', async () => {
    const a = await newApp();
    await a.csvPost('instruments', 'ticker,type,currency\nGGAL,STOCK,ARS\n');
    const r = await a.csvPost(
      'operations',
      'date,type,ticker,quantity,unit_price,currency\n2025-01-03,SELL,GGAL,10,1,ARS\n',
    );
    expect(r.status).toBe(422);
  });
});
