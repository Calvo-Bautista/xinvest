import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Empty, ErrorBox, Loading, PageHeader, Warnings } from '../components/ui';
import { api, type Position, unwrap } from '../lib/api';
import { useReportingCurrency } from '../lib/currency';
import {
  CURRENCY_LABELS,
  fmtDate,
  fmtMoney,
  fmtNum,
  fmtPct,
  INSTRUMENT_LABELS,
  pnlClass,
} from '../lib/format';

export const usePortfolio = () => {
  const { currency } = useReportingCurrency();
  return useQuery({
    queryKey: ['portfolio', currency],
    queryFn: () => unwrap(api.portfolio.$get({ query: { currency } })),
  });
};

export function PositionsPage() {
  const { currency } = useReportingCurrency();
  const q = usePortfolio();
  const [showClosed, setShowClosed] = useState(false);

  return (
    <>
      <PageHeader
        title="Posiciones"
        subtitle={`Derivadas de las operaciones · valores en ${currency === 'ARS' ? 'pesos' : 'dólares MEP'}`}
        actions={
          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            Mostrar cerradas
          </label>
        }
      />
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <Warnings items={q.data.warnings} />
          <PositionsTable
            positions={q.data.positions.filter((p) => showClosed || p.open)}
            currency={currency}
          />
          {q.data.cash.length > 0 && (
            <div className="card mt-4 overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Efectivo</th>
                    <th className="text-right">Saldo</th>
                    <th className="text-right">Valor ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.cash.map((c) => (
                    <tr key={c.currency}>
                      <td>{CURRENCY_LABELS[c.currency]}</td>
                      <td className="num text-right">{fmtMoney(c.balance, c.currency)}</td>
                      <td className="num text-right">{fmtMoney(c.value, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-zinc-500">
            PPP = precio promedio ponderado, incluye gastos. En USD, el costo usa el MEP de la fecha
            de cada operación y la valuación el MEP vigente; por eso el P&L en USD aísla la
            devaluación.
          </p>
        </>
      )}
    </>
  );
}

export function PositionsTable({
  positions,
  currency,
}: {
  positions: Position[];
  currency: 'ARS' | 'USD';
}) {
  if (positions.length === 0) {
    return (
      <div className="card">
        <Empty>No hay posiciones.</Empty>
      </div>
    );
  }
  return (
    <div className="card overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Activo</th>
            <th className="text-right">Cantidad</th>
            <th className="text-right">PPP</th>
            <th className="text-right">Precio</th>
            <th className="text-right">Valuación</th>
            <th className="text-right">No realizado</th>
            <th className="text-right">Realizado</th>
            <th className="text-right">Rentas / div.</th>
            <th className="text-right">P&L total</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.instrumentId} className={p.open ? '' : 'opacity-60'}>
              <td>
                <div className="font-medium">{p.ticker}</div>
                <div className="text-xs text-zinc-500">{INSTRUMENT_LABELS[p.type]}</div>
              </td>
              <td className="num text-right">{fmtNum(p.quantity)}</td>
              <td className="num text-right">{fmtMoney(p.avgPrice, currency)}</td>
              <td
                className="num text-right"
                title={p.priceDate ? `Precio del ${fmtDate(p.priceDate)}` : 'Sin precio'}
              >
                {fmtMoney(p.price, currency)}
                {p.priceDate && <div className="text-xs text-zinc-500">{fmtDate(p.priceDate)}</div>}
              </td>
              <td className="num text-right font-medium">{fmtMoney(p.marketValue, currency)}</td>
              <td className={`num text-right ${pnlClass(p.unrealizedPnl)}`}>
                {fmtMoney(p.unrealizedPnl, currency)}
                <div className="text-xs">{fmtPct(p.unrealizedPct)}</div>
              </td>
              <td className={`num text-right ${pnlClass(p.realizedPnl)}`}>
                {fmtMoney(p.realizedPnl, currency)}
                <div className="text-xs">{fmtPct(p.realizedPct)}</div>
              </td>
              <td className={`num text-right ${pnlClass(p.income)}`}>
                {fmtMoney(p.income, currency)}
              </td>
              <td className={`num text-right font-medium ${pnlClass(p.totalPnl)}`}>
                {fmtMoney(p.totalPnl, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
