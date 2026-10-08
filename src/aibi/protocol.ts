import { randomUUID } from 'node:crypto';
import type { Params } from './capabilities.js';

export type Reply = Record<string, unknown>;

export interface Turn {
    queryText?: string;
    index?: number;
}

function envelope(turn: Turn, behavior: string, intent: string, params: unknown): Reply {
    return {
        queryId: randomUUID(),
        queryResult: {
            resultCode: randomUUID(),
            queryText: turn.queryText ?? '',
            intent: { name: intent, confidence: 1 },
            rec_behavior: behavior,
            behavior_paras: params,
        },
        languageCode: 'en',
        index: turn.index ?? 0,
    };
}

export interface Speech extends Turn {
    text: string;
    url: string;
}

export function speak(speech: Speech): Reply {
    return envelope(speech, 'interact_speak', 'local_ai_speak', {
        txt: speech.text,
        url: speech.url,
        pre_animation: '',
        post_animation: '',
        post_behavior: '',
        sentiment: '',
        listen: 0,
    });
}

export function photoAnswer(speech: Speech): Reply {
    const reply = speak(speech);
    const result = reply.queryResult as Record<string, unknown>;
    result.intent = { name: 'chatgpt_speak', confidence: 1 };
    result.photo_type = '';
    delete reply.index;
    return reply;
}

export function act(turn: Turn, behavior: string, params: Params): Reply {
    return envelope(turn, behavior, behavior, Object.keys(params).length ? params : []);
}

export function chatMode(turn: Turn, type: 'connect' | 'quit', answer?: { text: string; url: string }): Reply {
    const heard = type === 'quit' && !turn.queryText ? { ...turn, queryText: 'Goodbye' } : turn;
    return envelope(heard, 'ability_chatgpt', 'ability_chatgpt', answer ? { type, txt: answer.text, url: answer.url } : { type });
}

export function recognize(turn: Turn): Reply {
    return envelope(turn, 'interact_recognize', 'ability_photo_recog', []);
}

export function tagged(responsetag: string, extra: Record<string, unknown> = {}): Reply {
    return { errcode: 0, errmsg: 'OK', responsetag, ...extra };
}

export function chatStart(url: string): Reply {
    return { errcode: 0, url, errmsg: 'OK', responsetag: 'chatstart' };
}

export function failed(responsetag: string, errmsg: string): Reply {
    return { errcode: 500, errmsg, responsetag };
}

export function encode(status: string, body: Buffer | Reply, headers: Record<string, string> = {}): Buffer {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    const all = {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(payload.length),
        Connection: 'keep-alive',
        ...headers,
    };
    const head = [status, ...Object.entries(all).map(([key, value]) => `${key}: ${value}`), '', ''].join('\r\n');
    return Buffer.concat([Buffer.from(head, 'utf8'), payload]);
}

export interface Summary {
    queryText: string;
    text: string;
    behavior: string;
    params: Record<string, unknown>;
    url: string;
}

export function summarize(reply: Reply): Summary {
    const result = (reply.queryResult ?? {}) as Record<string, unknown>;
    const params = result.behavior_paras && !Array.isArray(result.behavior_paras) ? (result.behavior_paras as Record<string, unknown>) : {};
    return {
        queryText: typeof result.queryText === 'string' ? result.queryText : '',
        text: typeof params.txt === 'string' ? params.txt : '',
        behavior: typeof result.rec_behavior === 'string' ? result.rec_behavior : '',
        params,
        url: typeof params.url === 'string' ? params.url : typeof reply.url === 'string' ? reply.url : '',
    };
}
