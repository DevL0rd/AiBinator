import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { JsonFile } from './store.js';

const memoryPath = '.data/aibi/memory.json';
const mediaDirectory = '.data/aibi/media';
const roles = ['user', 'aibi', 'note'] as const;
const lineSchema = z.object({
    id: z.number().int(),
    at: z.string(),
    role: z.enum(roles),
    text: z.string(),
    image: z.string().optional(),
});
export type Line = z.infer<typeof lineSchema>;
export type Role = (typeof roles)[number];

export function describeLine(line: Line, now = Date.now()): string {
    const minutes = Math.round((now - Date.parse(line.at)) / 60_000);
    const age = minutes < 1 ? 'just now' : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
    const who = { user: 'User', aibi: 'You (AIBI)', note: 'Note' }[line.role];
    return `[${line.at.slice(0, 16).replace('T', ' ')} UTC, ${age}] ${who}: ${line.text}${line.image ? ' [photo]' : ''}`;
}

export class Memory {
    private lines: Line[] = [];
    private next = 1;
    private readonly file: JsonFile<Line[]>;
    onChange?: () => void;

    constructor(
        private readonly capacity = 2000,
        path = memoryPath,
        private readonly media = mediaDirectory,
    ) {
        this.file = new JsonFile(path, () => this.lines);
    }

    async load(): Promise<void> {
        const parsed = z.array(lineSchema).safeParse(await this.file.read());
        this.lines = parsed.success ? parsed.data.slice(-this.capacity) : [];
        this.next = (this.lines.at(-1)?.id ?? 0) + 1;
    }

    add(role: Role, text: string, image?: string): Line | undefined {
        const clean = text.replace(/\s+/g, ' ').trim();
        if (!clean && !image) return undefined;
        const line: Line = { id: this.next++, at: new Date().toISOString(), role, text: clean.slice(0, 4000), ...(image ? { image } : {}) };
        this.lines.push(line);
        for (const dropped of this.lines.splice(0, Math.max(0, this.lines.length - this.capacity))) void this.removeImage(dropped);
        this.changed();
        return line;
    }

    async image(data: Buffer, extension: string): Promise<string> {
        await mkdir(this.media, { recursive: true, mode: 0o700 });
        const path = join(this.media, `${Date.now()}-${randomUUID()}.${extension}`);
        await writeFile(path, data, { mode: 0o600 });
        return path;
    }

    recent(limit: number, since?: string): Line[] {
        return this.lines.filter((line) => !since || line.at > since).slice(-limit);
    }

    page(before: number | undefined, limit: number): Line[] {
        return this.lines.filter((line) => before === undefined || line.id < before).slice(-limit);
    }

    get size(): number {
        return this.lines.length;
    }

    async remove(id: number): Promise<boolean> {
        const index = this.lines.findIndex((line) => line.id === id);
        if (index === -1) return false;
        const [line] = this.lines.splice(index, 1);
        await this.removeImage(line!);
        this.changed();
        return true;
    }

    async clear(): Promise<number> {
        const count = this.lines.length;
        this.lines = [];
        await rm(this.media, { recursive: true, force: true });
        this.changed();
        return count;
    }

    flushed(): Promise<void> {
        return this.file.flushed();
    }

    private async removeImage(line: Line): Promise<void> {
        if (line.image?.startsWith(`${this.media}/`)) await rm(line.image, { force: true });
    }

    private changed(): void {
        this.file.save();
        this.onChange?.();
    }
}
