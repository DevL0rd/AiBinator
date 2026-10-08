import { BigEndianPcm, SpeechGate } from '../aibi/audio.js';
import type { SpeechStream, Speeches } from '../aibi/speech.js';
import type { LiveSession, LiveTool, Picture, VoiceProviders } from './gemini.js';
import { Errand } from './errand.js';
import { Turn, type Outcome } from './turn.js';

interface ConversationSettings {
    liveModel: string;
    liveVoice: string;
    idleSeconds: number;
    speechThreshold: number;
}

export interface ToolAnswer {
    outcome?: Extract<Outcome, { kind: 'action' | 'look' }>;
    end?: boolean;
    spoken?: boolean;
    holds?: boolean;
    result: Record<string, unknown>;
    scheduling?: 'silent' | 'idle';
}

export interface ConversationHooks {
    settings(): ConversationSettings;
    system(): string;
    tools(): LiveTool[];
    tool(name: string, args: Record<string, unknown>): ToolAnswer | Promise<ToolAnswer>;
    heard(text: string): void;
    said(text: string): void;
    working(): boolean;
    warn(title: string, detail: string): void;
    ended(conversation: Conversation, untold: string[]): void;
}

const turnTimeoutMs = 15_000;
const waiting =
    '[This is waiting for them. First do what they ask now; then mention briefly that you have an update and tell it if they want.]';
const farewell =
    /^(?:ok(?:ay)?[,.!]?\s*)?(?:good ?bye|bye(?: for now)?|see you(?: later| soon)?|talk (?:to you )?(?:later|soon)|take care|catch you later|later)\b[^?]{0,40}$/i;

export class Conversation {
    private session?: Promise<LiveSession>;
    private resume?: string;
    private turn?: Turn;
    private spare?: Turn;
    private errand?: Errand;
    private errandTurn = false;
    private queued?: Extract<Outcome, { kind: 'action' }>;
    private readonly untold: string[] = [];
    private ending = false;
    private closed = false;
    private turns = 0;
    private reconnected = false;
    private chat = false;
    private idle?: NodeJS.Timeout;

    constructor(
        private readonly providers: VoiceProviders,
        private readonly speeches: Speeches,
        private readonly hooks: ConversationHooks,
        private readonly oneShot = false,
    ) {}

    get active(): boolean {
        return !this.closed;
    }

    open(): Promise<LiveSession> {
        this.session ??= this.connect().catch((error: unknown) => {
            void this.end();
            throw error;
        });
        return this.session;
    }

    private connect(): Promise<LiveSession> {
        const settings = this.hooks.settings();
        const resume = this.resume;
        return this.providers.live(
            {
                model: settings.liveModel,
                voice: settings.liveVoice,
                system: this.hooks.system(),
                tools: this.hooks.tools(),
                ...(resume ? { resume } : {}),
            },
            {
                audio: (pcm) => (this.speaker() ?? this.current()).audio(pcm),
                said: (text) => (this.speaker() ?? this.current()).text(text),
                heard: (text) => {
                    if (this.turn) this.turn.heard += text;
                },
                turnComplete: () => this.complete(),
                tool: (id, name, args) => this.tool(id, name, args),
                resumable: (handle) => (this.resume = handle),
                closed: (reason) => void this.dropped(reason),
            },
        );
    }

    private speaker(): Errand | undefined {
        return this.turn ? undefined : this.errand;
    }

    private current(): Turn {
        if (this.turn) return this.turn;
        this.spare ??= new Turn(this.speeches, 'tts', turnTimeoutMs, () => undefined);
        return this.spare;
    }

    async listen(chunks: AsyncIterable<Buffer>, chat: boolean): Promise<Outcome> {
        this.chat = chat;
        if (this.ending) {
            for await (const chunk of chunks) void chunk;
            return this.untold.length ? this.tellUntold() : this.quit();
        }
        const session = await this.open();
        const pcm = new BigEndianPcm();
        const gate = new SpeechGate(this.hooks.settings().speechThreshold);
        let turn: Turn | undefined;
        for await (const chunk of chunks) {
            for (const released of gate.push(pcm.push(chunk))) {
                turn ??= this.begin(session);
                session.audio(released);
            }
        }
        if (turn) session.endTurn();
        return this.enter(await (turn ? this.finish(turn) : this.silent()));
    }

    private silent(): Outcome | Promise<Outcome> {
        if (this.queued) return this.takeQueued();
        if (this.untold.length) return this.tellUntold();
        if (!this.chat) return { kind: 'unheard' };
        return this.turns === 0 ? this.quit() : { kind: 'pause' };
    }

    private dismiss(outcome: Extract<Outcome, { kind: 'speech' }>): Outcome {
        outcome.stream.fail();
        this.markEnding();
        return { kind: 'pause', heard: outcome.heard };
    }

    private enter(outcome: Outcome): Outcome {
        if (outcome.kind !== 'speech') return outcome;
        if (this.chat) return this.ending && !this.untold.length ? { kind: 'farewell', answer: outcome, heard: outcome.heard } : outcome;
        if (this.errandTurn) return outcome;
        if (this.ending || this.closed || farewell.test(outcome.text)) return this.dismiss(outcome);
        this.chat = true;
        return { kind: 'connect', answer: outcome, heard: outcome.heard };
    }

    private begin(session: LiveSession): Turn {
        this.turns++;
        this.queued = undefined;
        this.spare = undefined;
        if (this.untold.length) session.text(`${combined(this.untold.splice(0))}\n\n${waiting}`, false);
        const turn = new Turn(this.speeches, 'tts', turnTimeoutMs, () =>
            this.hooks.warn('Gemini did not answer in time', 'AIBI was told to keep listening.'),
        );
        this.turn = turn;
        session.startTurn();
        return turn;
    }

    async prompt(text: string, kind: 'tts' | 'poweron' = 'tts', image?: Picture): Promise<Outcome> {
        const session = await this.open();
        this.turns++;
        this.touch();
        const turn = new Turn(this.speeches, kind, turnTimeoutMs, () =>
            this.hooks.warn('Gemini did not answer in time', text.slice(0, 120)),
        );
        this.turn = turn;
        session.text(text, true, image);
        return this.finish(turn);
    }

    photo(image: Buffer, mimeType: string, text: string): Promise<Outcome> {
        return this.prompt(text, 'tts', { data: image, mimeType });
    }

    private async finish(turn: Turn): Promise<Outcome> {
        const outcome = await turn.outcome;
        if (outcome.kind === 'quit') void this.end();
        return outcome;
    }

    private touch(): void {
        clearTimeout(this.idle);
        if (this.oneShot || this.closed) return;
        this.idle = setTimeout(
            () => (this.hooks.working() || this.turn ? this.touch() : void this.end()),
            this.hooks.settings().idleSeconds * 1000,
        );
        this.idle.unref();
    }

    private tellUntold(): Promise<Outcome> {
        return this.prompt(combined(this.untold.splice(0)));
    }

    private takeQueued(): Outcome {
        const queued = this.queued!;
        this.queued = undefined;
        return queued;
    }

    tell(note: string): void {
        if (this.closed) return;
        if (this.errand) return this.sayNow(note, this.errand);
        this.untold.push(note);
    }

    private sayNow(note: string, errand: Errand): void {
        errand.finish();
        void this.session?.then((session) => session.text(note, true)).catch(() => errand.release());
    }

    private quit(): Outcome {
        void this.end();
        return { kind: 'quit' };
    }

    private complete(): void {
        if (!this.turn && this.errand) return this.errand.complete();
        if (!this.turn) return this.discardSpare();
        const turn = this.turn;
        if (turn.answerFollows && !turn.speaking) {
            turn.answerFollows = false;
            return;
        }
        this.turn = undefined;
        this.record(turn);
        turn.complete();
        if (turn.held) this.hold(turn.held);
        if ((this.ending && !this.untold.length) || this.oneShot) void this.end();
    }

    private hold(stream: SpeechStream): void {
        this.errand = new Errand(
            stream,
            (text) => this.hooks.said(text),
            () => {
                this.errand = undefined;
                this.errandTurn = false;
            },
        );
    }

    private discardSpare(): void {
        this.spare?.abort();
        this.spare = undefined;
    }

    private record(turn: Turn): void {
        const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
        if (clean(turn.heard)) this.hooks.heard(clean(turn.heard));
        if (clean(turn.said)) this.hooks.said(clean(turn.said));
        if (clean(turn.heard) || clean(turn.said)) this.touch();
        if (farewell.test(clean(turn.said))) this.markEnding();
    }

    private tool(id: string, name: string, args: Record<string, unknown>): void {
        let answer: ToolAnswer | Promise<ToolAnswer>;
        try {
            answer = this.hooks.tool(name, args);
        } catch (error) {
            answer = failedTool(error);
        }
        if (!(answer instanceof Promise)) return this.applyTool(id, name, answer);
        if (this.turn && !this.turn.speaking) this.turn.answerFollows = true;
        void answer.catch(failedTool).then((settled) => this.applyTool(id, name, settled));
    }

    private applyTool(id: string, name: string, answer: ToolAnswer): void {
        if (answer.end) this.markEnding();
        if (this.turn) this.shape(this.turn, answer);
        const told = answer.outcome && !this.deliver(answer.outcome) ? late(answer.outcome) : answer;
        void this.session
            ?.then((session) => session.toolResult(id, name, told.result, { scheduling: told.scheduling ?? 'silent', more: false }))
            .catch(() => undefined);
    }

    private shape(turn: Turn, answer: ToolAnswer): void {
        if (answer.spoken && !turn.speaking) turn.answerFollows = true;
        if (!answer.holds || this.chat) return;
        turn.keepOpen = true;
        this.errandTurn = true;
    }

    private markEnding(): void {
        this.ending = true;
        if (this.turn) this.turn.ending = true;
    }

    private deliver(outcome: Extract<Outcome, { kind: 'action' | 'look' }>): boolean {
        if (this.turn?.act(outcome)) return true;
        if (outcome.kind !== 'action') return false;
        this.queued = outcome;
        return true;
    }

    private async dropped(reason: string): Promise<void> {
        if (this.closed) return;
        this.session = undefined;
        if (this.reconnected || !this.resume) {
            this.hooks.warn('Gemini Live closed the conversation', reason);
            return this.end();
        }
        this.reconnected = true;
        await this.open().catch(() => undefined);
    }

    async end(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.idle);
        this.turn?.abort();
        this.spare?.abort();
        this.errand?.release();
        const session = await this.session?.catch(() => undefined);
        session?.close();
        this.hooks.ended(this, this.untold.splice(0));
    }
}

const tooLate: Record<string, string> = {
    look: 'Too late for this turn: call look before saying anything, then wait for the photo.',
    action: 'Not done: you were already talking.',
};

function late(outcome: Extract<Outcome, { kind: 'action' | 'look' }>): ToolAnswer {
    return { result: { error: tooLate[outcome.kind] } };
}

function failedTool(error: unknown): ToolAnswer {
    return { result: { error: error instanceof Error ? error.message : 'That did not work' } };
}

export function combined(notes: string[]): string {
    const joined = notes.join('\n\n');
    return notes.length > 1
        ? `${joined}\n\n[Several updates arrived together: tell them as one short message that keeps every important detail.]`
        : joined;
}
