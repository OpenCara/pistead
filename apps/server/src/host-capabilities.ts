import type { ConnectorCapabilities, LocalModelSummary } from '../../../packages/shared/src/connector.js';
import { fail } from './http.js';

type Manifest = { models: LocalModelSummary[]; capabilities: ConnectorCapabilities };

/**
 * Validates the capability of connectors that carry host_bash (`hostCommands`), and leaves every other manifest field
 * to `parse`, which still rejects unknown ones. An absent flag stays absent, as from older connectors, so the tool isn't
 * offered on hosts that can't run it. `gitRepin`, from connectors of when sessions pinned their repositories, is
 * accepted and dropped.
 */
export function withHostToolCapabilities(input: Record<string, unknown>, parse: (input: Record<string, unknown>) => Manifest): Manifest {
  const value = input.capabilities;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parse(input);
  const { hostCommands, gitRepin, ...rest } = value as Record<string, unknown>;
  if ((hostCommands !== undefined && typeof hostCommands !== 'boolean') || (gitRepin !== undefined && typeof gitRepin !== 'boolean')) {
    fail(400, 'invalid_manifest', 'Invalid capabilities.');
  }
  const manifest = parse({ ...input, capabilities: rest });
  return { ...manifest, capabilities: { ...manifest.capabilities, ...(hostCommands ? { hostCommands: true } : {}) } };
}
