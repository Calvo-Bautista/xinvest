import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CURRENCIES, type Currency, OPERATION_TYPES, type OperationType } from '@xinvest/domain';
import { useMemo, useState } from 'react';
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader } from '../components/ui';
import { api, type OperationListItem, unwrap } from '../lib/api';
import {
  CURRENCY_LABELS,
  fmtDate,
  fmtMoney,
  fmtNum,
  normalizeDecimal,
  OPERATION_LABELS,
  todayISO,
} from '../lib/format';
import { useInstruments } from './Instruments';

const isTrade = (t: OperationType) => t === 'BUY' || t === 'SELL';
const isCash = (t: OperationType) => t === 'DEPOSIT' || t === 'WITHDRAWAL';

const TYPE_HELP: Record<OperationType, string> = {
  BUY: 'Compra: el costo incluye comisión, derechos e IVA.',
  SELL: 'Venta: el resultado realizado es lo cobrado neto − precio promedio × cantidad.',
  DIVIDEND:
    'Dividendo cobrado. Cargá el bruto y la retención en "Impuestos", o directamente el neto.',
  COUPON: 'Renta (interés) de un bono/ON. Es ganancia: suma al P&L.',
  AMORTIZATION:
    'Amortización: devolución de capital de un bono/ON. No es ganancia: baja el costo de la posición.',
  DEPOSIT: 'Ingreso de dinero a la cuenta. Cuenta como capital aportado.',
  WITHDRAWAL: 'Retiro de dinero de la cuenta. Resta capital aportado.',
};

export function OperationsPage() {
  const qc = useQueryClient();
  const ops = useQuery({ queryKey: ['operations'], queryFn: () => unwrap(api.operations.$get()) });
  const [editing, setEditing] = useState<OperationListItem | 'new' | null>(null);
  const [filter, setFilter] = useState('');

  const remove = useMutation({
    mutationFn: (id: number) =>
      unwrap(api.operations[':id'].$delete({ param: { id: String(id) } })),
    onSuccess: () => qc.invalidateQueries(),
  });

  const rows = useMemo(() => {
    const q = filter.trim().toUpperCase();
    if (!q || !ops.data) return ops.data ?? [];
    return ops.data.filter(
      (o) =>
        o.ticker?.includes(q) ||
        OPERATION_LABELS[o.type].toUpperCase().includes(q) ||
        o.date.includes(q),
    );
  }, [ops.data, filter]);

  return (
    <>
      <PageHeader
        title="Operaciones"
        subtitle="Fuente de verdad: las posiciones se derivan de esta lista."
        actions={
          <>
            <input
              className="input w-48"
              placeholder="Filtrar (ticker, tipo, fecha)"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
              + Nueva operación
            </button>
          </>
        }
      />
      <ErrorBox error={remove.error} />
      <div className="card overflow-x-auto">
        {ops.isPending ? (
          <Loading />
        ) : ops.error ? (
          <ErrorBox error={ops.error} />
        ) : rows.length === 0 ? (
          <Empty>No hay operaciones.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Ticker</th>
                <th className="text-right">Cantidad</th>
                <th className="text-right">Precio</th>
                <th className="text-right">Monto</th>
                <th className="text-right">Gastos</th>
                <th>Notas</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const fees = Number(o.commission) + Number(o.marketFees) + Number(o.taxes);
                return (
                  <tr key={o.id}>
                    <td className="num">{fmtDate(o.date)}</td>
                    <td>
                      <TypeBadge type={o.type} />
                    </td>
                    <td className="font-medium">{o.ticker ?? '—'}</td>
                    <td className="num text-right">{fmtNum(o.quantity)}</td>
                    <td className="num text-right">
                      {o.unitPrice ? fmtMoney(o.unitPrice, o.currency) : '—'}
                    </td>
                    <td className="num text-right">
                      {o.amount ? fmtMoney(o.amount, o.currency) : '—'}
                    </td>
                    <td className="num text-right text-zinc-500">
                      {fees ? fmtMoney(fees, o.currency) : '—'}
                    </td>
                    <td className="max-w-48 truncate text-zinc-500" title={o.notes ?? ''}>
                      {o.notes}
                    </td>
                    <td className="text-right">
                      <button type="button" className="btn-ghost" onClick={() => setEditing(o)}>
                        Editar
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => confirm('¿Borrar la operación?') && remove.mutate(o.id)}
                      >
                        Borrar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Nueva operación' : 'Editar operación'}
      >
        {editing != null && (
          <OperationForm
            initial={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Modal>
    </>
  );
}

const BADGE: Record<OperationType, string> = {
  BUY: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  SELL: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  DIVIDEND: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  COUPON: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  AMORTIZATION: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
  DEPOSIT: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  WITHDRAWAL: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

function TypeBadge({ type }: { type: OperationType }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${BADGE[type]}`}>
      {OPERATION_LABELS[type]}
    </span>
  );
}

interface FormState {
  type: OperationType;
  date: string;
  instrumentId: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  currency: Currency;
  commission: string;
  marketFees: string;
  taxes: string;
  notes: string;
}

function OperationForm({
  initial,
  onDone,
}: {
  initial: OperationListItem | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const instruments = useInstruments();
  const [f, setF] = useState<FormState>(() =>
    initial
      ? {
          type: initial.type,
          date: initial.date,
          instrumentId: initial.instrumentId ? String(initial.instrumentId) : '',
          quantity: initial.quantity ?? '',
          unitPrice: initial.unitPrice ?? '',
          amount: initial.amount ?? '',
          currency: initial.currency,
          commission: initial.commission === '0' ? '' : initial.commission,
          marketFees: initial.marketFees === '0' ? '' : initial.marketFees,
          taxes: initial.taxes === '0' ? '' : initial.taxes,
          notes: initial.notes ?? '',
        }
      : {
          type: 'BUY',
          date: todayISO(),
          instrumentId: '',
          quantity: '',
          unitPrice: '',
          amount: '',
          currency: 'ARS',
          commission: '',
          marketFees: '',
          taxes: '',
          notes: '',
        },
  );
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const instrument = instruments.data?.find((i) => String(i.id) === f.instrumentId);

  // Caución: helper TNA → precio de cierre. interés = capital × TNA × días / 365
  const [tna, setTna] = useState('');
  const [days, setDays] = useState('');

  const d = (s: string) => (s ? Number(normalizeDecimal(s)) : 0);
  const fees = d(f.commission) + d(f.marketFees) + d(f.taxes);
  const divisor = instrument ? Number(instrument.priceDivisor) : 1;
  const gross = isTrade(f.type) ? (d(f.quantity) * d(f.unitPrice)) / divisor : d(f.amount);
  const net = f.type === 'BUY' || f.type === 'WITHDRAWAL' ? gross + fees : gross - fees;

  const save = useMutation({
    mutationFn: async () => {
      const base = {
        date: f.date,
        currency: f.currency,
        commission: normalizeDecimal(f.commission || '0'),
        marketFees: normalizeDecimal(f.marketFees || '0'),
        taxes: normalizeDecimal(f.taxes || '0'),
        notes: f.notes || null,
      };
      const json = isTrade(f.type)
        ? {
            ...base,
            type: f.type as 'BUY' | 'SELL',
            instrumentId: Number(f.instrumentId),
            quantity: normalizeDecimal(f.quantity),
            unitPrice: normalizeDecimal(f.unitPrice),
          }
        : isCash(f.type)
          ? {
              ...base,
              type: f.type as 'DEPOSIT' | 'WITHDRAWAL',
              amount: normalizeDecimal(f.amount),
            }
          : {
              ...base,
              type: f.type as 'DIVIDEND' | 'COUPON' | 'AMORTIZATION',
              instrumentId: Number(f.instrumentId),
              amount: normalizeDecimal(f.amount),
            };
      return initial
        ? unwrap(api.operations[':id'].$put({ param: { id: String(initial.id) }, json }))
        : unwrap(api.operations.$post({ json }));
    },
    onSuccess: () => {
      qc.invalidateQueries();
      onDone();
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Tipo">
          <select
            className="input"
            value={f.type}
            onChange={(e) => set('type', e.target.value as OperationType)}
          >
            {OPERATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {OPERATION_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fecha">
          <input
            type="date"
            className="input"
            required
            value={f.date}
            onChange={(e) => set('date', e.target.value)}
          />
        </Field>
        <Field label="Moneda">
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
      </div>
      <p className="-mt-1 text-xs text-zinc-500">{TYPE_HELP[f.type]}</p>

      {!isCash(f.type) && (
        <Field
          label="Instrumento"
          hint={instruments.data?.length === 0 ? 'Primero creá un instrumento.' : undefined}
        >
          <select
            className="input"
            required
            value={f.instrumentId}
            onChange={(e) => {
              const inst = instruments.data?.find((i) => String(i.id) === e.target.value);
              setF((s) => ({
                ...s,
                instrumentId: e.target.value,
                currency: inst && !initial ? inst.currency : s.currency,
              }));
            }}
          >
            <option value="">Elegí…</option>
            {instruments.data?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.ticker} {i.name ? `— ${i.name}` : ''}
              </option>
            ))}
          </select>
        </Field>
      )}

      {isTrade(f.type) ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={divisor === 100 ? 'Cantidad (VN)' : 'Cantidad'}>
            <input
              className="input num"
              inputMode="decimal"
              required
              value={f.quantity}
              onChange={(e) => set('quantity', e.target.value)}
            />
          </Field>
          <Field label={divisor === 100 ? 'Precio (cada 100 VN)' : 'Precio unitario'}>
            <input
              className="input num"
              inputMode="decimal"
              required
              value={f.unitPrice}
              onChange={(e) => set('unitPrice', e.target.value)}
            />
          </Field>
        </div>
      ) : (
        <Field label="Monto">
          <input
            className="input num"
            inputMode="decimal"
            required
            value={f.amount}
            onChange={(e) => set('amount', e.target.value)}
          />
        </Field>
      )}

      {instrument?.type === 'CAUCION' && f.type === 'SELL' && (
        <div className="rounded-md bg-zinc-50 p-3 text-xs dark:bg-zinc-800/50">
          <p className="mb-2 text-zinc-600 dark:text-zinc-400">
            Caución al vencimiento: precio = 1 + TNA × días / 365. (La TNA es nominal; la TEA
            equivalente si reinvertís sería (1 + TNA·d/365)^(365/d) − 1.)
          </p>
          <div className="flex items-end gap-2">
            <Field label="TNA %">
              <input
                className="input num w-24"
                inputMode="decimal"
                value={tna}
                onChange={(e) => setTna(e.target.value)}
              />
            </Field>
            <Field label="Días">
              <input
                className="input num w-20"
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </Field>
            <button
              type="button"
              className="btn-ghost"
              disabled={!tna || !days}
              onClick={() => set('unitPrice', (1 + (d(tna) / 100) * (d(days) / 365)).toFixed(8))}
            >
              Calcular precio
            </button>
            {tna && days && (
              <span className="pb-2 text-zinc-500">
                TEA ≈{' '}
                {(((1 + (d(tna) / 100) * (d(days) / 365)) ** (365 / d(days)) - 1) * 100).toFixed(2)}
                %
              </span>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Comisión">
          <input
            className="input num"
            inputMode="decimal"
            placeholder="0"
            value={f.commission}
            onChange={(e) => set('commission', e.target.value)}
          />
        </Field>
        <Field label="Derechos de mercado">
          <input
            className="input num"
            inputMode="decimal"
            placeholder="0"
            value={f.marketFees}
            onChange={(e) => set('marketFees', e.target.value)}
          />
        </Field>
        <Field label="Impuestos (IVA / retenciones)">
          <input
            className="input num"
            inputMode="decimal"
            placeholder="0"
            value={f.taxes}
            onChange={(e) => set('taxes', e.target.value)}
          />
        </Field>
      </div>
      <Field label="Notas">
        <textarea
          className="input"
          rows={2}
          value={f.notes}
          onChange={(e) => set('notes', e.target.value)}
        />
      </Field>

      <div className="flex items-center justify-between rounded-md bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-800/50">
        <span className="text-zinc-500">
          {f.type === 'BUY' || f.type === 'WITHDRAWAL' ? 'Total a pagar' : 'Neto a cobrar'}{' '}
          (estimado)
        </span>
        <span className="num font-medium">{fmtMoney(net, f.currency)}</span>
      </div>

      <ErrorBox error={save.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancelar
        </button>
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          Guardar
        </button>
      </div>
    </form>
  );
}
