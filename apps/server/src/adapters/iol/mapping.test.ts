import { describe, expect, it } from 'vitest';
import type { IolActivity, IolOperation } from './client';
import { mapIolActivities, normalizeSymbol } from './mapping';

let n = 1;
const act = (
  a: Partial<IolActivity> & Pick<IolActivity, 'activity_type' | 'net_amount'>,
): IolActivity => ({
  id: String(n++),
  ticket_id: null,
  account_type: 'CI AR$',
  trade_date: '2025-01-03T00:00:00',
  settlement_date: null,
  qty: 0,
  price: 0,
  currency: 'ARS',
  fees: { commission: 0, vat: 0, other: 0 },
  status: 'completed',
  ...a,
});
const op = (
  ticket: string,
  symbol: string,
  asset_type: string | null,
  description = '',
): IolOperation => ({
  ticket_id: ticket,
  symbol,
  asset_type,
  description,
});

describe('normalizeSymbol', () => {
  it('quita el sufijo D/C sólo en operaciones en dólares', () => {
    expect(normalizeSymbol('AL30D', 'USD', 'BOND')).toEqual({
      ticker: 'AL30',
      currency: 'USD_MEP',
    });
    expect(normalizeSymbol('AL30C', 'USD', 'BOND')).toEqual({
      ticker: 'AL30',
      currency: 'USD_CCL',
    });
    expect(normalizeSymbol('AAPLD', 'USD', 'CEDEAR')).toEqual({
      ticker: 'AAPL',
      currency: 'USD_MEP',
    });
    expect(normalizeSymbol('YPFD', 'ARS', 'STOCK')).toEqual({ ticker: 'YPFD', currency: 'ARS' });
    expect(normalizeSymbol('YMCXD', 'USD', 'ON')).toEqual({ ticker: 'YMCXO', currency: 'USD_MEP' });
  });
});

describe('mapIolActivities', () => {
  it('compra con gastos desglosados y ticker por ticket_id', () => {
    const { operations, unmapped } = mapIolActivities(
      [
        act({
          activity_type: 'Buy',
          ticket_id: 'T1',
          qty: 300,
          price: 6200,
          net_amount: -1872741.0,
          fees: { commission: 9300, vat: 1953, other: 1488 },
        }),
      ],
      [op('T1', 'GGAL', 'stocks', 'Grupo Financiero Galicia')],
    );
    expect(unmapped).toEqual([]);
    expect(operations[0]).toMatchObject({
      type: 'BUY',
      ticker: 'GGAL',
      date: '2025-01-03',
      quantity: '300',
      unitPrice: '6200',
      currency: 'ARS',
      commission: '9300',
      taxes: '1953',
      marketFees: '1488',
      instrument: { type: 'STOCK', priceDivisor: '1', name: 'Grupo Financiero Galicia' },
    });
    expect(operations[0]?.externalId).toMatch(/^iol:/);
  });

  it('dólar MEP: compra AL30 en pesos y venta AL30D en dólares afectan la misma posición', () => {
    const { operations } = mapIolActivities(
      [
        act({ activity_type: 'Buy', ticket_id: 'A', qty: 1000, price: 85000, net_amount: -850000 }),
        act({
          activity_type: 'Sell',
          ticket_id: 'B',
          qty: 1000,
          price: 60.5,
          currency: 'USD',
          net_amount: 605,
          trade_date: '2025-01-04',
        }),
      ],
      [op('A', 'AL30', 'government_bonds'), op('B', 'AL30D', 'government_bonds')],
    );
    expect(
      operations.map((o) => [o.type, o.ticker, o.currency, o.instrument?.priceDivisor]),
    ).toEqual([
      ['BUY', 'AL30', 'ARS', '100'],
      ['SELL', 'AL30', 'USD_MEP', '100'],
    ]);
  });

  it('detecta divisor 100 por el monto aunque el tipo de asset no venga', () => {
    const { operations } = mapIolActivities(
      [act({ activity_type: 'Buy', ticket_id: 'X', qty: 2000, price: 101.2, net_amount: -2024 })],
      [op('X', 'YMCXD', null)],
    );
    expect(operations[0]?.instrument?.priceDivisor).toBe('100');
  });

  it('renta y amortización: monto bruto = neto + retenciones', () => {
    const { operations } = mapIolActivities(
      [
        act({ activity_type: 'Rent Payment', ticket_id: 'R', currency: 'USD', net_amount: 5.4 }),
        act({
          activity_type: 'Dividend Payment',
          ticket_id: 'D',
          currency: 'USD',
          net_amount: 0.35,
          fees: { commission: 0, vat: 0, other: 0.15 },
        }),
        act({
          activity_type: 'Amortization Payment',
          ticket_id: 'M',
          currency: 'USD',
          net_amount: 60,
        }),
      ],
      [
        op('R', 'AL30D', 'government_bonds'),
        op('D', 'AAPLD', 'cedears'),
        op('M', 'AL30D', 'government_bonds'),
      ],
    );
    expect(operations.map((o) => [o.type, o.ticker, o.amount, o.marketFees, o.currency])).toEqual([
      ['COUPON', 'AL30', '5.4', '0', 'USD_MEP'],
      ['DIVIDEND', 'AAPL', '0.5', '0.15', 'USD_MEP'],
      ['AMORTIZATION', 'AL30', '60', '0', 'USD_MEP'],
    ]);
  });

  it('depósitos y extracciones respetan el neto de caja', () => {
    const { operations } = mapIolActivities(
      [
        act({ activity_type: 'Deposit', net_amount: 1000000 }),
        act({
          activity_type: 'Withdrawal',
          net_amount: -200,
          currency: 'USD',
          fees: { commission: 0, vat: 0, other: 2 },
        }),
      ],
      [],
    );
    expect(operations.map((o) => [o.type, o.amount, o.currency])).toEqual([
      ['DEPOSIT', '1000000', 'ARS'],
      ['WITHDRAWAL', '198', 'USD_MEP'],
    ]);
  });

  it('caución: apertura y liquidación se emparejan FIFO y el interés queda como precio', () => {
    const { operations, unmapped } = mapIolActivities(
      [
        act({ activity_type: 'Collateral', net_amount: -500000, trade_date: '2025-08-01' }),
        act({
          activity_type: 'Collateral Liquidation',
          net_amount: 503452.05,
          trade_date: '2025-08-08',
        }),
        act({ activity_type: 'Collateral Liquidation', net_amount: 10, trade_date: '2025-08-09' }),
      ],
      [],
    );
    expect(operations.map((o) => [o.type, o.ticker, o.quantity, o.unitPrice])).toEqual([
      ['BUY', 'CAUCION', '500000', '1'],
      ['SELL', 'CAUCION', '500000', '1.0069041'],
    ]);
    expect(unmapped[0]?.reason).toMatch(/sin apertura/);
  });

  it('FCI: suscripción y rescate como compra/venta de cuotapartes', () => {
    const { operations } = mapIolActivities(
      [
        act({
          activity_type: 'Mutual Fund (FCI) Subscription',
          ticket_id: 'F',
          qty: 20000,
          price: 24.5,
          net_amount: -490000,
        }),
      ],
      [op('F', 'IOLCAMA', null)],
    );
    expect(operations[0]).toMatchObject({
      type: 'BUY',
      ticker: 'IOLCAMA',
      instrument: { type: 'FCI' },
    });
  });

  it('reporta lo que no puede mapear sin inventar y descarta no completadas', () => {
    const { operations, unmapped } = mapIolActivities(
      [
        act({ activity_type: 'Balance Remuneration', net_amount: 120 }),
        act({ activity_type: 'Buy', ticket_id: 'SIN-OP', qty: 1, price: 1, net_amount: -1 }),
        act({ activity_type: 'Something New', net_amount: 1 }),
        act({ activity_type: 'Deposit', net_amount: 1, status: 'pending' }),
      ],
      [],
    );
    expect(operations).toEqual([]);
    expect(unmapped.map((u) => u.reason)).toEqual([
      expect.stringMatching(/Remuneración de saldos/),
      expect.stringMatching(/ticker/),
      expect.stringMatching(/no soportado/),
    ]);
  });
});
