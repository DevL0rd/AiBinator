import { z } from 'zod';
import type { ConversationController } from './controller.js';
import type { ControllerStore } from './controller-state.js';
import type { ProviderTool } from './provider-adapter.js';

export function controllerTools(controller: ConversationController, store: ControllerStore): ProviderTool[] {
    const owner = (sessionId: string) => {
        const conversation = store.snapshot().conversations.find((item) => item.sessionId === sessionId);
        if (!conversation) throw new Error('Only a verified conversational controller can dispatch work');
        return conversation;
    };
    const assertTask = (sessionId: string, id: string) => {
        if (controller.getTaskStatus(id).conversationKey !== owner(sessionId).key) throw new Error('Task belongs to another conversation');
    };
    const tool = ownedTool(owner);
    return [
        tool(
            'start_task',
            'Hand big or long work to a worker: a separate assistant conversation on this computer that works on its own and reports its progress and result back to you. Give a short title and a complete brief. Check list_tasks first.',
            { title: z.string().min(1).max(120), prompt: z.string().min(1).max(32000) },
            async (args, sessionId) => ({ taskId: await controller.startTask(owner(sessionId).key, args.prompt, args.title) }),
        ),
        tool(
            'list_tasks',
            'List workers, running ones first: title, state, latest progress and a preview of the result. Check it before starting work and whenever someone asks how something is going.',
            {},
            (_args, sessionId) => Promise.resolve({ tasks: controller.tasks.list(owner(sessionId).key) }),
        ),
        tool(
            'get_task_status',
            'Read one task in full, including its brief and complete result.',
            { taskId: z.uuid() },
            (args, sessionId) => {
                assertTask(sessionId, args.taskId);
                return Promise.resolve(controller.getTaskStatus(args.taskId));
            },
        ),
        tool(
            'steer_task',
            'Send a worker a message: a correction while it runs, or follow-up work once it finished (it resumes with everything it already knows).',
            { taskId: z.uuid(), text: z.string().min(1).max(8000) },
            async (args, sessionId) => {
                assertTask(sessionId, args.taskId);
                return { sent: await controller.tasks.message(args.taskId, args.text, owner(sessionId).originEventId) };
            },
        ),
        tool(
            'cancel_task',
            'Stop one worker; the conversation and other workers keep going.',
            { taskId: z.uuid() },
            async (args, sessionId) => {
                assertTask(sessionId, args.taskId);
                await controller.cancelTask(args.taskId);
                return { cancelled: true };
            },
        ),
    ];
}
function ownedTool(owner: (sessionId: string) => unknown) {
    return <S extends z.ZodRawShape>(
        name: string,
        description: string,
        shape: S,
        execute: (args: z.infer<z.ZodObject<S>>, sessionId: string) => Promise<unknown>,
    ): ProviderTool => {
        const schema = z.object(shape).strict();
        return {
            name,
            description,
            inputShape: shape,
            inputSchema: z.toJSONSchema(schema),
            async call(args, sessionId) {
                try {
                    owner(sessionId);
                    return { success: true, text: JSON.stringify(await execute(schema.parse(args), sessionId)) };
                } catch {
                    return { success: false, text: 'Controller tool failed validation or ownership checks; no fallback action was taken.' };
                }
            },
        };
    };
}
