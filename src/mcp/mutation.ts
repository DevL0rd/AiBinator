import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const mutation = {
    eventId: z.uuid().describe('The eventId of the request handed over by AIBI.'),
    idempotencyKey: z
        .string()
        .min(8)
        .max(128)
        .default(() => randomUUID())
        .describe('Optional. Generated automatically; pass the same key only when retrying an action so it is not repeated.'),
};
