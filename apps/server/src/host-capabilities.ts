import type { ConnectorCapabilities, LocalModelSummary } from '../../../packages/shared/src/connector.js';
import { fail } from './http.js';

type Manifest = { models: LocalModelSummary[]; capabilities: ConnectorCapabilities };

/**
 * Validates the capability of connectors that carry host_bash (`hostCommands`), that honor host command grants
 * (`hostGrants`), that let their owner decide host commands without approve permission on the session
 * (`hostOwnerDecides`), that run GitHub effects under Auto-approve (`automaticGitHub`) and that browse a session's
 * worktree for the session panel (`fileBrowser`), and leaves every other manifest
 * field to `parse`, which still rejects unknown ones. An absent flag stays absent, as from older connectors, so nothing
 * is offered on hosts that can't do it. `gitRepin`, from connectors of when sessions pinned their repositories, is
 * accepted and dropped.
 */
export function withHostToolCapabilities(input: Record<string, unknown>, parse: (input: Record<string, unknown>) => Manifest): Manifest {
  const value = input.capabilities;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parse(input);
  const { hostCommands, hostGrants, hostOwnerDecides, automaticGitHub, fileBrowser, gitRepin, ...rest } = value as Record<string, unknown>;
  if ([hostCommands, hostGrants, hostOwnerDecides, automaticGitHub, fileBrowser, gitRepin].some(flag => flag !== undefined && typeof flag !== 'boolean')
    || (hostGrants && !hostCommands) || (hostOwnerDecides && !hostCommands)) {
    fail(400, 'invalid_manifest', 'Invalid capabilities.');
  }
  const manifest = parse({ ...input, capabilities: rest });
  return { ...manifest, capabilities: { ...manifest.capabilities, ...(hostCommands ? { hostCommands: true } : {}), ...(hostGrants ? { hostGrants: true } : {}),
    ...(hostOwnerDecides ? { hostOwnerDecides: true } : {}), ...(automaticGitHub ? { automaticGitHub: true } : {}), ...(fileBrowser ? { fileBrowser: true } : {}) } };
}
