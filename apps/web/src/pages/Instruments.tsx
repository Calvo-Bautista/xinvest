import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CURRENCIES, type Currency, INSTRUMENT_TYPES, type InstrumentType } from '@xinvest/domain';
import { useState } from 'react';
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader } from '../components/ui';
import { api, type Instrument, unwrap } from '../lib/api';
import { CURRENCY_LABELS, fmtNum, INSTRUMENT_LABELS, normalizeDecimal } from '../lib/format';

export const useInstruments = () =>
  useQuery({ queryKey: ['instruments'], queryFn: () => unwrap(api.instruments.$get()) });

interface FormState {
  ticker: string;
  name: string;
  type: InstrumentType;
  currency: Currency;
  priceDivisor: string;
  cedearRatio: string;
  notes: string;
}

const empty: FormState = {
  ticker: '',
  name: '',
  type: 'STOCK',
  currency: 'ARS',
  priceDivisor: '',
  cedearRatio: '',
  notes: '',
};

export function InstrumentsPage() {
  const qc = useQueryClient();
  const list = useInstruments();
  const [editing, setEditing] = useState<Instrument | 'new' | null>(null);

  const remove = useMutation({
    mutationFn: (id: number) =>
      unwrap(api.instruments[':id'].$delete({ param: { id: String(id) } })),
    onSuccess: () => qc.invalidateQueries(),
  });

  return (
    <>
      <PageHeader
        title="Instrumentos"
        subtitle="Activos que operás. Definen tipo, moneda de cotización y divisor de precio."
        actions={
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
            + Nuevo instrumento
          </button>
        }
      />
      <ErrorBox error={remove.error} />
      <div className="card overflow-x-auto">
        {list.isPending ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} />
        ) : list.data.length === 0 ? (
          <Empty>Todavía no hay instrumentos.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Cotiza en</th>
                <th className="text-right">Divisor</th>
                <th className="text-right">Ratio CEDEAR</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((i) => (
                <tr key={i.id}>
                  <td className="font-medium">{i.ticker}</td>
                  <td className="text-zinc-500">{i.name}</td>
                  <td>{INSTRUMENT_LABELS[i.type]}</td>
                  <td>{CURRENCY_LABELS[i.currency]}</td>
                  <td className="num text-right">{fmtNum(i.priceDivisor)}</td>
                  <td className="num text-right">
                    {i.cedearRatio ? `${fmtNum(i.cedearRatio)}:1` : '—'}
                  </td>
                  <td className="text-right">
                    <button type="button" className="btn-ghost" onClick={() => setEditing(i)}>
                      Editar
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => confirm(`¿Borrar ${i.ticker}?`) && remove.mutate(i.id)}
                    >
                      Borrar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Nuevo instrumento' : 'Editar instrumento'}
      >
        {editing != null && (
          <InstrumentForm
            initial={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Modal>
    </>
  );
}

export function InstrumentForm({
  initial,
  onDone,
  defaultTicker,
}: {
  initial: Instrument | null;
  onDone: (created?: Instrument) => void;
  defaultTicker?: string;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(
    initial
      ? {
          ticker: initial.ticker,
          name: initial.name ?? '',
          type: initial.type,
          currency: initial.currency,
          priceDivisor: initial.priceDivisor,
          cedearRatio: initial.cedearRatio ?? '',
          notes: initial.notes ?? '',
        }
      : { ...empty, ticker: defaultTicker ?? '' },
  );
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      const json = {
        ticker: f.ticker,
        name: f.name || null,
        type: f.type,
        currency: f.currency,
        priceDivisor: f.priceDivisor ? normalizeDecimal(f.priceDivisor) : undefined,
        cedearRatio: f.type === 'CEDEAR' && f.cedearRatio ? normalizeDecimal(f.cedearRatio) : null,
        notes: f.notes || null,
      };
      return initial
        ? unwrap(api.instruments[':id'].$put({ param: { id: String(initial.id) }, json }))
        : unwrap(api.instruments.$post({ json }));
    },
    onSuccess: (row) => {
      qc.invalidateQueries();
      onDone(row as Instrument);
    },
  });

  const isBond = f.type === 'BOND' || f.type === 'ON';

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ticker">
          <input
            className="input uppercase"
            required
            value={f.ticker}
            onChange={(e) => set('ticker', e.target.value)}
          />
        </Field>
        <Field label="Nombre">
          <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Tipo">
          <select
            className="input"
            value={f.type}
            onChange={(e) => set('type', e.target.value as InstrumentType)}
          >
            {INSTRUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {INSTRUMENT_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Moneda de cotización" hint="En qué moneda vas a cargar sus precios.">
          <select
            className="input"
            value={f.currency}
            onChange={(e) => set('currency', e.target.value as Currency)}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {CURRENCY_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Divisor de precio"
          hint={isBond ? 'Bonos y ONs cotizan cada 100 VN → 100 (default).' : 'Default 1.'}
        >
          <input
            className="input num"
            inputMode="decimal"
            placeholder={isBond ? '100' : '1'}
            value={f.priceDivisor}
            onChange={(e) => set('priceDivisor', e.target.value)}
          />
        </Field>
        {f.type === 'CEDEAR' && (
          <Field label="Ratio CEDEAR" hint="CEDEARs por acción subyacente (ej. 20). Informativo.">
            <input
              className="input num"
              inputMode="decimal"
              value={f.cedearRatio}
              onChange={(e) => set('cedearRatio', e.target.value)}
            />
          </Field>
        )}
      </div>
      <Field label="Notas">
        <textarea
          className="input"
          rows={2}
          value={f.notes}
          onChange={(e) => set('notes', e.target.value)}
        />
      </Field>
      <ErrorBox error={save.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => onDone()}>
          Cancelar
        </button>
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          Guardar
        </button>
      </div>
    </form>
  );
}
