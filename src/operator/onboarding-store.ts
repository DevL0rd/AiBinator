import { randomBytes } from 'node:crypto';
import { ownerReady, requestOwnerPassword } from '../oauth/provision.js';
import { oauthDirectory } from '../oauth/registration.js';
import { codexCommand } from './codex-config.js';
import { claudeProgram } from './executables.js';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { replaceFile } from '../core/replace-file.js';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { parseEnv } from 'node:util';
import { policySchema } from '../core/config.js';
import { readOperatorConfig, writeOperatorConfig, type OperatingMode } from './config.js';
import { mcpAddresses } from './connection-domain.js';
import { lanAddress } from '../aibi/network.js';
import { portsAllowed } from '../aibi/ports.js';

const exec = promisify(execFile);
type Run = (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;
export type AiChoice = OperatingMode;
export interface OnboardingFiles {
    environment?: string;
    policy?: string;
    marker?: string;
}
const phases = ['voice', 'ai', 'service', 'aibi', 'verify', 'complete'] as const;
export type OnboardingPhase = (typeof phases)[number];
const read = async (path: string) =>
    readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
    });

export async function onboardingPhase(environment: Record<string, unknown>, marker = '.data/onboarding.json'): Promise<OnboardingPhase> {
    const key = environment.GEMINI_API_KEY;
    if (typeof key !== 'string' || !key.trim()) return 'voice';
    const saved = await read(marker);
    if (!saved) return 'complete';
    try {
        const phase = (JSON.parse(saved) as { phase?: unknown }).phase;
        return phases.includes(phase as OnboardingPhase) ? (phase as OnboardingPhase) : 'voice';
    } catch {
        return 'voice';
    }
}
export async function needsOnboarding(environment: Record<string, unknown>, marker?: string): Promise<boolean> {
    return (await onboardingPhase(environment, marker)) !== 'complete';
}
export async function checkGeminiKey(key: string, request = fetch): Promise<void> {
    if (key.trim().length < 8) throw new Error('That does not look like a Gemini API key.');
    let response: Response;
    try {
        response = await request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
            headers: { 'x-goog-api-key': key.trim() },
            signal: AbortSignal.timeout(10_000),
        });
    } catch {
        throw new Error('Google could not be reached to check the key. Check your internet connection and try again.');
    }
    if (response.status === 400 || response.status === 401 || response.status === 403)
        throw new Error('Google did not accept that key. Copy it again from aistudio.google.com/apikey.');
    if (!response.ok) throw new Error(`Google answered with an error (HTTP ${response.status}). Try again in a moment.`);
}
function envText(original: string, values: Record<string, string>): string {
    let text = original;
    for (const [key, value] of Object.entries(values)) {
        const encoded = JSON.stringify(value);
        const pattern = new RegExp(`^${key}=.*$`, 'm');
        text = pattern.test(text) ? text.replace(pattern, `${key}=${encoded}`) : `${text.trimEnd()}\n${key}=${encoded}\n`;
    }
    return text;
}
async function atomicWrite(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.onboarding.tmp`;
    await writeFile(temporary, text, { mode: 0o600, flush: true });
    await replaceFile(temporary, path);
}
export async function saveVoice(name: string, key: string, files: OnboardingFiles = {}): Promise<void> {
    const environmentPath = files.environment ?? '.env';
    const originalEnvironment = await read(environmentPath);
    const environment = parseEnv(originalEnvironment);
    const policyPath = files.policy ?? environment.AIBINATOR_POLICY_FILE ?? 'policy.json';
    const originalPolicy = await read(policyPath);
    const policy = policySchema.parse({
        ...(originalPolicy ? (JSON.parse(originalPolicy) as object) : {}),
        ownerName: name.trim().slice(0, 60),
    });
    const values: Record<string, string> = { GEMINI_API_KEY: key.trim(), AIBINATOR_POLICY_FILE: policyPath };
    if (!environment.AIBINATOR_MCP_TOKEN) values.AIBINATOR_MCP_TOKEN = randomBytes(32).toString('base64url');
    if (!environment.AIBINATOR_AUTH_MODE) values.AIBINATOR_AUTH_MODE = 'bearer';
    await writePhase('ai', files.marker);
    await atomicWrite(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    await atomicWrite(environmentPath, envText(originalEnvironment, values));
}
export async function writePhase(phase: Exclude<OnboardingPhase, 'voice'>, marker = '.data/onboarding.json'): Promise<void> {
    await atomicWrite(marker, `${JSON.stringify({ phase })}\n`);
}
export interface NetworkReadiness {
    address: string;
    ports: boolean;
}
export async function networkReadiness(files: OnboardingFiles = {}): Promise<NetworkReadiness> {
    const environment = await environmentOf(files);
    const raw = await read(files.policy ?? environment.AIBINATOR_POLICY_FILE ?? 'policy.json');
    const aibi = policySchema.parse(raw ? JSON.parse(raw) : {}).aibi;
    const [address, ports] = await Promise.all([
        lanAddress(aibi.lanAddress).catch(() => ''),
        portsAllowed(Math.min(aibi.httpPort, aibi.httpsPort, aibi.dnsPort)),
    ]);
    return { address, ports };
}
async function cliAuthenticated(command: 'claude' | 'codex', args: string[], run: Run): Promise<void> {
    try {
        const cli = command === 'codex' ? await codexCommand() : { ...(await claudeProgram()), env: process.env };
        const { stdout, stderr } = await run(cli.command, [...cli.args, ...args], { env: cli.env, timeout: 8_000, maxBuffer: 128 * 1024 });
        if (command === 'codex') {
            if (!/Logged in using (ChatGPT|an API key)/.test(`${stdout}\n${stderr}`)) throw new Error('not authenticated');
        } else {
            const status = JSON.parse(stdout) as { loggedIn?: boolean; authenticated?: boolean };
            if (status.loggedIn !== true && status.authenticated !== true) throw new Error('not authenticated');
        }
    } catch {
        throw new Error(`${command} is unavailable or not authenticated. Sign in with the provider CLI, then retry.`);
    }
}
export async function validateAi(choice: AiChoice, files: OnboardingFiles = {}, run: Run = exec): Promise<string> {
    const validators: Record<AiChoice, () => Promise<string>> = {
        'codex-local': async () => {
            await cliAuthenticated('codex', ['login', 'status'], run);
            return 'Codex CLI reported authenticated.';
        },
        'claude-session': () => claudeReady(run),
        'manual-mcp': async () => mcpAddresses(await environmentOf(files)).join(' '),
    };
    return validators[choice]();
}
async function environmentOf(files: OnboardingFiles): Promise<Record<string, string | undefined>> {
    return { ...process.env, ...parseEnv(await read(files.environment ?? '.env')) };
}
export async function needsPassword(files: OnboardingFiles = {}): Promise<boolean> {
    const environment = await environmentOf(files);
    if (!environment.AIBINATOR_RESOURCE_URL) return false;
    return !(await ownerReady(oauthDirectory.parse(environment.AIBINATOR_OAUTH_DATA_DIR)));
}
async function claudeReady(run: Run): Promise<string> {
    await cliAuthenticated('claude', ['auth', 'status', '--json'], run);
    return 'Claude Code is installed and signed in.';
}
export async function saveAi(choice: AiChoice, files: OnboardingFiles = {}): Promise<void> {
    const current = await readOperatorConfig();
    await writeOperatorConfig({ ...current, mode: choice, enabled: false });
    await atomicWrite('.data/operator-settings.json', `${JSON.stringify(await readOperatorConfig(), null, 2)}\n`);
    await writePhase('service', files.marker);
}

export async function savePassword(password: string, files: OnboardingFiles = {}): Promise<void> {
    const environment = parseEnv(await read(files.environment ?? '.env'));
    await requestOwnerPassword(oauthDirectory.parse(environment.AIBINATOR_OAUTH_DATA_DIR), password);
}
