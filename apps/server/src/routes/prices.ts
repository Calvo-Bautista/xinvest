import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { fxRatesRepo, instrumentsRepo, pricesRepo } from '../db/repositories';
import type { Db } from '../db/types';
import { fxPair, fxRateInput, isoDate, priceInput } from '../schemas';
import { zv } from '../validation';

export const priceRoutes = (db: Db) =>
  new Hono()
    .get(
      '/',
      zv('query', z.object({ instrumentId: z.coerce.number().int().positive().optional() })),
      async (c) => c.json(await pricesRepo(db).list(c.req.valid('query'))),
    )
    .post('/', zv('json', priceInput), async (c) => {
      const input = c.req.valid('json');
      const inst = await instrumentsRepo(db).get(input.instrumentId);
      if (!inst) throw new HTTPException(404, { message: 'Instrumento inexistente' });
      await pricesRepo(db).upsert({ ...input, currency: input.currency ?? inst.currency });
      return c.json({ ok: true }, 201);
    })
    .delete(
      '/',
      zv('query', z.object({ instrumentId: z.coerce.number().int().positive(), date: isoDate })),
      async (c) => {
        const { instrumentId, date } = c.req.valid('query');
        if (!(await pricesRepo(db).remove(instrumentId, date))) {
          throw new HTTPException(404, { message: 'Precio inexistente' });
        }
        return c.json({ ok: true });
      },
    );

export const fxRoutes = (db: Db) =>
  new Hono()
    .get('/', async (c) => c.json(await fxRatesRepo(db).list()))
    .post('/', zv('json', fxRateInput), async (c) => {
      await fxRatesRepo(db).upsert(c.req.valid('json'));
      return c.json({ ok: true }, 201);
    })
    .delete('/', zv('query', z.object({ date: isoDate, pair: fxPair })), async (c) => {
      const { date, pair } = c.req.valid('query');
      if (!(await fxRatesRepo(db).remove(date, pair))) {
        throw new HTTPException(404, { message: 'Cotización inexistente' });
      }
      return c.json({ ok: true });
    });
