import { z } from 'zod';

export const dashboardSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict()
  .refine((query) => !query.from || !query.to || query.to >= query.from, {
    message: 'to must be on or after from',
    path: ['to'],
  });

export const lowStockSchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    threshold: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export const salesTrendSchema = z
  .object({ days: z.coerce.number().int().positive().max(365).default(30) })
  .strict();
