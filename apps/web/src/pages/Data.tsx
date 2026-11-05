import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorBox, Field, PageHeader } from '../components/ui';
import { ApiError, UNAUTHORIZED_EVENT } from '../lib/api';

const ENTITIES = [
  {
    key: 'instruments',
    label: 'Instrumentos',
    help: 'ticker, name, type, currency, price_divisor, cedear_ratio, notes',
  },
  {
    key: 'operations',
    label: 'Operaciones',
    help: 'date, type, ticker, quantity, unit_price, amount, currency, commission, market_fees, taxes, notes, external_id',
  },
  { key: 'prices', label: 'Precios', help: 'ticker, date, price, currency, source' },
  { key: 'fx_rates', label: 'Cotizaciones', help: 'date, pair, rate, source' },
] as const;
type Entity = (typeof ENTITIES)[number]['key'];

interface ImportError {
  error: string;
  issues?: string[];
}

export function DataPage() {
  const qc = useQueryClient();
  const [entity, setEntity] = useState<Entity>('operations');
  const [file, setFile] = useState<File | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Elegí un archivo');
      setIssues([]);
      const res = await fetch(`/api/csv/${entity}`, { method: 'POST', body: await file.text() });
      const body = (await res.json()) as
        | ImportError
        | { inserted: number; updated: number; skipped: number };
      if (!res.ok) {
        if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        const e = body as ImportError;
        setIssues(e.issues?.map(String) ?? []);
        throw new ApiError(e.error, res.status);
      }
      return body as { inserted: number; updated: number; skipped: number };
    },
    onSuccess: () => qc.invalidateQueries(),
  });

  return (
    <>
      <PageHeader title="Datos" subtitle="Backup e importación en CSV." />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="font-semibold">Exportar</h2>
          <p className="mb-3 text-sm text-zinc-500">
            Para un backup completo descargá los cuatro archivos. Montos con punto decimal, fechas
            YYYY-MM-DD.
          </p>
          <div className="flex flex-wrap gap-2">
            {ENTITIES.map((e) => (
              <a
                key={e.key}
                className="btn-ghost border border-zinc-200 dark:border-zinc-700"
                href={`/api/csv/${e.key}`}
                download
              >
                ⤓ {e.label}
              </a>
            ))}
          </div>
        </section>

        <section className="card p-4">
          <h2 className="font-semibold">Importar</h2>
          <p className="mb-3 text-sm text-zinc-500">
            Orden para restaurar: instrumentos → operaciones → precios → cotizaciones. Se valida
            todo antes de escribir: si una fila falla no se importa nada. Las operaciones duplicadas
            se saltean. Acepta separador
            <code className="mx-1">;</code>y decimales con coma (Excel).
          </p>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              upload.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Tipo de archivo">
                <select
                  className="input"
                  value={entity}
                  onChange={(e) => setEntity(e.target.value as Entity)}
                >
                  {ENTITIES.map((e) => (
                    <option key={e.key} value={e.key}>
                      {e.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Archivo CSV">
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="input py-1"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </Field>
            </div>
            <p className="text-xs text-zinc-500">
              Columnas:{' '}
              <span className="font-mono">{ENTITIES.find((e) => e.key === entity)?.help}</span>
            </p>
            <button type="submit" className="btn-primary" disabled={!file || upload.isPending}>
              {upload.isPending ? 'Importando…' : 'Importar'}
            </button>
          </form>
          <div className="mt-3 space-y-2">
            <ErrorBox error={upload.error} />
            {issues.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-red-700 dark:text-red-400">
                {issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
            {upload.data && (
              <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                Listo: {upload.data.inserted} nuevos, {upload.data.updated} actualizados,{' '}
                {upload.data.skipped} salteados.
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
