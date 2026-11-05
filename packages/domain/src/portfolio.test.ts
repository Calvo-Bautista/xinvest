import { describe, expect, it } from 'vitest';
import { type Dec, dec } from './decimal';
import { MissingFxRateError } from './fx';
import {
  computePortfolio,
  DomainError,
  PortfolioContext,
  type PortfolioInput,
  validateOperations,
} from './portfolio';
import { computeTimeline, sampleDates } from './timeline';
import type { Currency, FxRatePoint, Instrument, Operation, PricePoint } from './types';

// ---------- builders ----------
const inst = (id: number, ticker: string, extra: Partial<Instrument> = {}): Instrument => ({
  id,
  ticker,
  name: null,
  type: 'STOCK',
  currency: 'ARS',
  priceDivisor: dec(1),
  cedearRatio: null,
  ...extra,
});

let nextId = 1;
type OpInit = {
  date: string;
  type: Operation['type'];
  instrumentId?: number;
  quantity?: string;
  unitPrice?: string;
  amount?: string;
  currency?: Currency;
  commission?: string;
  marketFees?: string;
  taxes?: string;
};
const op = (o: OpInit): Operation => ({
  id: nextId++,
  date: o.date,
  type: o.type,
  instrumentId: o.instrumentId ?? null,
  quantity: o.quantity != null ? dec(o.quantity) : null,
  unitPrice: o.unitPrice != null ? dec(o.unitPrice) : null,
  amount: o.amount != null ? dec(o.amount) : null,
  currency: o.currency ?? 'ARS',
  commission: dec(o.commission ?? '0'),
  marketFees: dec(o.marketFees ?? '0'),
  taxes: dec(o.taxes ?? '0'),
});
const price = (
  instrumentId: number,
  date: string,
  p: string,
  currency: Currency = 'ARS',
): PricePoint => ({
  instrumentId,
  date,
  price: dec(p),
  currency,
});
const mep = (date: string, rate: string): FxRatePoint => ({
  date,
  pair: 'USD_MEP',
  rate: dec(rate),
});
const ccl = (date: string, rate: string): FxRatePoint => ({
  date,
  pair: 'USD_CCL',
  rate: dec(rate),
});

const input = (p: Partial<PortfolioInput>): PortfolioInput => ({
  instruments: [],
  operations: [],
  prices: [],
  fxRates: [],
  ...p,
});

const s = (v: Dec | null | undefined) => (v == null ? null : v.toDecimalPlaces(8).toFixed());

// ---------- tests ----------
describe('precio promedio ponderado', () => {
  const GGAL = inst(1, 'GGAL');
  const ops = () => [
    op({
      date: '2025-01-10',
      type: 'BUY',
      instrumentId: 1,
      quantity: '100',
      unitPrice: '10',
      commission: '10',
    }),
    op({
      date: '2025-02-10',
      type: 'BUY',
      instrumentId: 1,
      quantity: '100',
      unitPrice: '20',
      commission: '15',
      marketFees: '5',
    }),
  ];

  it('incluye los gastos en el costo y pondera por cantidad', () => {
    const snap = computePortfolio(input({ instruments: [GGAL], operations: ops() }), {
      asOf: '2025-03-01',
      reporting: 'ARS',
    });
    const p = snap.positions[0];
    expect(s(p?.quantity)).toBe('200');
    expect(s(p?.costBasis)).toBe('3030'); // 1000+10 + 2000+20
    expect(s(p?.avgPrice)).toBe('15.15');
  });

  it('venta parcial: el PPP no cambia y el realizado es ingreso neto − PPP × cantidad', () => {
    const operations = [
      ...ops(),
      op({
        date: '2025-03-01',
        type: 'SELL',
        instrumentId: 1,
        quantity: '50',
        unitPrice: '25',
        commission: '5',
      }),
    ];
    const snap = computePortfolio(
      input({ instruments: [GGAL], operations, prices: [price(1, '2025-03-01', '25')] }),
      { asOf: '2025-03-01', reporting: 'ARS' },
    );
    const p = snap.positions[0];
    expect(s(p?.quantity)).toBe('150');
    expect(s(p?.avgPrice)).toBe('15.15');
    expect(s(p?.costBasis)).toBe('2272.5');
    // 50×25 − 5 = 1245 ; costo vendido = 15.15 × 50 = 757.5
    expect(s(p?.realizedPnl)).toBe('487.5');
    expect(s(p?.realizedPct)).toBe(s(dec('487.5').div('757.5')));
    // no realizado: 150 × 25 − 2272.5
    expect(s(p?.unrealizedPnl)).toBe('1477.5');
    expect(p?.open).toBe(true);
  });

  it('venta total cierra la posición con costo 0', () => {
    const operations = [
      ...ops(),
      op({ date: '2025-03-01', type: 'SELL', instrumentId: 1, quantity: '200', unitPrice: '12' }),
    ];
    const p = computePortfolio(input({ instruments: [GGAL], operations }), {
      asOf: '2025-04-01',
      reporting: 'ARS',
    }).positions[0];
    expect(p?.open).toBe(false);
    expect(s(p?.costBasis)).toBe('0');
    expect(s(p?.realizedPnl)).toBe('-630'); // 2400 − 3030
    expect(p?.avgPrice).toBeNull();
  });

  it('rechaza vender más de lo que hay', () => {
    const operations = [
      op({ date: '2025-01-10', type: 'BUY', instrumentId: 1, quantity: '10', unitPrice: '10' }),
      op({ date: '2025-01-09', type: 'SELL', instrumentId: 1, quantity: '5', unitPrice: '10' }),
    ];
    expect(() => validateOperations([GGAL], operations)).toThrow(DomainError);
    expect(() =>
      computePortfolio(input({ instruments: [GGAL], operations }), {
        asOf: '2025-02-01',
        reporting: 'ARS',
      }),
    ).toThrow(DomainError);
  });

  it('ignora operaciones posteriores a la fecha de corte', () => {
    const snap = computePortfolio(input({ instruments: [GGAL], operations: ops() }), {
      asOf: '2025-01-31',
      reporting: 'ARS',
    });
    expect(s(snap.positions[0]?.quantity)).toBe('100');
  });
});

describe('dividendos, renta y amortización', () => {
  it('el dividendo es ingreso neto de retenciones y suma al P&L total', () => {
    const KO = inst(1, 'KO', { type: 'CEDEAR', currency: 'USD_MEP' });
    const operations = [
      op({ date: '2025-01-01', type: 'DEPOSIT', amount: '1000', currency: 'USD_MEP' }),
      op({
        date: '2025-01-02',
        type: 'BUY',
        instrumentId: 1,
        quantity: '50',
        unitPrice: '20',
        currency: 'USD_MEP',
      }),
      op({
        date: '2025-04-01',
        type: 'DIVIDEND',
        instrumentId: 1,
        amount: '3',
        taxes: '0.9',
        currency: 'USD_MEP',
      }),
    ];
    const snap = computePortfolio(
      input({ instruments: [KO], operations, prices: [price(1, '2025-04-01', '20', 'USD_MEP')] }),
      { asOf: '2025-04-01', reporting: 'USD' },
    );
    expect(s(snap.positions[0]?.income)).toBe('2.1');
    expect(s(snap.positions[0]?.totalPnl)).toBe('2.1');
    expect(s(snap.summary.totalPnl)).toBe('2.1');
    expect(s(snap.cash[0]?.balance)).toBe('2.1');
  });

  it('bono: precio cada 100 VN, renta = ingreso, amortización = baja de costo', () => {
    const AL30 = inst(1, 'AL30', { type: 'BOND', currency: 'USD_MEP', priceDivisor: dec(100) });
    const operations = [
      op({
        date: '2025-01-02',
        type: 'BUY',
        instrumentId: 1,
        quantity: '1000',
        unitPrice: '80',
        currency: 'USD_MEP',
      }),
      op({
        date: '2025-01-09',
        type: 'COUPON',
        instrumentId: 1,
        amount: '3.75',
        currency: 'USD_MEP',
      }),
      op({
        date: '2025-01-09',
        type: 'AMORTIZATION',
        instrumentId: 1,
        amount: '40',
        currency: 'USD_MEP',
      }),
    ];
    const snap = computePortfolio(
      input({ instruments: [AL30], operations, prices: [price(1, '2025-02-01', '75', 'USD_MEP')] }),
      { asOf: '2025-02-01', reporting: 'USD' },
    );
    const p = snap.positions[0];
    expect(s(p?.quantity)).toBe('1000'); // la amortización no cambia los VN
    expect(s(p?.costBasis)).toBe('760'); // 800 − 40
    expect(s(p?.avgPrice)).toBe('76'); // por 100 VN
    expect(s(p?.income)).toBe('3.75');
    expect(s(p?.amortized)).toBe('40');
    expect(s(p?.marketValue)).toBe('750'); // 1000 × 75 / 100
    expect(s(p?.unrealizedPnl)).toBe('-10');
    expect(s(p?.realizedPnl)).toBe('0');
    expect(s(p?.totalPnl)).toBe('-6.25');
  });

  it('amortización que excede el costo remanente genera realizado', () => {
    const B = inst(1, 'BX', { type: 'BOND', priceDivisor: dec(100) });
    const operations = [
      op({ date: '2025-01-02', type: 'BUY', instrumentId: 1, quantity: '100', unitPrice: '50' }),
      op({ date: '2025-06-01', type: 'AMORTIZATION', instrumentId: 1, amount: '60' }),
    ];
    const p = computePortfolio(input({ instruments: [B], operations }), {
      asOf: '2025-07-01',
      reporting: 'ARS',
    }).positions[0];
    expect(s(p?.costBasis)).toBe('0');
    expect(s(p?.realizedPnl)).toBe('10');
  });
});

describe('conversión de moneda con cotización histórica', () => {
  const YPF = inst(1, 'YPFD');
  const operations = () => [
    op({ date: '2025-01-02', type: 'DEPOSIT', amount: '100000' }),
    op({ date: '2025-01-02', type: 'BUY', instrumentId: 1, quantity: '10', unitPrice: '10000' }),
  ];
  const fxRates = [mep('2025-01-01', '1000'), mep('2025-06-01', '1500')];
  const prices = [price(1, '2025-06-01', '15000')];

  it('en ARS: ganancia nominal en pesos', () => {
    const snap = computePortfolio(
      input({ instruments: [YPF], operations: operations(), fxRates, prices }),
      {
        asOf: '2025-06-01',
        reporting: 'ARS',
      },
    );
    expect(s(snap.positions[0]?.unrealizedPnl)).toBe('50000');
    expect(s(snap.summary.netContributions)).toBe('100000');
  });

  it('en USD: el costo usa el MEP de la compra y la valuación el MEP de hoy', () => {
    const snap = computePortfolio(
      input({ instruments: [YPF], operations: operations(), fxRates, prices }),
      {
        asOf: '2025-06-01',
        reporting: 'USD',
      },
    );
    const p = snap.positions[0];
    expect(s(p?.costBasis)).toBe('100'); // 100000 / 1000
    expect(s(p?.marketValue)).toBe('100'); // 150000 / 1500
    expect(s(p?.unrealizedPnl)).toBe('0'); // la suba en pesos fue sólo devaluación
    expect(s(snap.summary.netContributions)).toBe('100');
  });

  it('CEDEAR comprado en USD MEP visto en ARS usa el MEP de la fecha de compra', () => {
    const AAPL = inst(2, 'AAPL', { type: 'CEDEAR', currency: 'USD_MEP', cedearRatio: dec(20) });
    const ops = [
      op({
        date: '2025-01-02',
        type: 'BUY',
        instrumentId: 2,
        quantity: '10',
        unitPrice: '12',
        currency: 'USD_MEP',
      }),
    ];
    const snap = computePortfolio(
      input({
        instruments: [AAPL],
        operations: ops,
        fxRates,
        prices: [price(2, '2025-06-01', '12', 'USD_MEP')],
      }),
      { asOf: '2025-06-01', reporting: 'ARS' },
    );
    expect(s(snap.positions[0]?.costBasis)).toBe('120000'); // 120 USD × 1000
    expect(s(snap.positions[0]?.marketValue)).toBe('180000'); // 120 USD × 1500
  });

  it('USD cable usa CCL en la vista ARS y 1:1 en la vista USD', () => {
    const X = inst(1, 'X', { currency: 'USD_CCL' });
    const ops = [op({ date: '2025-01-02', type: 'DEPOSIT', amount: '100', currency: 'USD_CCL' })];
    const rates = [mep('2025-01-01', '1000'), ccl('2025-01-01', '1050')];
    const ars = computePortfolio(input({ instruments: [X], operations: ops, fxRates: rates }), {
      asOf: '2025-02-01',
      reporting: 'ARS',
    });
    expect(s(ars.summary.totalValue)).toBe('105000');
    const usd = computePortfolio(input({ instruments: [X], operations: ops, fxRates: rates }), {
      asOf: '2025-02-01',
      reporting: 'USD',
    });
    expect(s(usd.summary.totalValue)).toBe('100');
  });

  it('sin CCL cargado, USD cable cae al MEP con advertencia', () => {
    const ops = [op({ date: '2025-01-02', type: 'DEPOSIT', amount: '100', currency: 'USD_CCL' })];
    const snap = computePortfolio(
      input({ operations: ops, fxRates: [mep('2025-01-01', '1000')] }),
      {
        asOf: '2025-02-01',
        reporting: 'ARS',
      },
    );
    expect(s(snap.summary.totalValue)).toBe('100000');
    expect(snap.warnings.some((w) => w.includes('CCL'))).toBe(true);
  });

  it('si no hay cotización anterior usa la primera posterior y advierte', () => {
    const snap = computePortfolio(
      input({
        operations: [op({ date: '2024-12-01', type: 'DEPOSIT', amount: '1000' })],
        fxRates: [mep('2025-01-01', '1000')],
      }),
      { asOf: '2025-02-01', reporting: 'USD' },
    );
    expect(s(snap.summary.netContributions)).toBe('1');
    expect(snap.warnings.some((w) => w.includes('2024-12-01'))).toBe(true);
  });

  it('sin ninguna cotización MEP falla con un error explícito', () => {
    expect(() =>
      computePortfolio(
        input({ operations: [op({ date: '2025-01-01', type: 'DEPOSIT', amount: '1' })] }),
        {
          asOf: '2025-02-01',
          reporting: 'USD',
        },
      ),
    ).toThrow(MissingFxRateError);
  });

  it('no necesita cotizaciones si todo está en la moneda de reporte', () => {
    const snap = computePortfolio(
      input({ operations: [op({ date: '2025-01-01', type: 'DEPOSIT', amount: '1' })] }),
      {
        asOf: '2025-02-01',
        reporting: 'ARS',
      },
    );
    expect(s(snap.summary.totalValue)).toBe('1');
  });
});

describe('totales del portafolio', () => {
  it('P&L total = realizado + no realizado + ingresos + dif. de cambio de caja − otros gastos', () => {
    const instruments = [
      inst(1, 'GGAL'),
      inst(2, 'AAPL', { type: 'CEDEAR', currency: 'USD_MEP' }),
      inst(3, 'AL30', { type: 'BOND', currency: 'ARS', priceDivisor: dec(100) }),
    ];
    const operations = [
      op({ date: '2025-01-02', type: 'DEPOSIT', amount: '2000000', commission: '100' }),
      op({ date: '2025-01-02', type: 'DEPOSIT', amount: '500', currency: 'USD_MEP' }),
      op({
        date: '2025-01-03',
        type: 'BUY',
        instrumentId: 1,
        quantity: '200',
        unitPrice: '3000',
        commission: '3000',
        marketFees: '50',
        taxes: '630',
      }),
      op({
        date: '2025-01-03',
        type: 'BUY',
        instrumentId: 2,
        quantity: '20',
        unitPrice: '11.5',
        commission: '0.5',
        currency: 'USD_MEP',
      }),
      op({
        date: '2025-01-03',
        type: 'BUY',
        instrumentId: 3,
        quantity: '1000',
        unitPrice: '80000',
        commission: '400',
      }),
      op({
        date: '2025-03-10',
        type: 'SELL',
        instrumentId: 1,
        quantity: '80',
        unitPrice: '3500',
        commission: '1400',
      }),
      op({
        date: '2025-04-01',
        type: 'DIVIDEND',
        instrumentId: 2,
        amount: '1.2',
        taxes: '0.36',
        currency: 'USD_MEP',
      }),
      op({ date: '2025-07-09', type: 'COUPON', instrumentId: 3, amount: '4500' }),
      op({ date: '2025-07-09', type: 'AMORTIZATION', instrumentId: 3, amount: '40000' }),
      op({ date: '2025-08-01', type: 'WITHDRAWAL', amount: '100000', commission: '50' }),
    ];
    const prices = [
      price(1, '2025-09-01', '4100'),
      price(2, '2025-09-01', '13.1', 'USD_MEP'),
      price(3, '2025-09-01', '78000'),
    ];
    const fxRates = [
      mep('2025-01-01', '1180'),
      mep('2025-04-01', '1250'),
      mep('2025-07-01', '1290'),
      mep('2025-09-01', '1340'),
    ];

    for (const reporting of ['ARS', 'USD'] as const) {
      const snap = computePortfolio(input({ instruments, operations, prices, fxRates }), {
        asOf: '2025-09-01',
        reporting,
      });
      const t = snap.summary;
      const rhs = t.realizedPnl
        .plus(t.unrealizedPnl)
        .plus(t.income)
        .plus(t.cashFxResult)
        .minus(t.otherFees);
      expect(t.totalPnl.minus(rhs).abs().lt('1e-20')).toBe(true);
      expect(t.totalValue.minus(t.netContributions).eq(t.totalPnl)).toBe(true);
      // los pesos de la distribución suman 1
      const w = snap.allocationByType.reduce((a, x) => a.plus(x.weight ?? 0), dec(0));
      expect(w.minus(1).abs().lt('1e-20')).toBe(true);
    }
  });

  it('posición sin precio se valúa al costo y advierte', () => {
    const snap = computePortfolio(
      input({
        instruments: [inst(1, 'GGAL')],
        operations: [
          op({ date: '2025-01-02', type: 'BUY', instrumentId: 1, quantity: '1', unitPrice: '100' }),
        ],
      }),
      { asOf: '2025-02-01', reporting: 'ARS' },
    );
    expect(s(snap.positions[0]?.marketValue)).toBe('100');
    expect(snap.warnings[0]).toContain('GGAL');
    expect(snap.warnings.some((w) => w.includes('negativo'))).toBe(true); // compró sin depositar
  });
});

describe('timeline', () => {
  it('sampleDates incluye extremos y respeta el máximo', () => {
    expect(sampleDates('2025-01-01', '2025-01-03', 10)).toEqual([
      '2025-01-01',
      '2025-01-02',
      '2025-01-03',
    ]);
    const many = sampleDates('2024-01-01', '2025-12-31', 50);
    expect(many.length).toBeLessThanOrEqual(51);
    expect(many[0]).toBe('2024-01-01');
    expect(many.at(-1)).toBe('2025-12-31');
  });

  it('evolución escalonada de valor vs aportes', () => {
    const ctx = new PortfolioContext(
      input({
        instruments: [inst(1, 'GGAL')],
        operations: [
          op({ date: '2025-01-01', type: 'DEPOSIT', amount: '1000' }),
          op({
            date: '2025-01-01',
            type: 'BUY',
            instrumentId: 1,
            quantity: '10',
            unitPrice: '100',
          }),
        ],
        prices: [price(1, '2025-01-01', '100'), price(1, '2025-01-03', '120')],
      }),
    );
    const { points } = computeTimeline(ctx, { to: '2025-01-04', reporting: 'ARS' });
    expect(points.map((p) => [p.date, s(p.value), s(p.contributions)])).toEqual([
      ['2025-01-01', '1000', '1000'],
      ['2025-01-02', '1000', '1000'],
      ['2025-01-03', '1200', '1000'],
      ['2025-01-04', '1200', '1000'],
    ]);
  });
});
