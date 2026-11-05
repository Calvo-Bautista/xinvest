import { type Instrument, type Operation, validateOperations } from '@xinvest/domain';
import { toInstrument, toOperation } from '../db/mappers';
import { instrumentsRepo, operationsRepo } from '../db/repositories';
import type { OperationRow } from '../db/schema';
import type { Db } from '../db/types';
import type { OperationInput } from '../schemas';

/** Convierte el input validado a columnas de la tabla (nulls explícitos según el tipo). */
export function toOperationRow(input: OperationInput) {
  return {
    date: input.date,
    type: input.type,
    instrumentId: 'instrumentId' in input ? input.instrumentId : null,
    quantity: 'quantity' in input ? input.quantity : null,
    unitPrice: 'unitPrice' in input ? input.unitPrice : null,
    amount: 'amount' in input ? input.amount : null,
    currency: input.currency,
    commission: input.commission,
    marketFees: input.marketFees,
    taxes: input.taxes,
    notes: input.notes ?? null,
    externalId: input.externalId || null,
  };
}

type OpRowLike = ReturnType<typeof toOperationRow> & { id?: number };

/**
 * Valida que la historia completa siga siendo consistente si se aplica el cambio
 * (por ejemplo, editar una compra vieja puede dejar una venta posterior en descubierto).
 */
export async function assertConsistent(
  db: Db,
  change: { upsert?: OpRowLike; removeId?: number; extra?: OpRowLike[] },
): Promise<void> {
  const [instRows, opRows] = await Promise.all([
    instrumentsRepo(db).list(),
    operationsRepo(db).list(),
  ]);
  const instruments: Instrument[] = instRows.map(toInstrument);
  let ops: Operation[] = opRows
    .filter((r) => r.id !== change.removeId && r.id !== change.upsert?.id)
    .map(toOperation);
  let tempId = Number.MAX_SAFE_INTEGER - 1_000_000;
  const asOp = (r: OpRowLike): Operation =>
    toOperation({ ...(r as OperationRow), id: r.id ?? tempId++ });
  if (change.upsert) ops.push(asOp(change.upsert));
  if (change.extra) ops = ops.concat(change.extra.map(asOp));
  validateOperations(instruments, ops);
}
