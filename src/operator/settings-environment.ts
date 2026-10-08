import { group } from './settings-types.js';

export const environmentSettings = [
    ...group('environment', 'connections', 'live', [
        {
            path: 'AIBINATOR_POLICY_FILE',
            label: 'Policy file',
            description: 'Validated JSON policy path.',
            kind: 'text',
            defaultValue: 'policy.json',
            sensitive: true,
        },
        {
            path: 'AIBINATOR_PORT',
            label: 'Listener port',
            description: 'Check for an existing listener before applying.',
            kind: 'integer',
            minimum: 1024,
            maximum: 65535,
            defaultValue: 8789,
        },
        {
            path: 'AIBINATOR_BIND_HOST',
            label: 'Listener address',
            description: 'Loopback binding is an enforced boundary.',
            kind: 'text',
            defaultValue: '127.0.0.1',
            readOnly: true,
        },
        {
            path: 'AIBINATOR_AUTH_MODE',
            label: 'MCP authentication',
            description: 'Required mode-specific fields are checked by the environment schema.',
            kind: 'choice',
            choices: ['bearer', 'oauth'],
            defaultValue: 'bearer',
        },
        {
            path: 'AIBINATOR_MCP_TOKEN',
            label: 'Bearer credential',
            description: 'Independent secret of at least 32 characters.',
            credential: true,
            kind: 'text',
            sensitive: true,
        },
        {
            path: 'AIBINATOR_RESOURCE_URL',
            label: 'Public domain',
            description:
                'Just the domain, like bot.example.com. AiBinator derives the https:// MCP and sign-in URLs and host checks from it.',
            kind: 'text',
        },
        {
            path: 'AIBINATOR_OAUTH_SERVER',
            label: 'OAuth provider',
            description: 'Bundled owner authorization or an external provider.',
            kind: 'choice',
            choices: ['external', 'bundled'],
            defaultValue: 'bundled',
        },
        {
            path: 'AIBINATOR_OAUTH_DATA_DIR',
            label: 'OAuth state directory',
            description: 'Private persistent authentication state; preserve it during recovery.',
            kind: 'text',
            sensitive: true,
        },
        {
            path: 'AIBINATOR_TRUSTED_PROXIES',
            label: 'Trusted proxy addresses',
            description: 'Exact proxy IP addresses, comma-separated.',
            kind: 'text',
            sensitive: true,
            defaultValue: '',
        },
    ]),
];
