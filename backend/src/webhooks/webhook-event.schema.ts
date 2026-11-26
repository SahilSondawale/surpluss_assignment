import { z } from 'zod';

// ok | always_fail | fail_then_succeed:<whole number> | slow:<seconds, decimals allowed>
const SIMULATE_PATTERN = /^(ok|always_fail|fail_then_succeed:\d+|slow:\d+(\.\d+)?)$/;

export const webhookEventSchema = z.object({
  eventId: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  // looseObject = keep any extra fields inside data instead of removing them
  data: z.looseObject({
    orderId: z.string().min(1).max(255),
    customerId: z.string().optional(),
    simulate: z
      .string()
      .regex(
        SIMULATE_PATTERN,
        'must be ok, always_fail, fail_then_succeed:<N> or slow:<seconds>',
      )
      .optional(),
  }),
});

// A TypeScript type generated from the schema, so the two can never disagree.
export type WebhookEvent = z.infer<typeof webhookEventSchema>;
