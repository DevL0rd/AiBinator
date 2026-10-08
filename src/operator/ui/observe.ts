import { claudeModels, codexModels } from '../providers.js';
import { liveSetupStatus } from '../setup-model.js';
import { managedServiceStatus } from '../service-status.js';
import { runtimePresent } from '../status.js';
import { readOperatorConfig } from '../config.js';
import type { Observations } from './model.js';

const sources = { liveSetupStatus, runtimePresent, readOperatorConfig, codexModels, claudeModels, managedServiceStatus };

export async function observations(known?: Pick<Observations, 'codex' | 'claude'>, read = sources): Promise<Observations> {
    const [live, runtime, active, codex, claude, service] = await Promise.all([
        read.liveSetupStatus(),
        read.runtimePresent(),
        read.readOperatorConfig(),
        known?.codex ?? read.codexModels(),
        known?.claude ?? read.claudeModels(),
        read.managedServiceStatus(),
    ]);
    return { live, runtime, active, codex, claude, service, observedAt: new Date().toISOString() };
}
