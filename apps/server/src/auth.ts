import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { sign, verify } from 'hono/jwt';
import { timingSafeEqual } from 'hono/utils/buffer';
import { z } from 'zod';
import { zv } from './validation';

export interface AuthConfig {
  /** Contraseña única de la app. Vacía = auth deshabilitada (sólo permitido fuera de producción). */
  password: string;
  sessionSecret: string;
  production: boolean;
}

const COOKIE = 'xinvest_session';
const SESSION_DAYS = 30;

export function assertAuthConfig(cfg: AuthConfig) {
  if (!cfg.production) return;
  if (!cfg.password) throw new Error('APP_PASSWORD es obligatorio en producción');
  if (cfg.sessionSecret.length < 32)
    throw new Error('SESSION_SECRET debe tener al menos 32 caracteres');
}

export const authEnabled = (cfg: AuthConfig) => cfg.production || cfg.password.length > 0;

/** Protege todo /api salvo /api/auth/*. */
export const requireAuth = (cfg: AuthConfig) =>
  createMiddleware(async (c, next) => {
    if (!authEnabled(cfg) || c.req.path.startsWith('/api/auth/')) return next();
    const token = getCookie(c, COOKIE);
    if (!token) throw new HTTPException(401, { message: 'No autenticado' });
    try {
      await verify(token, cfg.sessionSecret, 'HS256');
    } catch {
      throw new HTTPException(401, { message: 'Sesión inválida o vencida' });
    }
    return next();
  });

export const authRoutes = (cfg: AuthConfig) =>
  new Hono()
    .get('/me', async (c) => {
      if (!authEnabled(cfg)) return c.json({ authenticated: true, authEnabled: false });
      const token = getCookie(c, COOKIE);
      const ok = token
        ? await verify(token, cfg.sessionSecret, 'HS256').then(
            () => true,
            () => false,
          )
        : false;
      return c.json({ authenticated: ok, authEnabled: true });
    })
    .post('/login', zv('json', z.object({ password: z.string().min(1) })), async (c) => {
      if (!authEnabled(cfg)) return c.json({ ok: true });
      const { password } = c.req.valid('json');
      if (!(await timingSafeEqual(password, cfg.password))) {
        // Frena un poco la fuerza bruta (además del rate limit de la plataforma).
        await new Promise((r) => setTimeout(r, 800));
        throw new HTTPException(401, { message: 'Contraseña incorrecta' });
      }
      const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
      const token = await sign({ sub: 'owner', exp }, cfg.sessionSecret, 'HS256');
      setCookie(c, COOKIE, token, {
        httpOnly: true,
        secure: cfg.production,
        sameSite: 'Strict',
        path: '/',
        maxAge: SESSION_DAYS * 86400,
      });
      return c.json({ ok: true });
    })
    .post('/logout', (c) => {
      deleteCookie(c, COOKIE, { path: '/' });
      return c.json({ ok: true });
    });
