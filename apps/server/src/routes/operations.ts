import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { operationsRepo } from '../db/repositories';
import type { Db } from '../db/types';
import { idParam, operationInput } from '../schemas';
import { assertConsistent, toOperationRow } from '../services/operations';
import { zv } from '../validation';

export const operationRoutes = (db: Db) =>
  new Hono()
    .get('/', async (c) => {
      const rows = await operationsRepo(db).listWithTicker();
      return c.json(rows.map((r) => ({ ...r.op, ticker: r.ticker })));
    })
    .post('/', zv('json', operationInput), async (c) => {
      const row = toOperationRow(c.req.valid('json'));
      await assertConsistent(db, { upsert: row });
      return c.json(await operationsRepo(db).create(row), 201);
    })
    .put('/:id', zv('param', idParam), zv('json', operationInput), async (c) => {
      const { id } = c.req.valid('param');
      const repo = operationsRepo(db);
      const existing = await repo.get(id);
      if (!existing) throw new HTTPException(404, { message: 'Operación inexistente' });
      const row = toOperationRow(c.req.valid('json'));
      await assertConsistent(db, { upsert: { ...row, id } });
      return c.json(await repo.update(id, row));
    })
    .delete('/:id', zv('param', idParam), async (c) => {
      const { id } = c.req.valid('param');
      // Borrar una compra puede dejar en descubierto una venta posterior.
      await assertConsistent(db, { removeId: id });
      if (!(await operationsRepo(db).remove(id))) {
        throw new HTTPException(404, { message: 'Operación inexistente' });
      }
      return c.json({ ok: true });
    });
