import type { SpeechStream } from '../aibi/speech.js';

export class Errand {
    private said = '';
    private finishing = false;

    constructor(
        private readonly stream: SpeechStream,
        private readonly spoke: (text: string) => void,
        private readonly released: () => void,
    ) {}

    audio(pcm: Int16Array): void {
        this.stream.write(pcm);
    }

    text(fragment: string): void {
        this.said += fragment;
    }

    finish(): void {
        this.finishing = true;
    }

    complete(): void {
        const said = this.said.replace(/\s+/g, ' ').trim();
        this.said = '';
        if (said) this.spoke(said);
        if (this.finishing) this.release();
    }

    release(): void {
        this.stream.end();
        this.released();
    }
}
