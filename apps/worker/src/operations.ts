import type { Operation } from '../../../packages/shared/src/types.js';
import { fail, text } from './http.js';

export function parseOperation(input: unknown): Operation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_operation', 'Expected an operation.');
  const value = input as Record<string, unknown>;
  switch (value.kind) {
    case 'git.commit': return { kind: value.kind, message: text(value.message, 'commit message', 4000) };
    case 'bash': return { kind: value.kind, command: text(value.command, 'command', 8192) };
    case 'github.comment': {
      const repository = text(value.repository, 'repository', 200);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository.endsWith('/.') || repository.endsWith('/..')) {
        fail(400, 'invalid_operation', 'Expected a GitHub owner/repository, not a URL.');
      }
      if (!Number.isSafeInteger(value.issue) || Number(value.issue) < 1) fail(400, 'invalid_operation', 'Invalid issue number.');
      return { kind: value.kind, repository, issue: Number(value.issue), body: text(value.body, 'comment body', 60000) };
    }
    default: fail(400, 'invalid_operation', 'Unsupported operation.');
  }
}
