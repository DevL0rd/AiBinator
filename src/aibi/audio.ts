import { Mp3Encoder } from '@breezystack/lamejs';

const geminiRate = 24_000;
const mp3Rate = 32_000;
const mp3Kbps = 64;
const frameSamples = 320;

export class BigEndianPcm {
    private carry?: number;

    push(chunk: Buffer): Int16Array {
        const bytes = this.carry === undefined ? chunk : Buffer.concat([Buffer.from([this.carry]), chunk]);
        const usable = bytes.length - (bytes.length % 2);
        this.carry = usable < bytes.length ? bytes[usable] : undefined;
        const samples = new Int16Array(usable / 2);
        for (let index = 0; index < samples.length; index++) samples[index] = bytes.readInt16BE(index * 2);
        return samples;
    }
}

export function rms(samples: Int16Array): number {
    if (!samples.length) return 0;
    let total = 0;
    for (const sample of samples) total += sample * sample;
    return Math.sqrt(total / samples.length);
}

export class SpeechGate {
    private pending: Int16Array[] = [];
    private loudFrames = 0;
    private remainder = new Int16Array(0);
    heard = false;
    peak = 0;

    constructor(
        private readonly threshold: number,
        private readonly framesNeeded = 4,
        private readonly preRoll = 12,
    ) {}

    push(samples: Int16Array): Int16Array[] {
        if (this.heard) return [samples];
        this.pending.push(samples);
        this.measure(samples);
        if (!this.heard) {
            this.trim();
            return [];
        }
        const released = this.pending;
        this.pending = [];
        return released;
    }

    private measure(samples: Int16Array): void {
        const joined = new Int16Array(this.remainder.length + samples.length);
        joined.set(this.remainder);
        joined.set(samples, this.remainder.length);
        let offset = 0;
        for (; offset + frameSamples <= joined.length; offset += frameSamples) {
            const level = rms(joined.subarray(offset, offset + frameSamples));
            this.peak = Math.max(this.peak, level);
            this.loudFrames = level >= this.threshold ? this.loudFrames + 1 : 0;
            if (this.loudFrames >= this.framesNeeded) this.heard = true;
        }
        this.remainder = joined.slice(offset);
    }

    private trim(): void {
        let samples = this.pending.reduce((total, chunk) => total + chunk.length, 0);
        while (this.pending.length > 1 && samples - this.pending[0]!.length >= this.preRoll * frameSamples) {
            samples -= this.pending.shift()!.length;
        }
    }
}

export class Resampler {
    private previous = 0;
    private position = 0;
    private readonly step: number;

    constructor(from: number, to: number) {
        this.step = from / to;
    }

    push(input: Int16Array): Int16Array {
        if (!input.length) return input;
        const source = new Int16Array(input.length + 1);
        source[0] = this.previous;
        source.set(input, 1);
        const output: number[] = [];
        let at = this.position;
        while (at < source.length - 1) {
            const index = Math.floor(at);
            const fraction = at - index;
            output.push(Math.round(source[index]! * (1 - fraction) + source[index + 1]! * fraction));
            at += this.step;
        }
        this.position = at - (source.length - 1);
        this.previous = input[input.length - 1]!;
        return Int16Array.from(output);
    }
}

export class Mp3Stream {
    private readonly encoder = new Mp3Encoder(1, mp3Rate, mp3Kbps);
    private readonly resampler = new Resampler(geminiRate, mp3Rate);

    encode(pcm: Int16Array): Buffer {
        return Buffer.from(this.encoder.encodeBuffer(this.resampler.push(pcm)));
    }

    finish(): Buffer {
        return Buffer.from(this.encoder.flush());
    }
}

export function silence(milliseconds: number): Buffer {
    const stream = new Mp3Stream();
    const samples = new Int16Array(Math.round((geminiRate * milliseconds) / 1000));
    return Buffer.concat([stream.encode(samples), stream.finish()]);
}
