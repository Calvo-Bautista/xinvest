import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ZodType } from 'zod';

/**
 * zValidator con error uniforme: 400 { error, issues: [{ path, message }] }.
 * Se lanza como HTTPException (en vez de devolver la respuesta) para que el error no
 * contamine los tipos de respuesta inferidos por el cliente RPC.
 */
export const zv = <T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      const error = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
      throw new HTTPException(400, {
        res: Response.json({ error, issues }, { status: 400 }),
      });
    }
  });
