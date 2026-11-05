import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { instrumentsRepo } from '../db/repositories';
import type { Db } from '../db/types';
import { type InstrumentInput, idParam, instrumentInput } from '../schemas';
import { zv } from '../validation';

export const defaultDivisor = (type: InstrumentInput['type']) =>
  type === 'BOND' || type === 'ON' ? '100' : '1';

export const toInstrumentRow = (i: InstrumentInput) => ({
  ticker: i.ticker,
  name: i.name ?? null,
  type: i.type,
  currency: i.currency,
  priceDivisor: i.priceDivisor ?? defaultDivisor(i.type),
  cedearRatio: i.cedearRatio ?? null,
  notes: i.notes ?? null,
});

export const instrumentRoutes = (db: Db) =>
  new Hono()
    .get('/', async (c) => c.json(await instrumentsRepo(db).list()))
    .post('/', zv('json', instrumentInput), async (c) => {
      const row = await instrumentsRepo(db).create(toInstrumentRow(c.req.valid('json')));
      return c.json(row, 201);
    })
    .put('/:id', zv('param', idParam), zv('json', instrumentInput), async (c) => {
      const row = await instrumentsRepo(db).update(
        c.req.valid('param').id,
        toInstrumentRow(c.req.valid('json')),
      );
      if (!row) throw new HTTPException(404, { message: 'Instrumento inexistente' });
      return c.json(row);
    })
    .delete('/:id', zv('param', idParam), async (c) => {
      const { id } = c.req.valid('param');
      const repo = instrumentsRepo(db);
      if ((await repo.countOperations(id)) > 0) {
        throw new HTTPException(409, {
          message: 'El instrumento tiene operaciones: borralas primero.',
        });
      }
      if (!(await repo.remove(id)))
        throw new HTTPException(404, { message: 'Instrumento inexistente' });
      return c.json({ ok: true });
    });
