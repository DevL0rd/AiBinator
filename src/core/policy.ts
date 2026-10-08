import type { PolicyConfig, Scope } from './config.js';

export class Policy {
    private readonly listeners = new Set<(previous: PolicyConfig) => void>();

    constructor(public config: PolicyConfig) {}

    update(next: PolicyConfig): void {
        const previous = this.config;
        this.config = next;
        for (const listener of this.listeners) {
            try {
                listener(previous);
            } catch {
                console.error('A part of AiBinator could not apply the new settings');
            }
        }
    }

    onChange(listener: (previous: PolicyConfig) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    allows(scope: Scope): boolean {
        return this.config.scopes.includes(scope);
    }

    assertScope(scope: Scope): void {
        if (!this.allows(scope)) throw new Error(`The ${scope} ability is switched off in AiBinator`);
    }

    ownerNote(): string {
        const name = this.config.ownerName;
        return name ? `AIBI belongs to ${name}, who owns this computer and this AiBinator.` : '';
    }
}
