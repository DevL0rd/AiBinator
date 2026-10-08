import { Behavior, FunctionResponseScheduling, GoogleGenAI, Modality, Type, type LiveServerMessage, type Session } from '@google/genai';

type ToolParameter = string | { description: string; choices?: readonly string[]; optional?: boolean };

export interface LiveTool {
    name: string;
    description: string;
    parameters?: Record<string, ToolParameter>;
}

export interface LiveOptions {
    model: string;
    voice: string;
    system: string;
    tools: LiveTool[];
    resume?: string;
}

export interface LiveEvents {
    audio(pcm: Int16Array): void;
    said(text: string): void;
    heard(text: string): void;
    turnComplete(): void;
    tool(id: string, name: string, args: Record<string, unknown>): void;
    resumable(handle: string): void;
    closed(reason: string): void;
}

export type ToolDelivery = { scheduling: 'silent' | 'idle' | 'interrupt'; more: boolean };

export interface Picture {
    data: Buffer;
    mimeType: string;
}

export interface LiveSession {
    startTurn(): void;
    audio(pcm: Int16Array): void;
    endTurn(): void;
    text(text: string, respond: boolean, image?: Picture): void;
    toolResult(id: string, name: string, response: Record<string, unknown>, delivery?: ToolDelivery): void;
    close(): void;
}

export interface VoiceProviders {
    readonly configured: boolean;
    live(options: LiveOptions, events: LiveEvents): Promise<LiveSession>;
}

const schedules = {
    silent: FunctionResponseScheduling.SILENT,
    idle: FunctionResponseScheduling.WHEN_IDLE,
    interrupt: FunctionResponseScheduling.INTERRUPT,
};

function decode(base64: string): Int16Array {
    const bytes = Buffer.from(base64, 'base64');
    return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

type Content = NonNullable<LiveServerMessage['serverContent']>;
type Call = NonNullable<NonNullable<LiveServerMessage['toolCall']>['functionCalls']>[number];

function play(parts: NonNullable<Content['modelTurn']>['parts'], events: LiveEvents): void {
    for (const part of parts ?? []) if (part.inlineData?.data) events.audio(decode(part.inlineData.data));
}

function transcripts(content: Content, events: LiveEvents): void {
    const heard = content.inputTranscription?.text;
    const said = content.outputTranscription?.text;
    if (heard) events.heard(heard);
    if (said) events.said(said);
}

function call(item: Call, events: LiveEvents): void {
    events.tool(item.id ?? '', item.name ?? '', item.args ?? {});
}

function resumption(update: LiveServerMessage['sessionResumptionUpdate'], events: LiveEvents): void {
    if (update?.resumable && update.newHandle) events.resumable(update.newHandle);
}

function route(message: LiveServerMessage, events: LiveEvents): void {
    const content = message.serverContent;
    if (content) {
        play(content.modelTurn?.parts, events);
        transcripts(content, events);
    }
    for (const item of message.toolCall?.functionCalls ?? []) call(item, events);
    if (content?.turnComplete) events.turnComplete();
    resumption(message.sessionResumptionUpdate, events);
}

function parameter(value: ToolParameter) {
    const spec = typeof value === 'string' ? { description: value } : value;
    return { type: Type.STRING, description: spec.description, ...(spec.choices ? { enum: [...spec.choices] } : {}) };
}

function declaration(tool: LiveTool) {
    const entries = Object.entries(tool.parameters ?? {});
    return {
        name: tool.name,
        description: tool.description,
        behavior: Behavior.NON_BLOCKING,
        ...(entries.length
            ? {
                  parameters: {
                      type: Type.OBJECT,
                      properties: Object.fromEntries(entries.map(([key, value]) => [key, parameter(value)])),
                      required: entries.filter(([, value]) => typeof value === 'string' || !value.optional).map(([key]) => key),
                  },
              }
            : {}),
    };
}

const pcmBase64 = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');

function wrap(session: Session): LiveSession {
    return {
        startTurn: () => session.sendRealtimeInput({ activityStart: {} }),
        audio: (pcm) => session.sendRealtimeInput({ audio: { data: pcmBase64(pcm), mimeType: 'audio/pcm;rate=16000' } }),
        endTurn: () => session.sendRealtimeInput({ activityEnd: {} }),
        text: (text, respond, image) =>
            session.sendClientContent({
                turns: [
                    {
                        role: 'user',
                        parts: [
                            ...(image ? [{ inlineData: { data: image.data.toString('base64'), mimeType: image.mimeType } }] : []),
                            { text },
                        ],
                    },
                ],
                turnComplete: respond,
            }),
        toolResult: (id, name, response, delivery = { scheduling: 'silent', more: false }) =>
            session.sendToolResponse({
                functionResponses: [{ id, name, response, scheduling: schedules[delivery.scheduling], willContinue: delivery.more }],
            }),
        close: () => session.close(),
    };
}

export class Gemini implements VoiceProviders {
    constructor(private readonly key: () => string | undefined) {}

    get configured(): boolean {
        return Boolean(this.key());
    }

    async live(options: LiveOptions, events: LiveEvents): Promise<LiveSession> {
        const apiKey = this.key();
        if (!apiKey) throw new Error('Add a Google Gemini API key in the setup app to talk with AIBI');
        const ai = new GoogleGenAI({ apiKey });
        const session = await ai.live.connect({
            model: options.model,
            config: {
                responseModalities: [Modality.AUDIO],
                systemInstruction: options.system,
                ...(options.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } } } : {}),
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
                contextWindowCompression: { slidingWindow: {} },
                sessionResumption: options.resume ? { handle: options.resume } : {},
                tools: options.tools.length ? [{ functionDeclarations: options.tools.map(declaration) }] : [],
            },
            callbacks: {
                onmessage: (message) => route(message, events),
                onerror: () => undefined,
                onclose: (event) => events.closed(event.reason || 'closed'),
            },
        });
        return wrap(session);
    }
}
