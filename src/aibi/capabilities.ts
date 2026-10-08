import { z } from 'zod';
import catalog from './capabilities.json' with { type: 'json' };

const paramSchema = z.union([z.array(z.union([z.string(), z.number()])), z.string()]);
const actionSchema = z.object({
    id: z.string().min(1),
    description: z.string().default(''),
    instructions: z.string().default(''),
    valid_params: z.record(z.string(), paramSchema).default({}),
});
const catalogSchema = z.object({ actions: z.array(actionSchema), animations: z.array(z.string()) });

export type Action = { id: string; description: string; instructions: string; params: Record<string, z.infer<typeof paramSchema>> };
export type Params = Record<string, string | number>;

const raw = catalogSchema.parse(catalog);

export const actions: readonly Action[] = Object.freeze(
    [...new Map(raw.actions.map((row) => [row.id, row])).values()]
        .map((row) => ({ id: row.id, description: row.description, instructions: row.instructions, params: row.valid_params }))
        .sort((a, b) => a.id.localeCompare(b.id)),
);
export const animations: readonly string[] = Object.freeze([...new Set(raw.animations)].sort());
export const reservedActions = new Set(['ability_chatgpt', 'interact_recognize']);
export const usableActions: readonly string[] = Object.freeze(
    actions.filter((action) => !reservedActions.has(action.id)).map((action) => action.id),
);

export interface Abilities {
    actions: readonly string[];
    animations: readonly string[];
}

export function enabledActions(abilities: Abilities): Action[] {
    const enabled = new Set(abilities.actions);
    return actions.filter((action) => enabled.has(action.id) && !reservedActions.has(action.id));
}

export function enabledAnimations(abilities: Abilities): string[] {
    const chosen = new Set(abilities.animations);
    return animations.filter((name) => chosen.has(name));
}

function allowed(rule: z.infer<typeof paramSchema>, value: unknown, animationNames: Set<string>): boolean {
    if (Array.isArray(rule)) return rule.some((choice) => String(choice) === String(value));
    if (rule === 'number') return Number.isFinite(Number(value));
    if (rule === 'number 1-12') return Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 12;
    if (rule === 'HH:mm') return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (rule === 'string') return typeof value === 'string' && animationNames.has(value);
    return false;
}

function typed(rule: z.infer<typeof paramSchema>, value: unknown): string | number {
    if (Array.isArray(rule)) return rule.find((choice) => String(choice) === String(value)) ?? String(value);
    return rule.startsWith('number') ? Number(value) : String(value);
}

export function checkAction(abilities: Abilities, id: string, params: Record<string, unknown>): { action: Action; params: Params } {
    const action = enabledActions(abilities).find((item) => item.id === id);
    if (!action) throw new Error(`${id} is not an enabled AIBI action`);
    const animationNames = new Set(enabledAnimations(abilities));
    const result: Params = {};
    for (const [key, value] of Object.entries(params)) {
        const rule = action.params[key];
        if (rule === undefined || value === '' || value === undefined || value === null) continue;
        if (!allowed(rule, value, animationNames)) throw new Error(`${key}=${JSON.stringify(value)} is not valid for ${id}`);
        result[key] = typed(rule, value);
    }
    return { action, params: result };
}

export function describeRule(rule: z.infer<typeof paramSchema>): string {
    if (Array.isArray(rule)) return rule.join('|');
    return rule === 'string' ? 'animation name' : rule;
}
