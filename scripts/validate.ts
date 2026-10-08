import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { checkHttp, toolCount } from './check-http.js';
import { checkHttpBudgets } from './check-http-budgets.js';
import { checkAuth } from './check-auth.js';
import { checkConnection } from './check-connection.js';
import { checkOAuth } from './check-oauth.js';
import { checkOAuthEdges } from './check-oauth-edges.js';
import { checkAibiWire } from './check-aibi-wire.js';
import { checkAibiVoice } from './check-aibi-voice.js';
import { checkAibiTasks } from './check-aibi-tasks.js';
import { checkAibiNetwork } from './check-aibi-network.js';
import { checkAibiProxy } from './check-aibi-proxy.js';
import { checkOperator } from './check-operator.js';
import { checkMcpTools } from './check-mcp-tools.js';
import { checkMcpLocal } from './check-mcp-local.js';
import { checkPanel } from './check-panel.js';
import { checkController } from './check-controller.js';
import { checkControllerTasks } from './check-controller-tasks.js';
import { checkProviderApproval } from './check-provider-approval.js';
import { checkCodexAdapter } from './check-codex-adapter.js';
import { checkClaudeAdapter } from './check-claude-adapter.js';
import { checkClaudeController } from './check-claude-controller.js';
import { checkBridgeProcess, checkChannel } from './check-channel.js';
import { checkApps } from './check-apps.js';
import { checkSessionActivity, checkSessions } from './check-sessions.js';
import { checkCodexDaemon } from './check-codex-daemon.js';
import { checkUi } from './check-ui.js';
import { checkEffects } from './check-effects.js';
import { checkRender } from './check-render.js';
import { checkDashboard } from './check-dashboard.js';
import { checkWindows } from './check-windows.js';
import { checkRuntimeLock } from './check-runtime-lock.js';
import { checkUiKeys } from './check-ui-keys.js';
import { checkUiMouse } from './check-ui-mouse.js';
import { checkUiEdit } from './check-ui-edit.js';
import { checkUiPages } from './check-ui-pages.js';
import { checkOnboardingStore } from './check-onboarding-store.js';
import { checkPanelStore } from './check-panel-store.js';
import { checkUiApp } from './check-ui-app.js';
import { checkStartup } from './check-startup.js';
import { checkStdio } from './check-stdio.js';
import { checkSetupApp } from './check-setup-app.js';
import { checkStatusFile } from './check-status-file.js';
import { checkServiceHost } from './check-service-host.js';
import { checkSelfInstall } from './check-self-install.js';
import { checkSupervisor } from './check-supervisor.js';
import { checkProviders } from './check-providers.js';
import { checkClaudePlugin } from './check-claude-plugin.js';
import { checkRecovery } from './check-recovery.js';
import { checkOnboardingCopy } from './check-onboarding-copy.js';
import { checkOnboardingVerify } from './check-onboarding-verify.js';
import { checkOnboardingFlow } from './check-onboarding-flow.js';
import { checkOnboardingUi } from './check-onboarding-ui.js';

async function checkAibi(directory: string): Promise<void> {
    checkAibiWire();
    await checkAibiVoice(directory);
    await checkAibiTasks(directory);
    await checkAibiNetwork(directory);
    await checkAibiProxy(directory);
}

async function checkResponders(directory: string): Promise<void> {
    await checkOperator();
    await checkController(directory);
    await checkControllerTasks(directory);
    await checkProviderApproval();
    await checkCodexAdapter();
    await checkClaudeAdapter();
    await checkClaudeController(directory);
    await checkSessions();
    await checkSessionActivity(directory);
    await checkCodexDaemon();
    await checkProviders(directory);
    await checkClaudePlugin(directory);
    await checkApps();
}

async function checkSetup(directory: string): Promise<void> {
    await checkPanel();
    checkOnboardingCopy();
    await checkOnboardingVerify(directory);
    await checkOnboardingFlow(directory);
    await checkOnboardingUi(directory);
    await checkUiKeys();
    checkUiMouse();
    checkUiEdit();
    checkUiPages();
    await checkOnboardingStore(directory);
    await checkPanelStore(directory);
    await checkUiApp(directory);
    checkUi();
    await checkEffects();
    await checkRender();
    await checkDashboard();
    await checkSetupApp(directory);
}

async function checkRuntime(directory: string): Promise<void> {
    await checkMcpTools(directory);
    await checkMcpLocal(directory);
    await checkChannel(directory);
    await checkBridgeProcess(directory);
    await checkStdio(directory);
    await checkWindows(directory);
    await checkStatusFile(directory);
    await checkServiceHost(directory);
    await checkSelfInstall(directory);
    await checkSupervisor(directory);
    await checkRecovery(directory);
    await checkRuntimeLock(directory);
    await checkOAuthEdges(directory);
    await checkStartup(directory);
}

await mkdir('.data', { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join('.data', 'validation-'));
try {
    await checkOAuth(directory);
    if (!process.argv.includes('--oauth')) {
        await checkHttp(directory);
        await checkHttpBudgets(directory);
        await checkAuth();
        await checkConnection(directory);
        if (process.argv.includes('--connection')) {
            console.log(
                'Connection validation passed: bearer HTTP, offline OAuth JWTs and hosting-independent configuration. No external connections.',
            );
        } else {
            await checkAibi(directory);
            await checkResponders(directory);
            await checkSetup(directory);
            await checkRuntime(directory);
            console.log(
                `Local validation passed: AIBI proxy, DNS, firmware and voice turns with a fake Gemini, responders and spoken approvals, setup app and wizard, and bearer/OAuth MCP (${toolCount()} tools). No AIBI or Gemini connection.`,
            );
        }
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
