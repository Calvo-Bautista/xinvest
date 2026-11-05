import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { CSV_ENTITIES, exportCsv, importCsv } from '../csv/transfer';
import type { Db } from '../db/types';
import { todayAR } from '../serialize';
import { zv } from '../validation';

const entityParam = z.object({ entity: z.enum(CSV_ENTITIES) });
const MAX_BYTES = 2_000_000;

export const csvRoutes = (db: Db) =>
  new Hono()
    .get('/:entity', zv('param', entityParam), async (c) => {
      const { entity } = c.req.valid('param');
      const body = await exportCsv(db, entity);
      return c.body(body, 200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="xinvest-${entity}-${todayAR()}.csv"`,
      });
    })
    .post('/:entity', zv('param', entityParam), async (c) => {
      const { entity } = c.req.valid('param');
      const text = await c.req.text();
      if (text.length > MAX_BYTES)
        throw new HTTPException(413, { message: 'Archivo demasiado grande' });
      if (!text.trim()) throw new HTTPException(400, { message: 'CSV vacío' });
      return c.json(await importCsv(db, entity, text));
    });
