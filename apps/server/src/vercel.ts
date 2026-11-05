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

function build(): (req: Request) => Response | Promise<Response> {
  const problems = configProblems(process.env);
  if (problems.length) {
    console.error(`Configuración incompleta: ${problems.join(' ')}`);
    return () =>
      Response.json(
        {
          error: `Configuración incompleta en Vercel. ${problems.join(' ')} Cargalas en Settings → Environment Variables (entorno Production) y redeployá.`,
          problems,
        },
        { status: 503 },
      );
  }
  const client = createClient({
    // biome-ignore lint/style/noNonNullAssertion: validado en configProblems
    url: process.env.DATABASE_URL!,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  });
  const db = drizzle(client, { schema });
  const app = createApp({
    db,
    auth: authConfigFromEnv(process.env),
    iol: iolFromEnv(db, process.env),
    cronSecret: process.env.CRON_SECRET,
  });
  return app.fetch;
}

export default getRequestListener(build());
