import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ApprovalDecision, ProviderApproval } from './provider-adapter.js';

const questionSchema = z.object({
    id: z.string().optional(),
    question: z.string().min(1),
    isSecret: z.boolean().optional(),
    multiSelect: z.boolean().optional(),
    options: z
        .array(z.object({ label: z.string().min(1) }))
        .nullable()
        .optional(),
});
type Question = z.infer<typeof questionSchema>;

interface Pending {
    request: ProviderApproval;
    originEventId: string;
    questions?: Question[];
}

type Fields = Record<string, unknown>;
const record = (value: unknown): Fields => (value && typeof value === 'object' ? (value as Fields) : {});
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function action(request: ProviderApproval): string {
    const payload = record(request.payload);
    const input = record(payload.input);
    const command = text(payload.command) || text(input.command);
    const path = text(input.file_path) || text(record((payload.changes as unknown[] | undefined)?.[0]).path);
    return [request.title.slice(0, 300), command ? `Command: ${command.slice(0, 300)}` : '', path ? `File: ${path}` : '']
        .filter(Boolean)
        .join('. ');
}

function parseQuestions(payload: unknown): Question[] {
    const wrapper = z.object({ input: z.unknown().optional() }).loose().parse(payload);
    const { questions } = z.object({ questions: z.array(questionSchema).min(1).max(5) }).parse(wrapper.input ?? payload);
    if (questions.some((item) => item.isSecret)) throw new Error('Secret answers cannot be given out loud');
    return questions;
}

const said = (answer: string, words: RegExp) => words.test(answer.toLowerCase());

function approvalDecision(pending: Pending, answer: string): ApprovalDecision {
    if (said(answer, /\b(cancel|stop the task|abort)\b/)) return { action: 'cancel' };
    if (said(answer, /\b(no|deny|don'?t|do not|nope|refuse|skip)\b/)) return { action: 'deny' };
    if (said(answer, /\b(yes|yeah|yep|allow|ok(ay)?|sure|go ahead|do it|approve)\b/)) {
        const permissions = pending.request.kind === 'permissions' ? record(pending.request.payload).permissions : undefined;
        return { action: 'allow-once', ...(permissions ? { permissions } : {}) };
    }
    throw new Error('Ask them again: allow once, deny, or cancel the task?');
}

function choose(question: Question, answer: string): string[] {
    const options = question.options ?? [];
    if (!options.length) return [answer.trim()];
    const lower = answer.toLowerCase();
    const picked = options.filter(
        (option, index) => lower.includes(option.label.toLowerCase()) || new RegExp(`\\b${index + 1}\\b`).test(lower),
    );
    if (!picked.length) throw new Error(`Ask them to pick one of: ${options.map((option) => option.label).join(', ')}`);
    return (question.multiSelect ? picked : picked.slice(0, 1)).map((option) => option.label);
}

function questionNote(id: string, questions: Question[]): string {
    const asks = questions.map(
        (item) => `${item.question}${item.options?.length ? ` Options: ${item.options.map((option) => option.label).join(', ')}.` : ''}`,
    );
    return `[Question ${id}] Your work needs an answer from them: ${asks.join(' Then: ')} Ask them out loud, then call answer_request with request "${id}" and their answer.`;
}

export class VoiceApprovals {
    private readonly pending = new Map<string, Pending>();

    constructor(
        private readonly ask: (originEventId: string, note: string) => void,
        private readonly resolve: (key: string, decision: ApprovalDecision, originEventId: string) => Promise<void>,
    ) {}

    request(request: ProviderApproval, originEventId: string): Promise<void> {
        if (request.secret) throw new Error('Secret input cannot be asked out loud');
        if (request.kind === 'elicitation') throw new Error('This kind of form cannot be answered out loud');
        const id = randomBytes(3).toString('hex');
        const questions = request.kind === 'question' ? parseQuestions(request.payload) : undefined;
        this.invalidate(request.key);
        this.pending.set(id, { request, originEventId, ...(questions ? { questions } : {}) });
        this.ask(
            originEventId,
            questions
                ? questionNote(id, questions)
                : `[Question ${id}] Your work needs permission: ${action(request)}. Ask them whether to allow it once, deny it, or cancel the task, then call answer_request with request "${id}" and the single word allow, deny or cancel.`,
        );
        return Promise.resolve();
    }

    async answer(id: string, answer: string): Promise<string> {
        const pending = this.pending.get(id.trim());
        if (!pending) throw new Error('That question is no longer waiting for an answer');
        const decision = pending.questions
            ? {
                  action: 'allow-once' as const,
                  answers: Object.fromEntries(pending.questions.map((item) => [item.id ?? item.question, choose(item, answer)])),
              }
            : approvalDecision(pending, answer);
        this.pending.delete(id.trim());
        try {
            await this.resolve(pending.request.key, decision, pending.originEventId);
        } catch (error) {
            this.pending.set(id.trim(), pending);
            throw error;
        }
        return decision.action === 'allow-once' ? 'passed on; the work continues' : `passed on: ${decision.action}`;
    }

    invalidate(key: string): void {
        for (const [id, pending] of this.pending) if (pending.request.key === key) this.pending.delete(id);
    }

    invalidateAll(): void {
        this.pending.clear();
    }

    get waiting(): number {
        return this.pending.size;
    }
}
