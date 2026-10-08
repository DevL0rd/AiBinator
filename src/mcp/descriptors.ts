type Descriptor = { _meta?: { securitySchemes?: unknown }; securitySchemes?: unknown };
type Envelope = { result?: { tools?: Descriptor[] } };

function declareSchemes(value: Envelope): Envelope {
    if (!Array.isArray(value.result?.tools)) return value;
    for (const tool of value.result.tools) {
        if (Array.isArray(tool._meta?.securitySchemes)) tool.securitySchemes = tool._meta.securitySchemes;
    }
    return value;
}

function eventData(line: string): string {
    if (!line.startsWith('data: ')) return line;
    try {
        return `data: ${JSON.stringify(declareSchemes(JSON.parse(line.slice(6)) as Envelope))}`;
    } catch {
        return line;
    }
}

function eventRewriter(): TransformStream<string, string> {
    let pending = '';
    return new TransformStream({
        transform(chunk, controller) {
            const lines = (pending + chunk).split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) controller.enqueue(`${eventData(line)}\n`);
        },
        flush(controller) {
            if (pending) controller.enqueue(eventData(pending));
        },
    });
}

async function rpcMethod(request: Request): Promise<unknown> {
    try {
        return request.headers.get('mcp-method') ?? ((await request.clone().json()) as { method?: unknown }).method;
    } catch {
        return undefined;
    }
}

export async function descriptorResponse(
    request: Request,
    fetch: (request: Request) => Promise<Response>,
    oauth: boolean,
): Promise<Response> {
    const method = oauth ? await rpcMethod(request) : undefined;
    const response = await fetch(request);
    if (method !== 'tools/list' || response.status !== 200) return response;
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('application/json') && !type.includes('text/event-stream')) return response;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    if (type.includes('text/event-stream') && response.body)
        return new Response(
            response.body.pipeThrough(new TextDecoderStream()).pipeThrough(eventRewriter()).pipeThrough(new TextEncoderStream()),
            {
                status: response.status,
                statusText: response.statusText,
                headers,
            },
        );
    const encoded = JSON.stringify(declareSchemes(JSON.parse(await response.text()) as Envelope));
    return new Response(encoded, { status: response.status, statusText: response.statusText, headers });
}
