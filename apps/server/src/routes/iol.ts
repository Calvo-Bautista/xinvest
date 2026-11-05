import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { IolApiError, type IolClient } from '../adapters/iol/client';
import { IOL, integrationsRepo } from '../adapters/iol/store';
import type { Db } from '../db/types';
import { isoDate } from '../schemas';
import { todayAR } from '../serialize';
import { defaultOperationsFrom, syncIolOperations, syncIolPrices } from '../services/iol-sync';
import { zv } from '../validation';

/** null = credenciales de IOL no configuradas. */
export type IolFactory = () => IolClient | null;

function requireClient(make: IolFactory): IolClient {
  const c = make();
  if (!c) {
    throw new HTTPException(409, {
      message: 'IOL no está configurado: definí IOL_USERNAME e IOL_PASSWORD en el entorno.',
    });
  }
  return c;
}

/** Errores de IOL → 502 con el mensaje (y trace id para soporte). */
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof IolApiError) {
      const trace = e.traceId ? ` (trace ${e.traceId})` : '';
      const status = e.status === 401 ? 401 : e.status === 504 ? 504 : 502;
      throw new HTTPException(status, { message: `${e.message}${trace}` });
    }
    throw e;
  }
}

const opsBody = z
  .object({ from: isoDate.optional(), to: isoDate.optional(), dryRun: z.boolean().default(true) })
  .refine((b) => !b.from || !b.to || b.from <= b.to, 'from debe ser <= to');

export const iolRoutes = (db: Db, make: IolFactory) =>
  new Hono()
    .get('/status', async (c) => {
      const client = make();
      const row = await integrationsRepo(db).get(IOL);
      return c.json({
        configured: client != null,
        session: client ? await client.status() : null,
        lastOperationsSyncAt: row?.lastOperationsSyncAt ?? null,
        lastOperationsSyncTo: row?.lastOperationsSyncTo ?? null,
        lastPricesSyncAt: row?.lastPricesSyncAt ?? null,
        defaultFrom: await defaultOperationsFrom(db),
      });
    })
    .post('/connect', async (c) => {
      const client = requireClient(make);
      await wrap(() => client.accessToken(true));
      return c.json({ ok: true, session: await client.status() });
    })
    .post('/disconnect', async (c) => {
      const client = make();
      if (client) await client.disconnect();
      return c.json({ ok: true });
    })
    .post('/sync/operations', zv('json', opsBody), async (c) => {
      const client = requireClient(make);
      const body = c.req.valid('json');
      const to = body.to ?? todayAR();
      const from = body.from ?? (await defaultOperationsFrom(db));
      if (!from) {
        throw new HTTPException(400, {
          message:
            'Primera sincronización: indicá desde qué fecha (idealmente la apertura de la cuenta).',
        });
      }
      return c.json(
        await wrap(() => syncIolOperations(db, client, { from, to, dryRun: body.dryRun })),
      );
    })
    .post(
      '/sync/prices',
      zv('json', z.object({ from: isoDate.optional(), to: isoDate.optional() })),
      async (c) => {
        const client = requireClient(make);
        const body = c.req.valid('json');
        return c.json(await wrap(() => syncIolPrices(db, client, body)));
      },
    );

/**
 * Sync diario disparado por Vercel Cron. Vercel manda `Authorization: Bearer $CRON_SECRET`.
 * Aplica operaciones sólo si la historia queda consistente; si no, lo deja registrado.
 */
export const cronRoutes = (db: Db, make: IolFactory, cronSecret: string) =>
  new Hono().get('/iol', async (c) => {
    if (!cronSecret || c.req.header('authorization') !== `Bearer ${cronSecret}`) {
      throw new HTTPException(401, { message: 'No autorizado' });
    }
    const client = make();
    if (!client) return c.json({ skipped: 'IOL no configurado' });
    const pricesReport = await wrap(() => syncIolPrices(db, client));
    const from = await defaultOperationsFrom(db);
    const opsReport = from
      ? await wrap(() => syncIolOperations(db, client, { from, to: todayAR(), dryRun: false }))
      : null;
    return c.json({
      prices: { instruments: pricesReport.instruments.length, fx: pricesReport.fx },
      operations: opsReport
        ? {
            counts: opsReport.counts,
            applied: opsReport.applied,
            validationError: opsReport.validationError,
          }
        : 'Sin sincronización inicial: hacé la primera desde la UI.',
    });
  });
