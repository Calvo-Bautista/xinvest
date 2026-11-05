import { describe, expect, it } from 'vitest';
import { configProblems } from './vercel';

const ok = {
  DATABASE_URL: 'libsql://xinvest-user.turso.io',
  DATABASE_AUTH_TOKEN: 'tok',
  APP_PASSWORD: 'pw',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('configProblems (Vercel)', () => {
  it('sin problemas con todo configurado', () => {
    expect(configProblems(ok)).toEqual([]);
  });

  it('lista cada variable faltante sin exponer valores', () => {
    const p = configProblems({ SESSION_SECRET: 'corto' });
    expect(p.join(' ')).toMatch(/DATABASE_URL/);
    expect(p.join(' ')).toMatch(/APP_PASSWORD/);
    expect(p.join(' ')).toMatch(/SESSION_SECRET es muy corto/);
    expect(p.join(' ')).not.toContain('corto"');
  });

  it('rechaza una DB local y pide el token de Turso', () => {
    expect(configProblems({ ...ok, DATABASE_URL: 'file:./data/x.db' })[0]).toMatch(/remota/);
    expect(configProblems({ ...ok, DATABASE_AUTH_TOKEN: '' })[0]).toMatch(/DATABASE_AUTH_TOKEN/);
  });
});
