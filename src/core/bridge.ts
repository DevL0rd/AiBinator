import type { Policy } from './policy.js';
import type { EventQueue } from './queue.js';
import type { Journal } from './journal.js';
import type { VoiceDesk } from '../aibi/desk.js';
import type { AibiService } from '../aibi/service.js';

export interface MutationInput {
    eventId: string;
    idempotencyKey: string;
}

export class Bridge {
    desk?: VoiceDesk;
    aibi?: AibiService;

    constructor(
        readonly policy: Policy,
        readonly queue: EventQueue,
        readonly journal: Journal,
    ) {}

    respond(input: MutationInput & { content: string; status?: boolean }): Promise<unknown> {
        const context = this.queue.context(input.eventId);
        if (!input.content.trim()) throw new Error('A reply needs text');
        return this.journal.execute(input.idempotencyKey, { operation: 'respond', ...input }, async () => {
            if (!context.respond) throw new Error('This request cannot be answered');
            return context.respond(input.content, input.status === true);
        });
    }

    typing(eventId: string): Promise<void> {
        this.queue.context(eventId);
        return Promise.resolve();
    }

    status() {
        return { queueEpoch: this.queue.epoch, scopes: this.policy.config.scopes };
    }
}
