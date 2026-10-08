import { randomUUID } from 'node:crypto';
import type { Policy } from '../core/policy.js';
import type { EventQueue, BotEvent } from '../core/queue.js';
import { combined, Conversation, type ConversationHooks, type ToolAnswer } from '../voice/conversation.js';
import type { VoiceProviders } from '../voice/gemini.js';
import { liveInstructions, liveTools } from '../voice/instructions.js';
import type { Outcome } from '../voice/turn.js';
import type { ActivityLog } from './activity.js';
import { checkAction } from './capabilities.js';
import type { Memory } from './memory.js';
import { act, chatMode, chatStart, failed, photoAnswer, recognize, speak, tagged, type Reply } from './protocol.js';
import type { Speeches } from './speech.js';
import { words } from '../core/text.js';

export interface DeskHost {
    policy: Policy;
    queue: EventQueue;
    memory: Memory;
    activity: ActivityLog;
    speeches: Speeches;
    providers: VoiceProviders;
    responder(): boolean;
    answer(request: string, answer: string): Promise<string>;
    command(name: string, value: string): Promise<string>;
    robot(): string;
    changed(): void;
}

export interface TurnInfo {
    index: number;
    timeZone?: string | null;
    chat?: boolean;
}

const leaveForMs = 60_000;
const tellNow = '[Tell them about this now, briefly and in your own words, as your own work.]';

export class VoiceDesk {
    private conversation?: Conversation;
    private readonly outbox: string[] = [];
    private readonly open = new Set<string>();
    private leavingUntil = 0;
    private readonly running = new Map<string, string>();
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    onPublish?: (event: BotEvent) => void;

    constructor(private readonly host: DeskHost) {}

    get active(): boolean {
        return this.conversation?.active === true;
    }

    status() {
        return {
            conversation: this.active,
            waiting: this.outbox.length,
            tasks: this.open.size,
            configured: this.host.providers.configured,
        };
    }

    private zone(value?: string | null): void {
        if (!value) return;
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: value });
            this.timeZone = value;
        } catch {
            return;
        }
    }

    private start(oneShot = false): Conversation {
        if (!oneShot && this.conversation?.active) return this.conversation;
        const conversation = new Conversation(this.host.providers, this.host.speeches, this.hooks(oneShot), oneShot);
        if (oneShot) return conversation;
        this.conversation = conversation;
        for (const note of this.outbox.splice(0)) conversation.tell(note);
        this.host.activity.add('chat', 'Conversation started');
        this.host.changed();
        return conversation;
    }

    async listen(chunks: AsyncIterable<Buffer>, info: TurnInfo): Promise<Reply> {
        this.zone(info.timeZone);
        if (info.chat !== true) this.leavingUntil = 0;
        if (info.chat === true && !this.active && Date.now() < this.leavingUntil) {
            for await (const chunk of chunks) void chunk;
            return chatMode({ index: info.index, queryText: '' }, 'quit');
        }
        const outcome = await this.start()
            .listen(chunks, info.chat === true)
            .catch((error: unknown) => this.failure(error));
        return this.reply(outcome, info);
    }

    async look(image: Buffer, mimeType: string): Promise<Reply> {
        const path = await this.host.memory.image(image, mimeType === 'image/png' ? 'png' : 'jpg');
        this.host.memory.add('note', 'AIBI took a photo with its camera.', path);
        const outcome = await this.start()
            .photo(image, mimeType, '[This is the photo you just took with your camera. Answer about it now.]')
            .catch((error: unknown) => this.failure(error));
        if (outcome.kind !== 'speech') return this.reply(outcome, { index: 0 });
        return photoAnswer({ text: outcome.text, url: outcome.stream.url });
    }

    async chatStart(timeZone?: string | null): Promise<Reply> {
        this.zone(timeZone);
        const notes = this.outbox.splice(0);
        if (!notes.length) return failed('chatstart', 'Nothing to say right now');
        const outcome = await this.start()
            .prompt(`${combined(notes)}\n\n${tellNow}`)
            .catch((error: unknown) => this.failure(error));
        if (outcome.kind === 'speech') return chatStart(outcome.stream.url);
        this.outbox.unshift(...notes);
        return failed('chatstart', 'Nothing to say right now');
    }

    async powerOn(timeZone?: string | null): Promise<Reply> {
        this.zone(timeZone);
        return this.oneShot('poweronvoice', '[You just powered on. Say a very short hello.]', 'poweron');
    }

    async readAloud(text: string): Promise<Reply> {
        return this.oneShot('tts', `[Read this aloud exactly, word for word, nothing else] ${text.slice(0, 1000)}`, 'tts');
    }

    private async oneShot(tag: string, prompt: string, kind: 'tts' | 'poweron'): Promise<Reply> {
        const outcome = await this.start(true)
            .prompt(prompt, kind)
            .catch((error: unknown) => this.failure(error));
        return outcome.kind === 'speech' ? tagged(tag, { url: outcome.stream.url }) : failed(tag, 'Speech is unavailable');
    }

    tell(note: string): 'now' | 'later' {
        if (this.conversation?.active) {
            this.conversation.tell(note);
            return 'now';
        }
        this.outbox.push(note);
        this.host.changed();
        return 'later';
    }

    say(text: string): 'now' | 'later' {
        return this.tell(`[Say this to them, naturally and in your own words] ${text.slice(0, 2000)}`);
    }

    playAction(behavior: string, params: Record<string, unknown>): boolean {
        const checked = checkAction(this.host.policy.config.aibi, behavior, params);
        if (!this.conversation?.active) return false;
        this.conversation.tell(
            `[Do this with your body now with aibi_action, saying nothing] ${checked.action.id} ${JSON.stringify(checked.params)}`,
        );
        return true;
    }

    async end(): Promise<void> {
        await this.conversation?.end();
    }

    private failure(error: unknown): Outcome {
        this.host.activity.add('warning', 'Gemini Live failed', error instanceof Error ? error.message : 'unknown error');
        return { kind: 'quit' };
    }

    private reply(outcome: Outcome, info: TurnInfo): Reply {
        const turn = { index: info.index, queryText: outcome.heard ?? '' };
        switch (outcome.kind) {
            case 'speech':
                return speak({ ...turn, text: outcome.text, url: outcome.stream.url });
            case 'action':
                return act(turn, outcome.behavior, outcome.params);
            case 'look':
                return recognize(turn);
            case 'connect':
            case 'farewell':
                return this.switching(turn, outcome);
            case 'unheard':
                return act(turn, 'voice_dont_understand', {});
            case 'quit':
                return info.chat ? chatMode(turn, 'quit') : this.quiet(turn);
            default:
                return this.quiet(turn);
        }
    }

    private switching(turn: { index: number; queryText: string }, outcome: Extract<Outcome, { kind: 'connect' | 'farewell' }>): Reply {
        const answer = { text: outcome.answer.text, url: outcome.answer.stream.url };
        return chatMode(turn, outcome.kind === 'connect' ? 'connect' : 'quit', answer);
    }

    private quiet(turn: { index: number; queryText: string }): Reply {
        return speak({ ...turn, text: '', url: this.host.speeches.pause().url });
    }

    private hooks(oneShot: boolean): ConversationHooks {
        const settings = () => this.host.policy.config;
        return {
            settings: () => settings().voice,
            system: () =>
                liveInstructions({
                    personality: settings().aibi.personality,
                    ownerName: settings().ownerName,
                    abilities: settings().aibi,
                    memory: this.host.memory.recent(settings().voice.memoryLines),
                    timeZone: this.timeZone,
                    robot: this.host.robot(),
                    responder: this.host.responder(),
                }),
            tools: () => (oneShot ? [] : liveTools(settings().aibi, this.host.responder())),
            tool: (name, args) => this.tool(name, args),
            heard: (text) => {
                this.host.memory.add('user', text);
                this.host.activity.add('heard', text);
            },
            said: (text) => {
                this.host.memory.add('aibi', text);
                this.host.activity.add('said', text);
            },
            working: () => this.open.size > 0,
            warn: (title, detail) => this.host.activity.add('warning', title, detail),
            ended: (conversation, untold) => {
                if (this.conversation !== conversation) return;
                this.outbox.unshift(...untold);
                this.conversation = undefined;
                this.leavingUntil = Date.now() + leaveForMs;
                this.host.activity.add('chat', 'Conversation ended');
                this.host.changed();
            },
        };
    }

    private tool(name: string, args: Record<string, unknown>): ToolAnswer | Promise<ToolAnswer> {
        const tools: Record<string, () => ToolAnswer | Promise<ToolAnswer>> = {
            aibi_action: () => this.action(args),
            look: () => ({ outcome: { kind: 'look' }, result: { status: 'taking a photo; it arrives next' } }),
            end_conversation: () => ({ end: true, result: { status: 'ending after this turn' } }),
            do_task: () => this.task(words(args.task).trim(), words(args.quick) === 'yes'),
            answer_request: () => this.settled(this.host.answer(words(args.request), words(args.answer))),
            assistant: () => this.settled(this.host.command(words(args.command), words(args.model))),
        };
        return tools[name]?.() ?? { result: { error: `Unknown tool ${name}` } };
    }

    private settled(work: Promise<string>): Promise<ToolAnswer> {
        return work
            .then((status): ToolAnswer => ({ scheduling: 'idle', result: { status } }))
            .catch((error: unknown): ToolAnswer => ({
                scheduling: 'idle',
                result: { error: error instanceof Error ? error.message : 'That did not work' },
            }));
    }

    private action(args: Record<string, unknown>): ToolAnswer {
        const options =
            typeof args.options === 'string' && args.options.trim() ? (JSON.parse(args.options) as Record<string, unknown>) : {};
        const { action, params } = checkAction(this.host.policy.config.aibi, words(args.action), options);
        this.host.activity.add('action', action.id, Object.keys(params).length ? JSON.stringify(params) : '');
        this.host.memory.add('note', `AIBI did ${action.id}${Object.keys(params).length ? ` ${JSON.stringify(params)}` : ''}.`);
        return { outcome: { kind: 'action', behavior: action.id, params }, result: { status: 'doing it now' } };
    }

    private task(text: string, quick: boolean): ToolAnswer {
        if (!text) return { result: { error: 'No task was given' } };
        if (!this.host.responder()) return { result: { error: 'Computer work is not available right now' } };
        if (this.running.has(text.toLowerCase())) return { result: { status: 'this task is already running; do not start it again' } };
        const conversation = randomUUID();
        let eventId = '';
        const event = this.host.queue.add(
            `aibi:${conversation}`,
            { kind: 'voice', text: text.slice(0, 4000), conversation },
            (content, quiet) => Promise.resolve(this.result(eventId, content, quiet === true)),
        );
        if (!event) return { result: { error: 'That could not be started' } };
        eventId = event.id;
        this.open.add(eventId);
        this.running.set(text.toLowerCase(), eventId);
        this.host.activity.add('task', 'Handed to the responder', text);
        this.onPublish?.(event);
        this.host.changed();
        return {
            spoken: true,
            holds: quick,
            scheduling: 'idle',
            result: { status: 'started and running in the background; tell them now, in a few words, that you are on it' },
        };
    }

    private result(eventId: string, content: string, quiet: boolean): { spoken: 'now' | 'later' | false } {
        if (quiet) {
            if (this.open.has(eventId)) this.host.activity.add('task', 'Progress', content);
            return { spoken: false };
        }
        this.open.delete(eventId);
        for (const [task, id] of this.running) if (id === eventId) this.running.delete(task);
        this.host.activity.add('task', 'Result', content);
        return { spoken: this.tell(`[Task update] ${content.slice(0, 4000)}\n${tellNow}`) };
    }
}
