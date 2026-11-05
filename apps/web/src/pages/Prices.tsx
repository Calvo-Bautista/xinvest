import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FX_PAIRS, type FxPair } from '@xinvest/domain';
import { useMemo, useState } from 'react';
import { Empty, ErrorBox, Field, Loading, PageHeader } from '../components/ui';
import { api, unwrap } from '../lib/api';
import { fmtDate, fmtMoney, normalizeDecimal, todayISO } from '../lib/format';
import { useInstruments } from './Instruments';

const PAIR_LABEL: Record<FxPair, string> = { USD_MEP: 'Dólar MEP', USD_CCL: 'Dólar cable (CCL)' };

export function PricesPage() {
  return (
    <>
      <PageHeader
        title="Precios y dólar"
        subtitle="Carga manual. Para valuar a una fecha se usa el último dato cargado hasta ese día."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <PricesSection />
        <FxSection />
      </div>
    </>
  );
}

function PricesSection() {
  const qc = useQueryClient();
  const instruments = useInstruments();
  const prices = useQuery({
    queryKey: ['prices'],
    queryFn: () => unwrap(api.prices.$get({ query: {} })),
  });
  const [instrumentId, setInstrumentId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [price, setPrice] = useState('');
  const [filterId, setFilterId] = useState('');

  const byId = useMemo(() => new Map(instruments.data?.map((i) => [i.id, i])), [instruments.data]);
  const selected = byId.get(Number(instrumentId));

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.prices.$post({
          json: { instrumentId: Number(instrumentId), date, price: normalizeDecimal(price) },
        }),
      ),
    onSuccess: () => {
      setPrice('');
      qc.invalidateQueries();
    },
  });
  const remove = useMutation({
    mutationFn: (p: { instrumentId: number; date: string }) =>
      unwrap(api.prices.$delete({ query: { instrumentId: String(p.instrumentId), date: p.date } })),
    onSuccess: () => qc.invalidateQueries(),
  });

  const rows = (prices.data ?? [])
    .filter((p) => !filterId || String(p.instrumentId) === filterId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return (
    <section className="card p-4">
      <h2 className="mb-3 font-semibold">Precios de instrumentos</h2>
      <form
        className="mb-4 grid grid-cols-2 items-end gap-2 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Instrumento">
          <select
            className="input"
            required
            value={instrumentId}
            onChange={(e) => setInstrumentId(e.target.value)}
          >
            <option value="">Elegí…</option>
            {instruments.data?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.ticker}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fecha">
          <input
            type="date"
            className="input"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label={selected && selected.priceDivisor === '100' ? 'Precio (c/100 VN)' : 'Precio'}>
          <input
            className="input num"
            inputMode="decimal"
            required
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          Guardar
        </button>
      </form>
      <ErrorBox error={save.error ?? remove.error} />
      <div className="mb-2 flex justify-end">
        <select
          className="input w-40"
          value={filterId}
          onChange={(e) => setFilterId(e.target.value)}
        >
          <option value="">Todos</option>
          {instruments.data?.map((i) => (
            <option key={i.id} value={i.id}>
              {i.ticker}
            </option>
          ))}
        </select>
      </div>
      {prices.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>Sin precios cargados.</Empty>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Ticker</th>
                <th className="text-right">Precio</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={`${p.instrumentId}-${p.date}-${p.source}`}>
                  <td className="num">{fmtDate(p.date)}</td>
                  <td className="font-medium">{byId.get(p.instrumentId)?.ticker}</td>
                  <td className="num text-right">{fmtMoney(p.price, p.currency)}</td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="btn-danger px-2"
                      onClick={() => remove.mutate(p)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FxSection() {
  const qc = useQueryClient();
  const fx = useQuery({ queryKey: ['fx-rates'], queryFn: () => unwrap(api['fx-rates'].$get()) });
  const [pair, setPair] = useState<FxPair>('USD_MEP');
  const [date, setDate] = useState(todayISO());
  const [rate, setRate] = useState('');

  const save = useMutation({
    mutationFn: () =>
      unwrap(api['fx-rates'].$post({ json: { pair, date, rate: normalizeDecimal(rate) } })),
    onSuccess: () => {
      setRate('');
      qc.invalidateQueries();
    },
  });
  const remove = useMutation({
    mutationFn: (r: { date: string; pair: FxPair }) =>
      unwrap(api['fx-rates'].$delete({ query: r })),
    onSuccess: () => qc.invalidateQueries(),
  });

  const rows = [...(fx.data ?? [])].reverse();

  return (
    <section className="card p-4">
      <h2 className="font-semibold">Cotizaciones del dólar</h2>
      <p className="mb-3 text-xs text-zinc-500">
        Pesos por dólar. El MEP se usa para la vista en USD; el CCL sólo para convertir operaciones
        en USD cable a pesos (si falta, se usa el MEP).
      </p>
      <form
        className="mb-4 grid grid-cols-2 items-end gap-2 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Tipo">
          <select
            className="input"
            value={pair}
            onChange={(e) => setPair(e.target.value as FxPair)}
          >
            {FX_PAIRS.map((p) => (
              <option key={p} value={p}>
                {PAIR_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fecha">
          <input
            type="date"
            className="input"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="ARS por USD">
          <input
            className="input num"
            inputMode="decimal"
            required
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </Field>
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          Guardar
        </button>
      </form>
      <ErrorBox error={save.error ?? remove.error} />
      {fx.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>Sin cotizaciones. Cargá al menos una de MEP para ver valores en USD.</Empty>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th className="text-right">Cotización</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.date}-${r.pair}-${r.source}`}>
                  <td className="num">{fmtDate(r.date)}</td>
                  <td>{PAIR_LABEL[r.pair]}</td>
                  <td className="num text-right">{fmtMoney(r.rate, 'ARS')}</td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="btn-danger px-2"
                      onClick={() => remove.mutate(r)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
