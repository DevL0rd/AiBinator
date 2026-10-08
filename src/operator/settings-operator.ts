import { group } from './settings-types.js';

export const operatorSettings = [
    ...group('operator', 'responders', 'next-request', [
        {
            path: 'mode',
            label: 'Assistant',
            description:
                'The one assistant that does the work AIBI’s voice hands over. Saving switches to it once current work finishes and connects its app if needed.',
            kind: 'choice',
            choices: ['claude-session', 'codex-local', 'manual-mcp'],
            defaultValue: 'claude-session',
        },
        {
            path: 'workspace',
            label: 'Working directory',
            description: 'Directory used for local CLI execution. Validate filesystem access before applying.',
            kind: 'text',
            sensitive: true,
        },
        {
            path: 'timeoutSeconds',
            label: 'Execution time limit',
            description:
                '0 means no time limit; otherwise 30–1800 seconds. Background assistants only; Claude Desktop replies are not cut off.',
            kind: 'integer',
            minimum: 0,
            maximum: 1800,
            defaultValue: 0,
        },
    ]),
    ...group('operator', 'models', 'next-request', [
        {
            path: 'codexModel',
            label: 'Codex model',
            description: 'Models offered by your Codex account. Default uses Codex’s own choice.',
            kind: 'text',
        },
        {
            path: 'codexEffort',
            label: 'Codex reasoning',
            description: 'Reasoning levels the selected Codex model offers. Default uses the model’s own setting.',
            kind: 'text',
        },
        {
            path: 'claudeModel',
            label: 'Claude model',
            description:
                'Models your installed Claude Code offers, read live. Applies when the AiBinator conversation is created; change it in Claude for an existing one.',
            kind: 'text',
        },
        {
            path: 'claudeEffort',
            label: 'Claude thinking effort',
            description:
                'Thinking effort levels the selected Claude model offers. Default uses Claude’s own setting. Like the model, it applies when the AiBinator conversation is created; change it in Claude for an existing one.',
            kind: 'text',
        },
        {
            path: 'workerClaudeModel',
            label: 'Claude model for new chats',
            description:
                'The model for the Claude chats and workers the responder starts for big work. Default uses the responder’s Claude model.',
            kind: 'text',
        },
        {
            path: 'workerClaudeEffort',
            label: 'Claude thinking for new chats',
            description:
                'Thinking effort for the Claude chats and workers the responder starts. Default uses the responder’s effort, or the new chat model’s own setting when that model differs.',
            kind: 'text',
        },
        {
            path: 'workerCodexModel',
            label: 'Codex model for workers',
            description: 'The model for the Codex workers the responder starts for big work. Default uses the responder’s Codex model.',
            kind: 'text',
        },
        {
            path: 'workerCodexEffort',
            label: 'Codex reasoning for workers',
            description:
                'Reasoning for the Codex workers the responder starts. Default uses the responder’s reasoning, or the worker model’s own setting when that model differs.',
            kind: 'text',
        },
    ]),
    ...group('operator', 'responders', 'next-request', [
        {
            path: 'instructions',
            label: 'Extra instructions',
            description: 'Additional instructions for your assistant, maximum 8000 characters.',
            kind: 'text',
        },
        {
            path: 'progressSeconds',
            label: 'Progress interval',
            description:
                'Local acknowledgment immediately; progress every 15–600 seconds while work continues. Background assistants only; in Claude Desktop the assistant sends its own updates.',
            kind: 'integer',
            minimum: 15,
            maximum: 600,
            defaultValue: 60,
        },
        {
            path: 'shareConversation',
            label: 'Share the Coordinator with Discordinator',
            description:
                'Use the same Coordinator conversation as Discordinator, so one assistant with one memory handles both Discord and AIBI. Works when both use the same responder in Claude Desktop or the shared Codex service.',
            kind: 'boolean',
            defaultValue: true,
        },
        {
            path: 'backgroundOnly',
            label: 'Always run in the background',
            description: 'Use the command-line app in the background even when the desktop app is installed.',
            kind: 'boolean',
            defaultValue: false,
        },
        {
            path: 'activityVisibility',
            label: 'Log tool activity',
            description:
                'Logs what the assistant is doing, like the command it is running, in AIBI activity while it works. Permission questions are always asked out loud.',
            kind: 'boolean',
            defaultValue: true,
        },
    ]),
];
