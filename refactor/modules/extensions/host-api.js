// Shared host access for bundled extensions. All services belong to the new tree.
import { resolveDataDir } from '../../core/config-store/data-dir.js';
import { ask, hasRole, isModelBound } from '../jev/index.js';
export const DATA_DIR = resolveDataDir();
export async function jevGate(role, input, options = {}) {
  if (!hasRole(role) || !isModelBound()) return { error: 'role-off', abstain: true };
  const result = await ask(role, input, options);
  if (result.status !== 'accepted') return { error: result.status, abstain: true };
  return { on: String(result.label).toUpperCase() === 'SELF', abstain: false };
}
