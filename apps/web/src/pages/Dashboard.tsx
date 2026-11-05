import { useQuery } from '@tanstack/react-query';
import type { ReportingCurrency } from '@xinvest/domain';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Empty, ErrorBox, Loading, PageHeader, Segmented, Warnings } from '../components/ui';
import { api, type Snapshot, unwrap } from '../lib/api';
import { useReportingCurrency } from '../lib/currency';
import { fmtCompact, fmtDate, fmtMoney, fmtPct, pnlClass } from '../lib/format';
import { usePortfolio } from './Positions';

export function DashboardPage() {
  const { currency } = useReportingCurrency();
  const snap = usePortfolio();

  return (
    <>
      <PageHeader
        title="Resumen"
        subtitle={
          snap.data
            ? `Al ${fmtDate(snap.data.asOf)} · en ${currency === 'ARS' ? 'pesos' : 'dólares MEP'}`
            : undefined
        }
      />
      {snap.isPending ? (
        <Loading />
      ) : snap.error ? (
        <ErrorBox error={snap.error} />
      ) : snap.data.positions.length === 0 && snap.data.cash.length === 0 ? (
        <div className="card">
          <Empty>
            Todavía no hay operaciones. Empezá por{' '}
            <Link className="text-brand-700 underline" to="/instrumentos">
              crear un instrumento
            </Link>{' '}
            y{' '}
            <Link className="text-brand-700 underline" to="/operaciones">
              cargar operaciones
            </Link>
            .
          </Empty>
        </div>
      ) : (
        <div className="space-y-6">
          <Warnings items={snap.data.warnings} />
          <Kpis s={snap.data.summary} currency={currency} />
          <EvolutionChart currency={currency} />
          <div className="grid gap-6 lg:grid-cols-2">
            <AllocationBars
              title="Por tipo de instrumento"
              slices={snap.data.allocationByType}
              currency={currency}
            />
            <AllocationBars
              title="Por activo"
              slices={snap.data.allocationByInstrument}
              currency={currency}
              max={10}
            />
          </div>
        </div>
      )}
    </>
  );
}

function Kpis({ s, currency }: { s: Snapshot['summary']; currency: ReportingCurrency }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Tile label="Valor total" value={fmtMoney(s.totalValue, currency)}>
        Posiciones {fmtCompact(s.positionsValue, currency)} · Efectivo{' '}
        {fmtCompact(s.cashValue, currency)}
      </Tile>
      <Tile label="Capital neto aportado" value={fmtMoney(s.netContributions, currency)}>
        Depósitos − retiros, a la cotización de cada fecha
      </Tile>
      <Tile
        label="P&L total"
        value={fmtMoney(s.totalPnl, currency)}
        valueClass={pnlClass(s.totalPnl)}
        badge={fmtPct(s.totalPnlPct)}
      >
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
          <Breakdown label="No realizado" v={s.unrealizedPnl} currency={currency} />
          <Breakdown label="Realizado" v={s.realizedPnl} currency={currency} />
          <Breakdown label="Rentas y div." v={s.income} currency={currency} />
          <Breakdown label="Dif. cambio caja" v={s.cashFxResult} currency={currency} />
        </dl>
      </Tile>
    </div>
  );
}

function Tile({
  label,
  value,
  valueClass = '',
  badge,
  children,
}: {
  label: string;
  value: string;
  valueClass?: string;
  badge?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`num text-2xl font-semibold tracking-tight ${valueClass}`}>{value}</span>
        {badge && <span className={`num text-sm font-medium ${valueClass}`}>{badge}</span>}
      </div>
      <div className="mt-1 text-xs text-zinc-500">{children}</div>
    </div>
  );
}

function Breakdown({
  label,
  v,
  currency,
}: {
  label: string;
  v: string;
  currency: ReportingCurrency;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={`num text-right ${pnlClass(v)}`}>{fmtCompact(v, currency)}</dd>
    </>
  );
}

const RANGES = [
  { value: '6m', label: '6M', months: 6 },
  { value: '1y', label: '1A', months: 12 },
  { value: 'all', label: 'Todo', months: 0 },
] as const;
type Range = (typeof RANGES)[number]['value'];

function EvolutionChart({ currency }: { currency: ReportingCurrency }) {
  const [range, setRange] = useState<Range>('all');
  const tl = useQuery({
    queryKey: ['timeline', currency],
    queryFn: () => unwrap(api.portfolio.timeline.$get({ query: { currency } })),
  });

  const months = RANGES.find((r) => r.value === range)?.months ?? 0;
  const cutoff = months
    ? new Date(Date.now() - months * 30.44 * 86400_000).toISOString().slice(0, 10)
    : '';
  const data = (tl.data?.points ?? [])
    .filter((p) => p.date >= cutoff)
    .map((p) => ({ date: p.date, value: Number(p.value), contributions: Number(p.contributions) }));

  return (
    <section className="card viz p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Valor del portafolio vs. capital aportado</h2>
          <div className="mt-1 flex gap-4 text-xs text-zinc-600 dark:text-zinc-400">
            <LegendItem color="var(--series-1)" label="Valor" />
            <LegendItem color="var(--series-2)" label="Capital aportado" dashed />
          </div>
        </div>
        <Segmented
          value={range}
          onChange={setRange}
          options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
        />
      </div>
      {tl.isPending ? (
        <Loading />
      ) : tl.error ? (
        <ErrorBox error={tl.error} />
      ) : data.length < 2 ? (
        <Empty>Hace falta más historia para graficar.</Empty>
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis
                dataKey="date"
                tickFormatter={(d: string) => `${d.slice(5, 7)}/${d.slice(2, 4)}`}
                tick={{ fill: 'var(--axis)', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                tickFormatter={(v: number) => fmtCompact(v, currency)}
                tick={{ fill: 'var(--axis)', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={72}
              />
              <Tooltip
                cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900">
                      <div className="mb-1 font-medium">{fmtDate(String(label))}</div>
                      {payload.map((p) => (
                        <div
                          key={String(p.dataKey)}
                          className="flex items-center justify-between gap-4"
                        >
                          <LegendItem
                            color={p.dataKey === 'value' ? 'var(--series-1)' : 'var(--series-2)'}
                            label={p.dataKey === 'value' ? 'Valor' : 'Aportado'}
                            dashed={p.dataKey !== 'value'}
                          />
                          <span className="num">{fmtMoney(Number(p.value), currency, 0)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null
                }
              />
              <Line
                type="stepAfter"
                dataKey="contributions"
                stroke="var(--series-2)"
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey="value"
                stroke="var(--series-1)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {tl.data && tl.data.warnings.length > 0 && <Warnings items={tl.data.warnings} />}
    </section>
  );
}

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="16" height="8" aria-hidden="true">
        <line
          x1="0"
          y1="4"
          x2="16"
          y2="4"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dashed ? '4 3' : undefined}
        />
      </svg>
      {label}
    </span>
  );
}

/** Barras horizontales de un solo tono: comparar magnitudes, no hace falta leyenda. */
function AllocationBars({
  title,
  slices,
  currency,
  max = 99,
}: {
  title: string;
  slices: Snapshot['allocationByType'];
  currency: ReportingCurrency;
  max?: number;
}) {
  const sorted = slices.filter((s) => Number(s.value) > 0);
  let rows = sorted.slice(0, max);
  if (sorted.length > max) {
    const rest = sorted.slice(max);
    rows = [
      ...rows,
      {
        key: 'OTHER',
        label: `Otros (${rest.length})`,
        value: String(rest.reduce((a, s) => a + Number(s.value), 0)),
        weight: String(rest.reduce((a, s) => a + Number(s.weight ?? 0), 0)),
      },
    ];
  }
  const top = Math.max(...rows.map((r) => Number(r.weight ?? 0)), 0.0001);

  return (
    <section className="card viz p-4">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <Empty>Sin datos.</Empty>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r) => {
            const w = Number(r.weight ?? 0);
            return (
              <li
                key={r.key}
                className="group grid grid-cols-[7.5rem_1fr_3.5rem] items-center gap-3 text-sm"
                title={`${r.label}: ${fmtMoney(r.value, currency)} (${fmtPct(w, false)})`}
              >
                <span className="truncate text-zinc-700 dark:text-zinc-300">{r.label}</span>
                <span className="h-3 rounded-r-[4px] bg-[var(--track)]">
                  <span
                    className="block h-full rounded-r-[4px] bg-[var(--series-1)] transition-opacity group-hover:opacity-80"
                    style={{ width: `${Math.max((w / top) * 100, 1)}%` }}
                  />
                </span>
                <span className="num text-right text-zinc-600 dark:text-zinc-400">
                  {fmtPct(w, false)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
