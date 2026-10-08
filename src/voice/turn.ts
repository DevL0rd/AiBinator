import type { SpeechStream, Speeches } from '../aibi/speech.js';

type Spoken = { kind: 'speech'; stream: SpeechStream; text: string };

export type Outcome = (
    | Spoken
    | { kind: 'action'; behavior: string; params: Record<string, string | number> }
    | { kind: 'look' }
    | { kind: 'connect'; answer: Spoken }
    | { kind: 'farewell'; answer: Spoken }
    | { kind: 'unheard' }
    | { kind: 'quit' }
    | { kind: 'pause' }
) & { heard?: string };

const transcriptWaitMs = 250;

export class Turn {
    private resolve!: (outcome: Outcome) => void;
    readonly outcome: Promise<Outcome>;
    private stream?: SpeechStream;
    private decided = false;
    private waiting?: NodeJS.Timeout;
    private readonly timer: NodeJS.Timeout;
    said = '';
    heard = '';
    ending = false;
    answerFollows = false;
    keepOpen = false;

    constructor(
        private readonly speeches: Speeches,
        private readonly kind: 'tts' | 'poweron',
        timeoutMs: number,
        private readonly onTimeout: () => void,
    ) {
        this.outcome = new Promise((resolve) => (this.resolve = resolve));
        this.timer = setTimeout(() => {
            this.onTimeout();
            this.decide({ kind: 'pause' });
        }, timeoutMs);
    }

    get held(): SpeechStream | undefined {
        return this.keepOpen && this.stream?.open ? this.stream : undefined;
    }

    get speaking(): boolean {
        return Boolean(this.stream);
    }

    get settled(): boolean {
        return this.decided;
    }

    audio(pcm: Int16Array): void {
        if (!this.stream) {
            if (this.decided) return;
            this.stream = this.speeches.create(this.kind);
            this.waiting = setTimeout(() => this.speak(), this.said ? 0 : transcriptWaitMs);
        }
        this.stream.write(pcm);
    }

    text(fragment: string): void {
        this.said += fragment;
        if (this.waiting && wordy(this.said)) this.speak();
    }

    act(outcome: Extract<Outcome, { kind: 'action' | 'look' }>): boolean {
        if (this.stream || this.decided) return false;
        this.decide(outcome);
        return true;
    }

    complete(): void {
        if (this.stream && !this.decided) this.settle(this.stream);
        if (!this.keepOpen) this.stream?.end();
        if (!this.decided) this.decide({ kind: this.ending ? 'quit' : 'pause' });
    }

    private settle(stream: SpeechStream): void {
        if (this.said.trim() && !wordy(this.said)) stream.fail();
        else this.speak();
    }

    abort(): void {
        this.stream?.fail();
        if (!this.decided) this.decide({ kind: 'quit' });
    }

    private speak(): void {
        clearTimeout(this.waiting);
        this.waiting = undefined;
        if (this.decided || !this.stream || (this.said.trim() && !wordy(this.said))) return;
        this.decide({ kind: 'speech', stream: this.stream, text: this.said.replace(/\s+/g, ' ').trim() });
    }

    private decide(outcome: Outcome): void {
        if (this.decided) return;
        this.decided = true;
        clearTimeout(this.timer);
        this.resolve({ ...outcome, heard: this.heard.replace(/\s+/g, ' ').trim() });
    }
}

const wordy = (text: string) => /[\p{L}\p{N}]/u.test(text);
