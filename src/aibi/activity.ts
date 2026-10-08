import { z } from 'zod';
import { JsonFile } from './store.js';

const activityPath = '.data/aibi/activity.json';
const kinds = ['heard', 'said', 'action', 'chat', 'task', 'status', 'request', 'unknown', 'firmware', 'network', 'warning'] as const;
const entrySchema = z.object({
    id: z.number().int(),
    at: z.string(),
    kind: z.enum(kinds),
    title: z.string(),
    detail: z.string().default(''),
});
export type ActivityKind = (typeof kinds)[number];
export type ActivityEntry = z.infer<typeof entrySchema>;

export class ActivityLog {
    private entries: ActivityEntry[] = [];
    private next = 1;
    private readonly file: JsonFile<ActivityEntry[]>;
    onChange?: (entry: ActivityEntry) => void;

    constructor(
        private readonly capacity = 500,
        path = activityPath,
    ) {
        this.file = new JsonFile(path, () => this.entries);
    }

    async load(): Promise<void> {
        const parsed = z.array(entrySchema).safeParse(await this.file.read());
        this.entries = parsed.success ? parsed.data.slice(-this.capacity) : [];
        this.next = (this.entries.at(-1)?.id ?? 0) + 1;
    }

    add(kind: ActivityKind, title: string, detail = ''): ActivityEntry {
        const entry = { id: this.next++, at: new Date().toISOString(), kind, title: title.slice(0, 200), detail: detail.slice(0, 2000) };
        this.entries.push(entry);
        if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
        this.file.save();
        this.onChange?.(entry);
        return entry;
    }

    recent(limit = 50, kind?: ActivityKind): ActivityEntry[] {
        return (kind ? this.entries.filter((entry) => entry.kind === kind) : this.entries).slice(-limit);
    }

    clear(): number {
        const count = this.entries.length;
        this.entries = [];
        this.file.save();
        return count;
    }

    flushed(): Promise<void> {
        return this.file.flushed();
    }
}
