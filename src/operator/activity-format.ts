export function activityLine(label: string): string {
    return label.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function toolLabel(name: string): string {
    const words = name
        .replace(/^mcp__/, '')
        .replace(/^plugin_[^_]+_/, '')
        .split('__')
        .at(-1)!
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .trim();
    return `Using ${words || 'a tool'}`;
}

export function progressPost(activity: boolean, text: string, quietSince: number, intervalSeconds: number): string | undefined {
    if (activity) return text.slice(0, 1900);
    return Date.now() - quietSince >= intervalSeconds * 1000 ? activityLine('Still working on it…') : undefined;
}
