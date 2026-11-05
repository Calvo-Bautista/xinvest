import { DomainError, MissingFxRateError } from '@xinvest/domain';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { DbFxRateProvider, DbPriceProvider } from './adapters/db-providers';
import { IolClient } from './adapters/iol/client';
import { dbTokenStore } from './adapters/iol/store';
import { type AuthConfig, assertAuthConfig, authRoutes, requireAuth } from './auth';
import type { Db } from './db/types';
import { csvRoutes } from './routes/csv';
import { instrumentRoutes } from './routes/instruments';
import { cronRoutes, type IolFactory, iolRoutes } from './routes/iol';
import { operationRoutes } from './routes/operations';
import { portfolioRoutes } from './routes/portfolio';
import { fxRoutes, priceRoutes } from './routes/prices';
import type { Providers } from './services/portfolio';

export interface AppDeps {
  db: Db;
  auth: AuthConfig;
  /** Inyectables para tests. */
  providers?: Providers;
  /** Integración IOL; si se omite o no hay credenciales, los endpoints de IOL responden 409. */
  iol?: IolFactory;
  /** Secreto que Vercel Cron manda en Authorization. Vacío = cron deshabilitado. */
  cronSecret?: string;
}

/** Busca un error de constraint de SQLite en la cadena de causas (Drizzle envuelve el original). */
function sqliteConstraint(err: unknown): string | null {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: string }).code ?? '';
    const msg = (e as { message?: string }).message ?? '';
    if (code.startsWith('SQLITE_CONSTRAINT') || msg.includes('constraint failed')) return msg;
  }
  return null;
}

export function createApp(deps: AppDeps) {
  assertAuthConfig(deps.auth);
  const { db } = deps;
  const providers = deps.providers ?? {
    prices: new DbPriceProvider(db),
    fx: new DbFxRateProvider(db),
  };
  const iol: IolFactory = deps.iol ?? (() => null);

  const api = new Hono()
    .basePath('/api')
    .use(secureHeaders())
    .use(requireAuth(deps.auth))
    .route('/auth', authRoutes(deps.auth))
    .route('/instruments', instrumentRoutes(db))
    .route('/operations', operationRoutes(db))
    .route('/prices', priceRoutes(db))
    .route('/fx-rates', fxRoutes(db))
    .route('/portfolio', portfolioRoutes(db, providers))
    .route('/csv', csvRoutes(db))
    .route('/iol', iolRoutes(db, iol))
    .route('/cron', cronRoutes(db, iol, deps.cronSecret ?? ''));

  api.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.res ? err.getResponse() : c.json({ error: err.message }, err.status);
    }
    if (err instanceof DomainError || err instanceof MissingFxRateError) {
      return c.json({ error: err.message }, 422);
    }
    const constraint = sqliteConstraint(err);
    if (constraint) {
      const msg = constraint.includes('UNIQUE')
        ? 'Ya existe un registro con esos datos (ticker / id externo duplicado).'
        : `Restricción de la base violada: ${constraint}`;
      return c.json({ error: msg }, 409);
    }
    console.error(err);
    return c.json({ error: 'Error interno' }, 500);
  });
  api.notFound((c) => c.json({ error: 'No encontrado' }, 404));

  return api;
}

export type AppType = ReturnType<typeof createApp>;

export function authConfigFromEnv(env: Record<string, string | undefined>): AuthConfig {
  return {
    password: env.APP_PASSWORD ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    production: env.NODE_ENV === 'production' || env.VERCEL === '1',
  };
}

/**
 * Fábrica del cliente IOL a partir del entorno. Los tokens se cifran con IOL_TOKEN_KEY o, si no
 * está, con SESSION_SECRET (obligatorio en producción).
 */
export function iolFromEnv(db: Db, env: Record<string, string | undefined>): IolFactory {
  const username = env.IOL_USERNAME ?? '';
  const password = env.IOL_PASSWORD ?? '';
  const key = env.IOL_TOKEN_KEY || env.SESSION_SECRET || 'dev-only-iol-token-key';
  if (!username || !password) return () => null;
  return () => new IolClient({ username, password }, dbTokenStore(db, key));
}
