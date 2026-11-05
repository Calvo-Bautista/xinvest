/**
 * Datos de ejemplo realistas (valores ilustrativos, no cotizaciones reales exactas).
 * Cubre: venta parcial (GGAL), cierre total (KO), CEDEAR comprado en USD MEP (AAPL),
 * bono con renta + amortización (AL30), ON con renta, caución con TNA, FCI, dividendos con
 * retención, depósitos/retiros en ARS y USD.
 *
 * BORRA todos los datos. Sólo corre contra una DB local (file:) salvo que se pase --force.
 */
import { computePortfolio, Dec, validateOperations } from '@xinvest/domain';
import { toFxRatePoint, toInstrument, toOperation, toPricePoint } from './mappers';
import { createNodeDb, databaseUrl } from './node-client';
import { fxRatesRepo, instrumentsRepo, operationsRepo, pricesRepo } from './repositories';
import { fxRates, instruments, operations, prices } from './schema';

const url = databaseUrl();
if (!url.startsWith('file:') && !process.argv.includes('--force')) {
  console.error(
    `La DB no es local (${url.split('?')[0]}). El seed borra todo: usá --force si es intencional.`,
  );
  process.exit(1);
}
const db = await createNodeDb(url);

await db.delete(prices);
await db.delete(fxRates);
await db.delete(operations);
await db.delete(instruments);

// ---------- helpers ----------
const D = (v: string | number) => new Dec(v);
const r2 = (v: Dec) => v.toDecimalPlaces(2).toFixed();

/** Gastos típicos de un broker local: comisión 0,5 %, derechos 0,08 %, IVA 21 % s/comisión. */
function fees(gross: Dec) {
  const commission = gross.times('0.005');
  return {
    commission: r2(commission),
    marketFees: r2(gross.times('0.0008')),
    taxes: r2(commission.times('0.21')),
  };
}

/** Serie mensual (día 1) interpolada linealmente entre anclas, más el último ancla. */
function monthly(anchors: [string, number][], digits = 2): [string, string][] {
  const out: [string, string][] = [];
  const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
  for (let i = 0; i < anchors.length - 1; i++) {
    // biome-ignore lint/style/noNonNullAssertion: índices dentro de rango
    const [d0, v0] = anchors[i]!;
    // biome-ignore lint/style/noNonNullAssertion: idem
    const [d1, v1] = anchors[i + 1]!;
    const cur = new Date(`${d0}T00:00:00Z`);
    while (cur.getTime() < t(d1)) {
      const iso = cur.toISOString().slice(0, 10);
      const k = (cur.getTime() - t(d0)) / (t(d1) - t(d0));
      out.push([iso, (v0 + (v1 - v0) * k).toFixed(digits)]);
      cur.setUTCMonth(cur.getUTCMonth() + 1, 1);
    }
  }
  // biome-ignore lint/style/noNonNullAssertion: hay al menos un ancla
  const [dl, vl] = anchors.at(-1)!;
  out.push([dl, vl.toFixed(digits)]);
  return out;
}

// ---------- instrumentos ----------
const I = instrumentsRepo(db);
const GGAL = await I.create({
  ticker: 'GGAL',
  name: 'Grupo Financiero Galicia',
  type: 'STOCK',
  currency: 'ARS',
});
const YPFD = await I.create({ ticker: 'YPFD', name: 'YPF', type: 'STOCK', currency: 'ARS' });
const AAPL = await I.create({
  ticker: 'AAPL',
  name: 'Apple (CEDEAR)',
  type: 'CEDEAR',
  currency: 'USD_MEP',
  cedearRatio: '20',
  notes: 'Precios cargados en USD MEP (especie AAPLD).',
});
const KO = await I.create({
  ticker: 'KO',
  name: 'Coca-Cola (CEDEAR)',
  type: 'CEDEAR',
  currency: 'ARS',
  cedearRatio: '5',
});
const AL30 = await I.create({
  ticker: 'AL30',
  name: 'Bonar 2030',
  type: 'BOND',
  currency: 'USD_MEP',
  priceDivisor: '100',
  notes: 'Paga renta y amortiza 4 % del VN original cada 9/1 y 9/7.',
});
const ON = await I.create({
  ticker: 'YMCXO',
  name: 'ON YPF (ejemplo) 8,75 %',
  type: 'ON',
  currency: 'USD_MEP',
  priceDivisor: '100',
});
const FCI = await I.create({
  ticker: 'IOLCAMA',
  name: 'FCI money market (ejemplo)',
  type: 'FCI',
  currency: 'ARS',
});
const CAU = await I.create({
  ticker: 'CAUCION',
  name: 'Caución colocadora',
  type: 'CAUCION',
  currency: 'ARS',
});

// ---------- operaciones ----------
type Op = Parameters<ReturnType<typeof operationsRepo>['create']>[0];
const ops: Op[] = [];
const trade = (
  date: string,
  type: 'BUY' | 'SELL',
  inst: { id: number; priceDivisor: string },
  quantity: string,
  unitPrice: string,
  currency: Op['currency'],
  notes?: string,
  withFees = true,
) => {
  const gross = D(quantity).times(unitPrice).div(inst.priceDivisor);
  ops.push({
    date,
    type,
    instrumentId: inst.id,
    quantity,
    unitPrice,
    currency,
    ...(withFees ? fees(gross) : {}),
    notes: notes ?? null,
  });
};
const event = (
  date: string,
  type: 'DIVIDEND' | 'COUPON' | 'AMORTIZATION',
  inst: { id: number },
  amount: string,
  currency: Op['currency'],
  taxes = '0',
  notes?: string,
) => ops.push({ date, type, instrumentId: inst.id, amount, currency, taxes, notes: notes ?? null });
const cash = (
  date: string,
  type: 'DEPOSIT' | 'WITHDRAWAL',
  amount: string,
  currency: Op['currency'],
  notes?: string,
) => ops.push({ date, type, amount, currency, notes: notes ?? null });

cash('2025-01-02', 'DEPOSIT', '3000000', 'ARS', 'Transferencia inicial');
cash('2025-01-02', 'DEPOSIT', '2000', 'USD_MEP', 'Dólares propios');
trade('2025-01-03', 'BUY', AL30, '1500', '64.20', 'USD_MEP', '1500 VN a 64,20 USD c/100');
trade('2025-01-08', 'BUY', GGAL, '300', '6200', 'ARS');
trade('2025-01-08', 'BUY', AAPL, '40', '12.10', 'USD_MEP', 'Comprado como AAPLD');
event('2025-01-09', 'COUPON', AL30, '5.40', 'USD_MEP', '0', 'Renta 0,375 % s/ valor residual 96');
event('2025-01-09', 'AMORTIZATION', AL30, '60', 'USD_MEP', '0', 'Amortiza 4 % de 1500 VN');
event(
  '2025-02-14',
  'DIVIDEND',
  AAPL,
  '0.50',
  'USD_MEP',
  '0.15',
  '2 acciones subyacentes × 0,25; retención 30 %',
);
trade('2025-03-12', 'BUY', KO, '60', '17500', 'ARS');
event(
  '2025-04-01',
  'DIVIDEND',
  KO,
  '6.12',
  'USD_MEP',
  '1.84',
  'Dividendo en USD de CEDEAR comprado en pesos',
);
cash('2025-05-30', 'DEPOSIT', '1500000', 'ARS');
trade('2025-06-02', 'BUY', YPFD, '25', '38000', 'ARS');
event('2025-07-09', 'COUPON', AL30, '5.18', 'USD_MEP');
event('2025-07-09', 'AMORTIZATION', AL30, '60', 'USD_MEP');
trade('2025-08-01', 'BUY', CAU, '500000', '1', 'ARS', 'Caución 7 días, TNA 36 %', false);
trade('2025-08-08', 'SELL', CAU, '500000', '1.00690411', 'ARS', 'Cierre: 1 + 0,36 × 7/365', false);
trade('2025-09-15', 'BUY', FCI, '20000', '24.50', 'ARS', 'Suscripción en cuotapartes', false);
trade('2025-11-10', 'SELL', GGAL, '120', '7100', 'ARS', 'Venta parcial: 120 de 300');
cash('2025-12-10', 'WITHDRAWAL', '200000', 'ARS');
event('2026-01-09', 'COUPON', AL30, '4.95', 'USD_MEP');
event('2026-01-09', 'AMORTIZATION', AL30, '60', 'USD_MEP');
cash('2026-03-02', 'DEPOSIT', '2500', 'USD_MEP');
trade('2026-03-03', 'BUY', AAPL, '30', '14.80', 'USD_MEP');
trade('2026-03-04', 'BUY', ON, '2000', '101.20', 'USD_MEP');
trade('2026-06-01', 'SELL', KO, '60', '22500', 'ARS', 'Cierre total de la posición');
event('2026-07-09', 'COUPON', AL30, '4.73', 'USD_MEP');
event('2026-07-09', 'AMORTIZATION', AL30, '60', 'USD_MEP');
event('2026-09-04', 'COUPON', ON, '87.50', 'USD_MEP', '0', '8,75 % anual / 2 sobre 2000 VN');

const O = operationsRepo(db);
for (const op of ops) await O.create(op);

// ---------- precios (serie mensual) ----------
const series: [{ id: number; currency: Op['currency'] }, [string, number][], number?][] = [
  [
    GGAL,
    [
      ['2025-01-01', 6200],
      ['2025-04-01', 5900],
      ['2025-07-01', 5200],
      ['2025-09-01', 4100],
      ['2025-10-01', 4300],
      ['2025-11-01', 7000],
      ['2026-01-01', 7400],
      ['2026-06-01', 6900],
      ['2026-11-04', 7650],
    ],
  ],
  [
    YPFD,
    [
      ['2025-06-01', 38000],
      ['2025-09-01', 31000],
      ['2025-11-01', 47000],
      ['2026-03-01', 44000],
      ['2026-11-04', 52500],
    ],
  ],
  [
    AAPL,
    [
      ['2025-01-01', 12.1],
      ['2025-04-01', 10.4],
      ['2025-07-01', 11.3],
      ['2025-10-01', 13.5],
      ['2026-03-01', 14.8],
      ['2026-11-04', 15.6],
    ],
  ],
  [
    KO,
    [
      ['2025-03-01', 17500],
      ['2025-09-01', 19800],
      ['2026-06-01', 22500],
    ],
  ],
  [
    AL30,
    [
      ['2025-01-01', 64.2],
      ['2025-04-01', 60],
      ['2025-09-01', 54],
      ['2025-11-01', 62],
      ['2026-03-01', 61],
      ['2026-11-04', 63.1],
    ],
  ],
  [
    ON,
    [
      ['2026-03-01', 101.2],
      ['2026-07-01', 100.4],
      ['2026-11-04', 102],
    ],
  ],
  [
    FCI,
    [
      ['2025-09-01', 24.5],
      ['2026-11-04', 34.6],
    ],
    4,
  ],
];
const P = pricesRepo(db);
for (const [inst, anchors, digits] of series) {
  for (const [date, price] of monthly(anchors, digits)) {
    await P.upsert({ instrumentId: inst.id, date, price, currency: inst.currency });
  }
}

// ---------- dólar MEP / CCL ----------
const mep: [string, number][] = [
  ['2025-01-01', 1180],
  ['2025-04-01', 1250],
  ['2025-05-01', 1180],
  ['2025-07-01', 1240],
  ['2025-09-01', 1390],
  ['2025-10-01', 1520],
  ['2025-11-01', 1440],
  ['2026-01-01', 1490],
  ['2026-04-01', 1430],
  ['2026-07-01', 1460],
  ['2026-11-04', 1490],
];
const F = fxRatesRepo(db);
for (const [date, rate] of monthly(mep)) {
  await F.upsert({ date, pair: 'USD_MEP', rate });
  await F.upsert({ date, pair: 'USD_CCL', rate: r2(D(rate).times('1.02')) });
}

// ---------- verificación ----------
const input = {
  instruments: (await I.list()).map(toInstrument),
  operations: (await O.list()).map(toOperation),
  prices: (await P.list()).map(toPricePoint),
  fxRates: (await F.list()).map(toFxRatePoint),
};
validateOperations(input.instruments, input.operations);
for (const reporting of ['ARS', 'USD'] as const) {
  const s = computePortfolio(input, { asOf: '2026-11-04', reporting }).summary;
  console.log(
    `${reporting}: valor ${s.totalValue.toFixed(2)} · aportado ${s.netContributions.toFixed(2)} · P&L ${s.totalPnl.toFixed(2)}`,
  );
}
console.log(
  `Seed OK: ${ops.length} operaciones, ${input.prices.length} precios, ${input.fxRates.length} cotizaciones.`,
);
