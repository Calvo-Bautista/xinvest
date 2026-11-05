import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';
import { useState } from 'react';
import { Empty, ErrorBox, Field, Loading, PageHeader, Warnings } from '../components/ui';
import { api, unwrap } from '../lib/api';
import { fmtDate, fmtMoney, fmtNum, OPERATION_LABELS, todayISO } from '../lib/format';

type Report = InferResponseType<(typeof api.iol.sync)['operations']['$post'], 200>;
type PricesReport = InferResponseType<(typeof api.iol.sync)['prices']['$post'], 200>;

const fmtDateTime = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' }).format(
        new Date(iso),
      )
    : 'nunca';

export function IolPage() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['iol-status'],
    queryFn: () => unwrap(api.iol.status.$get()),
  });

  const connect = useMutation({
    mutationFn: () => unwrap(api.iol.connect.$post()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['iol-status'] }),
  });
  const disconnect = useMutation({
    mutationFn: () => unwrap(api.iol.disconnect.$post()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['iol-status'] }),
  });

  if (status.isPending) return <Loading />;
  if (status.error) return <ErrorBox error={status.error} />;
  const s = status.data;

  return (
    <>
      <PageHeader
        title="InvertirOnline"
        subtitle="Sincronizá operaciones y precios desde la API oficial de IOL."
      />
      {!s.configured ? (
        <div className="card p-5 text-sm">
          <p className="mb-2 font-medium">IOL no está configurado.</p>
          <p className="text-zinc-600 dark:text-zinc-400">
            Definí <code>IOL_USERNAME</code> e <code>IOL_PASSWORD</code> como variables de entorno
            (en <code>.env</code> local o en Vercel) y reiniciá/redeployá. La contraseña nunca pasa
            por el navegador ni se guarda en la base: sólo se guardan los tokens de sesión,
            cifrados.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <section className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <div className="space-y-0.5">
              <div>
                <span className="text-zinc-500">Sesión: </span>
                {s.session ? (
                  <span>activa (renovable hasta {fmtDateTime(s.session.refreshValidUntil)})</span>
                ) : (
                  <span>sin conectar todavía</span>
                )}
              </div>
              <div className="text-zinc-500">
                Última sync de operaciones: {fmtDateTime(s.lastOperationsSyncAt)}
                {s.lastOperationsSyncTo && ` (hasta ${fmtDate(s.lastOperationsSyncTo)})`} · de
                precios: {fmtDateTime(s.lastPricesSyncAt)}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost border border-zinc-200 dark:border-zinc-700"
                disabled={connect.isPending}
                onClick={() => connect.mutate()}
              >
                {connect.isPending ? 'Probando…' : 'Probar conexión'}
              </button>
              {s.session && (
                <button type="button" className="btn-danger" onClick={() => disconnect.mutate()}>
                  Desconectar
                </button>
              )}
            </div>
            <div className="w-full">
              <ErrorBox error={connect.error ?? disconnect.error} />
              {connect.isSuccess && (
                <p className="text-emerald-700 dark:text-emerald-400">Conexión OK.</p>
              )}
            </div>
          </section>

          <OperationsSync defaultFrom={s.defaultFrom} />
          <PricesSync />
        </div>
      )}
    </>
  );
}

function OperationsSync({ defaultFrom }: { defaultFrom: string | null }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(defaultFrom ?? '');
  const [to, setTo] = useState(todayISO());
  const [report, setReport] = useState<Report | null>(null);

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      unwrap(api.iol.sync.operations.$post({ json: { from: from || undefined, to, dryRun } })),
    onSuccess: (r) => {
      setReport(r);
      if (r.applied) qc.invalidateQueries();
    },
  });

  return (
    <section className="card p-4">
      <h2 className="font-semibold">Operaciones</h2>
      <p className="mb-3 text-sm text-zinc-500">
        Primero previsualizá. Lo ya importado se saltea; lo que ya cargaste a mano se <b>vincula</b>{' '}
        (no se duplica). Si la historia queda inconsistente — por ejemplo una venta de algo comprado
        antes del rango — no se importa nada.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate(true);
        }}
      >
        <Field
          label="Desde"
          hint={defaultFrom ? undefined : 'Primera vez: idealmente la apertura de tu cuenta.'}
        >
          <input
            type="date"
            className="input"
            required={!defaultFrom}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="Hasta">
          <input
            type="date"
            className="input"
            required
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <button
          type="submit"
          className="btn-ghost border border-zinc-200 dark:border-zinc-700"
          disabled={run.isPending}
        >
          {run.isPending && run.variables ? 'Consultando IOL…' : 'Previsualizar'}
        </button>
        {report && !report.applied && report.counts.new + report.counts.linked > 0 && (
          <button
            type="button"
            className="btn-primary"
            disabled={run.isPending || !!report.validationError}
            onClick={() => run.mutate(false)}
          >
            Importar {report.counts.new} nuevas
            {report.counts.linked ? ` y vincular ${report.counts.linked}` : ''}
          </button>
        )}
      </form>
      <div className="mt-3">
        <ErrorBox error={run.error} />
      </div>
      {report && <ReportView report={report} />}
    </section>
  );
}

const STATUS_LABEL = { new: 'Nueva', linked: 'Vincula manual', existing: 'Ya importada' } as const;
const STATUS_CLASS = {
  new: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  linked: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  existing: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
} as const;

function ReportView({ report }: { report: Report }) {
  const [showExisting, setShowExisting] = useState(false);
  const rows = report.rows.filter((r) => showExisting || r.status !== 'existing');
  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {report.applied ? (
          <span className="font-medium text-emerald-700 dark:text-emerald-400">✓ Importado</span>
        ) : (
          <span className="font-medium">Previsualización</span>
        )}
        <span>{report.counts.new} nuevas</span>
        <span>{report.counts.linked} a vincular</span>
        <span className="text-zinc-500">{report.counts.existing} ya importadas</span>
        <span className="text-zinc-500">{report.counts.unmapped} sin mapear</span>
        <label className="ml-auto flex items-center gap-1.5 text-zinc-500">
          <input
            type="checkbox"
            checked={showExisting}
            onChange={(e) => setShowExisting(e.target.checked)}
          />
          ver ya importadas
        </label>
      </div>
      {report.validationError && <ErrorBox error={report.validationError} />}
      {report.newInstruments.length > 0 && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Instrumentos nuevos:{' '}
          {report.newInstruments
            .map((i) => `${i.ticker} (${i.type}${i.priceDivisor === '100' ? ', c/100 VN' : ''})`)
            .join(', ')}
        </p>
      )}
      {rows.length === 0 ? (
        <Empty>No hay movimientos nuevos en el rango.</Empty>
      ) : (
        <div className="max-h-[420px] overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="table">
            <thead>
              <tr>
                <th>Estado</th>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Ticker</th>
                <th className="text-right">Cantidad</th>
                <th className="text-right">Precio</th>
                <th className="text-right">Monto</th>
                <th className="text-right">Gastos</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.externalId}>
                  <td>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_CLASS[r.status]}`}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="num">{fmtDate(r.date)}</td>
                  <td>{OPERATION_LABELS[r.type]}</td>
                  <td className="font-medium">{r.ticker ?? '—'}</td>
                  <td className="num text-right">{fmtNum(r.quantity)}</td>
                  <td className="num text-right">
                    {r.unitPrice ? fmtMoney(r.unitPrice, r.currency) : '—'}
                  </td>
                  <td className="num text-right">
                    {r.amount ? fmtMoney(r.amount, r.currency) : '—'}
                  </td>
                  <td className="num text-right text-zinc-500">
                    {Number(r.fees) ? fmtMoney(r.fees, r.currency) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report.unmapped.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-medium">
            Movimientos que no se importan (revisalos y cargalos a mano si corresponde)
          </h3>
          <ul className="space-y-1 text-sm">
            {report.unmapped.map((u) => (
              <li key={u.externalId} className="text-zinc-600 dark:text-zinc-400">
                <span className="num">{fmtDate(u.date)}</span> · {u.activityType} · {u.currency}{' '}
                {fmtNum(u.netAmount, 2)} — {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PricesSync() {
  const qc = useQueryClient();
  const [report, setReport] = useState<PricesReport | null>(null);
  const run = useMutation({
    mutationFn: () => unwrap(api.iol.sync.prices.$post({ json: {} })),
    onSuccess: (r) => {
      setReport(r);
      qc.invalidateQueries();
    },
  });
  const failures = report?.instruments.filter((i) => i.error) ?? [];
  return (
    <section className="card p-4">
      <h2 className="font-semibold">Precios y dólar</h2>
      <p className="mb-3 text-sm text-zinc-500">
        Trae el cierre diario de cada instrumento que operaste y calcula el{' '}
        <b>dólar MEP implícito</b> = AL30 (en pesos) ÷ AL30D (en dólares), y el CCL con AL30C. Si
        cargaste un precio a mano para el mismo día, gana el tuyo.
      </p>
      <button
        type="button"
        className="btn-primary"
        disabled={run.isPending}
        onClick={() => run.mutate()}
      >
        {run.isPending ? 'Actualizando…' : 'Actualizar precios y dólar'}
      </button>
      <div className="mt-3 space-y-2 text-sm">
        <ErrorBox error={run.error} />
        {report && (
          <>
            <p>
              {fmtDate(report.from)} → {fmtDate(report.to)}:{' '}
              {report.instruments
                .filter((i) => !i.error)
                .map((i) => `${i.ticker} (${i.points})`)
                .join(', ') || 'sin instrumentos'}
              . Dólar: {report.fx.mep} MEP, {report.fx.ccl} CCL.
            </p>
            <Warnings
              items={[
                ...failures.map(
                  (f) => `${f.ticker}${f.symbol !== '—' ? ` (${f.symbol})` : ''}: ${f.error}`,
                ),
                ...(report.fx.error ? [`Dólar implícito: ${report.fx.error}`] : []),
              ]}
            />
          </>
        )}
      </div>
    </section>
  );
}
