import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { policySchema } from '../src/core/config.js';
import { Policy } from '../src/core/policy.js';
import { EventQueue } from '../src/core/queue.js';
import { ActivityLog } from '../src/aibi/activity.js';
import { VoiceDesk, type DeskHost } from '../src/aibi/desk.js';
import { Memory } from '../src/aibi/memory.js';
import { Speeches } from '../src/aibi/speech.js';
import type { LiveEvents, LiveOptions, LiveSession, Picture, ToolDelivery, VoiceProviders } from '../src/voice/gemini.js';

export type Call = [string, ...unknown[]];

export class FakeSession implements LiveSession {
    readonly calls: Call[] = [];

    constructor(
        readonly options: LiveOptions,
        readonly events: LiveEvents,
        private readonly gemini: FakeGemini,
    ) {}

    startTurn(): void {
        this.calls.push(['start']);
    }
    audio(pcm: Int16Array): void {
        this.calls.push(['audio', pcm]);
    }
    endTurn(): void {
        this.calls.push(['end']);
        setImmediate(() => this.gemini.reply(this, 'turn'));
    }
    text(text: string, respond: boolean, image?: Picture): void {
        this.calls.push(['text', text, respond, image]);
        if (respond) setImmediate(() => this.gemini.reply(this, text));
    }
    toolResult(id: string, name: string, response: Record<string, unknown>, delivery?: ToolDelivery): void {
        this.calls.push(['tool', id, name, response, delivery]);
    }
    close(): void {
        this.calls.push(['close']);
    }

    speak(text: string): void {
        this.events.said(text);
        this.events.audio(Int16Array.from({ length: 2400 }, (_, index) => (index % 2 ? 4000 : -4000)));
        this.events.turnComplete();
    }

    named(name: string): Call[] {
        return this.calls.filter(([kind]) => kind === name);
    }
}

export class FakeGemini implements VoiceProviders {
    readonly configured = true;
    readonly sessions: FakeSession[] = [];
    reply: (session: FakeSession, cause: string) => void = () => undefined;

    live(options: LiveOptions, events: LiveEvents): Promise<LiveSession> {
        const session = new FakeSession(options, events, this);
        this.sessions.push(session);
        return Promise.resolve(session);
    }

    get last(): FakeSession {
        return this.sessions.at(-1)!;
    }
}

export function pcm(loud: boolean, samples = 8000): Buffer[] {
    const buffer = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index++) buffer.writeInt16BE(loud ? (index % 2 ? 6000 : -6000) : 0, index * 2);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < buffer.length; offset += 1001) chunks.push(buffer.subarray(offset, offset + 1001));
    return chunks;
}

export async function* stream(chunks: Buffer[]): AsyncIterable<Buffer> {
    for (const chunk of chunks) {
        await new Promise((resolve) => setImmediate(resolve));
        yield chunk;
    }
}

export function deskFixture(directory: string, patch: Partial<DeskHost> = {}) {
    const gemini = new FakeGemini();
    const host: DeskHost = {
        policy: new Policy(policySchema.parse({})),
        queue: new EventQueue(),
        memory: new Memory(2000, join(directory, 'memory.json'), join(directory, 'media')),
        activity: new ActivityLog(500, join(directory, 'activity.json')),
        speeches: new Speeches(),
        providers: gemini,
        responder: () => true,
        answer: () => Promise.resolve('passed on'),
        command: (name) => Promise.resolve(`ran ${name}`),
        robot: () => 'battery: 80',
        changed: () => undefined,
        ...patch,
    };
    return { host, gemini, desk: new VoiceDesk(host) };
}

export const result = (reply: Record<string, unknown>) =>
    reply.queryResult as Record<string, unknown> & { behavior_paras: Record<string, unknown> };

export class FakeSocket extends PassThrough {}

export function played(host: DeskHost, reply: Record<string, unknown>, socket = new FakeSocket()): FakeSocket {
    host.speeches.find(String(result(reply).behavior_paras.url).split('/').at(-1)!)!.serve(socket as unknown as Socket);
    return socket;
}
