export function canonical(value: unknown, undefinedAsNull = false): string {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, undefinedAsNull)).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, undefinedAsNull)}`)
            .join(',')}}`;
    }
    const encoded = JSON.stringify(value);
    return undefinedAsNull ? (encoded ?? 'null') : encoded;
}

export function httpsOrigin(value: string): string | undefined {
    try {
        const url = new URL(value);
        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            (url.pathname !== '/' && url.pathname !== '') ||
            url.search ||
            url.hash
        )
            return undefined;
        return url.origin;
    } catch {
        return undefined;
    }
}
