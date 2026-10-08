import { randomUUID } from 'node:crypto';
import type { BotEvent } from '../core/queue.js';
import type { ControllerStore, ControllerTask } from './controller-state.js';

const activeStates = ['queued', 'running', 'approval', 'recovering'];
const progressLimit = 300;
const resultLimit = 600;

export interface NewTask {
    conversationKey: string;
    originEventId: string;
    title: string;
    prompt: string;
}

export interface TaskSummary {
    id: string;
    title: string;
    state: ControllerTask['state'];
    originEventId: string;
    createdAt?: string;
    updatedAt?: string;
    progress?: string;
    result?: string;
}

const activeTask = (task: Pick<ControllerTask, 'state'>): boolean => activeStates.includes(task.state);

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

function summarize(task: ControllerTask): TaskSummary {
    return {
        id: task.id,
        title: task.title ?? clip(task.prompt.split('\n')[0] ?? 'Task', 80),
        state: task.state,
        originEventId: task.originEventId,
        ...(task.createdAt ? { createdAt: task.createdAt } : {}),
        ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
        ...(task.progress ? { progress: task.progress } : {}),
        ...(task.result ? { result: clip(task.result, resultLimit) } : {}),
    };
}

export class TaskDesk {
    constructor(
        private readonly store: ControllerStore,
        private readonly generation: () => number,
        private readonly wake: () => void,
        private readonly steer: (sessionId: string, turnId: string, text: string) => Promise<void>,
        private readonly interrupt: (sessionId: string, turnId: string) => Promise<void>,
        private readonly now = Date.now,
    ) {}

    private stamp(): string {
        return new Date(this.now()).toISOString();
    }

    async start(input: NewTask): Promise<string> {
        if (!input.prompt.trim() || input.prompt.length > 32000) throw new Error('Task prompt is empty or too large');
        const id = randomUUID();
        const at = this.stamp();
        await this.store.update((state) => {
            state.tasks.push({
                id,
                ...input,
                title: clip(input.title.trim() || 'Task', 120),
                createdAt: at,
                updatedAt: at,
                state: 'queued',
            });
        }, this.generation());
        this.wake();
        return id;
    }

    get(id: string): ControllerTask {
        const task = this.store.snapshot().tasks.find((item) => item.id === id);
        if (!task) throw new Error('Task not found');
        return task;
    }

    list(conversationKey?: string, limit = 25): TaskSummary[] {
        const tasks = this.store.snapshot().tasks.filter((item) => !conversationKey || item.conversationKey === conversationKey);
        const recent = (task: ControllerTask) => task.updatedAt ?? task.createdAt ?? '';
        return [
            ...tasks.filter(activeTask),
            ...tasks.filter((item) => !activeTask(item)).sort((a, b) => recent(b).localeCompare(recent(a))),
        ]
            .slice(0, limit)
            .map((task) => summarize(task));
    }

    async message(id: string, text: string, originEventId?: string): Promise<'steered' | 'queued'> {
        const task = this.get(id);
        if (task.sessionId && task.turnId && ['running', 'approval'].includes(task.state)) {
            await this.steer(task.sessionId, task.turnId, text);
            return 'steered';
        }
        if (activeTask(task)) throw new Error('Task is starting; try again in a moment');
        await this.store.update((state) => {
            const current = state.tasks.find((item) => item.id === id)!;
            Object.assign(current, { state: 'queued', prompt: text, updatedAt: this.stamp() }, originEventId ? { originEventId } : {});
            delete current.turnId;
            delete current.result;
            delete current.progress;
        }, this.generation());
        this.wake();
        return 'queued';
    }

    async cancel(id: string): Promise<void> {
        const task = this.get(id);
        if (task.sessionId && task.turnId && ['running', 'approval'].includes(task.state))
            await this.interrupt(task.sessionId, task.turnId);
        await this.store.update((state) => {
            Object.assign(
                state.tasks.find((item) => item.id === id)!,
                { state: 'cancelled', updatedAt: this.stamp() },
            );
        }, this.generation());
    }

    async progress(sessionId: string, text: string): Promise<void> {
        await this.store.update((state) => {
            const task = state.tasks.find((item) => item.sessionId === sessionId);
            if (task) Object.assign(task, { progress: clip(text, progressLimit), updatedAt: this.stamp() });
        }, this.generation());
    }
}

export function workerReport(
    task: ControllerTask,
    text: string,
    ok: boolean,
    origin: BotEvent,
    turnId: string,
): BotEvent & { replyTo: string } {
    const title = task.title ?? 'Task';
    return {
        ...origin,
        id: `${task.id}:${turnId}`,
        replyTo: task.originEventId,
        text: `[Report from your worker "${title}" (task ${task.id}): it ${ok ? 'finished' : 'failed'}]\n${text}\n\nTell the requester what they need to know about it, in your own words.`,
    };
}
