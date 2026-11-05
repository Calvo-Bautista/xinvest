import { Hono } from 'hono';
import type { Db } from '../db/types';
import { portfolioQuery } from '../schemas';
import { serialize, todayAR } from '../serialize';
import { getSnapshot, getTimeline, type Providers } from '../services/portfolio';
import { zv } from '../validation';

export const portfolioRoutes = (db: Db, providers: Providers) =>
  new Hono()
    .get('/', zv('query', portfolioQuery), async (c) => {
      const { currency, asOf } = c.req.valid('query');
      const snap = await getSnapshot(db, providers, {
        asOf: asOf ?? todayAR(),
        reporting: currency,
      });
      return c.json(serialize(snap));
    })
    .get('/timeline', zv('query', portfolioQuery), async (c) => {
      const { currency, asOf } = c.req.valid('query');
      const tl = await getTimeline(db, providers, { to: asOf ?? todayAR(), reporting: currency });
      return c.json(serialize(tl));
    });
