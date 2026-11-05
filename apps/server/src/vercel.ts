/**
 * Entry de Vercel (Node.js function). Usa el cliente libSQL "web" (HTTP puro, sin binarios
 * nativos) para hablar con Turso. Lo empaqueta scripts/build-vercel.mjs con esbuild.
 *
 * Si falta configuración, en vez de tirar la función abajo (FUNCTION_INVOCATION_FAILED, sin
 * pistas) responde 503 con los NOMBRES de las variables a corregir. Nunca expone valores.
 */
import { getRequestListener } from '@hono/node-server';
import { createClient } from '@libsql/client/web';
import { drizzle } from 'drizzle-orm/libsql/web';
import { authConfigFromEnv, createApp, iolFromEnv } from './app';
import * as schema from './db/schema';

export function configProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const url = env.DATABASE_URL ?? '';
  if (!url) problems.push('Falta DATABASE_URL (la URL libsql://… de Turso).');
  else if (!/^(libsql|https|wss?):\/\//.test(url)) {
    problems.push(
      'DATABASE_URL debe ser la URL remota de Turso (libsql://…), no un archivo local.',
    );
  }
  if (url && !env.DATABASE_AUTH_TOKEN) problems.push('Falta DATABASE_AUTH_TOKEN (token de Turso).');
  if (!env.APP_PASSWORD) problems.push('Falta APP_PASSWORD (contraseña para entrar a la app).');
  if ((env.SESSION_SECRET ?? '').length < 32) {
    problems.push(
      env.SESSION_SECRET
        ? 'SESSION_SECRET es muy corto: tiene que tener al menos 32 caracteres.'
        : 'Falta SESSION_SECRET (≥ 32 caracteres aleatorios).',
    );
  }
  return problems;
}

type Fetch = (req: Request) => Response | Promise<Response>;

/** Al pegar valores en Vercel es fácil arrastrar espacios o saltos de línea: los limpiamos. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v?.trim();
  return out;
}

const fail =
  (status: number, error: string, extra: Record<string, unknown> = {}): Fetch =>
  () =>
    Response.json({ error, ...extra }, { status });

function build(): Fetch {
  const env = cleanEnv(process.env);
  const problems = configProblems(env);
  if (problems.length) {
    console.error(`Configuración incompleta: ${problems.join(' ')}`);
    return fail(
      503,
      `Configuración incompleta en Vercel. ${problems.join(' ')} Cargalas en Settings → Environment Variables (entorno Production) y redeployá.`,
      { problems },
    );
  }
  try {
    const client = createClient({
      // biome-ignore lint/style/noNonNullAssertion: validado en configProblems
      url: env.DATABASE_URL!,
      authToken: env.DATABASE_AUTH_TOKEN,
    });
    const db = drizzle(client, { schema });
    const app = createApp({
      db,
      auth: authConfigFromEnv(env),
      iol: iolFromEnv(db, env),
      cronSecret: env.CRON_SECRET,
    });
    return app.fetch;
  } catch (e) {
    // El detalle completo va a los Runtime Logs de Vercel; al cliente sólo el tipo de error.
    console.error('Error inicializando la API:', e);
    return fail(
      503,
      `Error inicializando la API (${(e as Error).name}). Revisá los Runtime Logs de Vercel.`,
    );
  }
}

const app = build();

/** Último recurso: un error no manejado se loguea y responde 500 en vez de matar la función. */
const safeFetch: Fetch = async (req) => {
  try {
    return await app(req);
  } catch (e) {
    console.error('Error no manejado:', e);
    return Response.json({ error: 'Error interno' }, { status: 500 });
  }
};

export default getRequestListener(safeFetch);
