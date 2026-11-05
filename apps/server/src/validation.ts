import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodType } from 'zod';

/** zValidator con respuesta de error uniforme: { error, issues: [{ path, message }] }. */
export const zv = <T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      return c.json(
        {
          error: issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '),
          issues,
        },
        400,
      );
    }
  });
