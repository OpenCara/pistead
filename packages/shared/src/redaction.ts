import type { ApprovalRecord, EntryView, Operation, SessionView } from "./types.js";

/**
 * Secret redaction for everything the control plane shows people: transcript entries, approvals and their results, in
 * every session view and share link. It hides values that look like credentials (well-known token formats, private
 * keys, values of password-, secret-, token- and key-named settings, and credentials in URLs, Authorization headers,
 * curl and .netrc) and leaves everything else exactly as it was. The host and the model keep the real text: only what
 * people are shown changes.
 *
 * The text comes from hosts and models, so every pattern runs in linear time: quantifiers are bounded, and a token
 * pattern only starts where the token's own characters don't continue, so no run of text is rescanned from every offset.
 */
export const REDACTED = "[redacted]";

export interface RedactOptions {
  /**
   * The text is a shell command someone decides on: a bash approval, or a permission request's target. Then only single
   * words without whitespace, quotes or shell metacharacters are hidden, never a block of lines, so what stays visible
   * is still everything that decides what the command does.
   */
  command?: boolean;
}

/** What a hidden part of a command may contain: nothing the shell splits on, expands or runs. */
const commandSafe = /^[A-Za-z0-9._~+/=:@%^!#,-]+$/;
/** Values that refer to, template or stand in for a secret rather than being one. */
const placeholder = /^(?:\$\{?[A-Za-z_]|\{\{|\{%|%\(|<[^<>]*>$|\*+$|x{3,}$|\.{3}$|\u2026$|your[_-]|(?:null|none|nil|undefined|true|false|empty)$)/i;

function hideable(value: string, options: RedactOptions): boolean {
  return !!value && !value.includes(REDACTED) && !placeholder.test(value) && (!options.command || commandSafe.test(value));
}

/** An unquoted value that reads as a secret rather than a word, identifier or number of something. */
function literal(value: string): boolean {
  return value.length >= 6 && (/^\d+$/.test(value) || (/\d/.test(value) && /[A-Za-z]/.test(value)) || /[!@#%^*~]/.test(value)
    || /^[0-9a-f]{16,}$/i.test(value));
}

/** Words that follow a password key in code and prose without being the password: types, states, variable names. */
const notPasswords = new Set([
  "string", "text", "number", "integer", "float", "double", "boolean", "bytes", "buffer", "object", "unknown", "never", "char", "varchar",
  "null", "none", "undefined", "true", "false", "enabled", "disabled",
  "required", "optional", "invalid", "valid", "incorrect", "correct", "wrong", "missing", "empty", "blank", "expired", "hidden",
  "masked", "redacted", "sensitive", "case-sensitive", "stored", "saved", "encrypted", "hashed", "salted", "protected", "changed",
  "reset", "needed", "necessary", "mandatory", "unset", "weak", "strong", "long", "short", "ready", "same", "different", "given",
  "provided", "supplied", "generated", "random", "unique", "default", "allowed", "accepted", "rejected", "denied", "locked",
  "unlocked", "visible", "shown", "cleared", "removed", "deleted", "updated", "unchanged", "secure", "insecure", "safe", "unsafe",
  "known", "special", "important", "plain", "plaintext", "ciphertext", "encoded", "decoded",
  "password", "passwords", "passwd", "passphrase", "pass", "secret", "token", "value", "values", "credential", "credentials",
  "hash", "input", "data", "body", "form", "user", "args", "params", "options", "config", "field", "entry", "item", "result",
  "response", "request", "payload", "answer", "prompt", "match",
]);

/**
 * A plain word that is the password when it follows a password key and ends its line or sentence: `password: swordfish`,
 * `the password is swordfish.` Identifiers (`SecretStr`, `userPassword`, `user_password`) and the words above are code.
 */
function plainPassword(value: string): boolean {
  return /^[A-Za-z][A-Za-z-]{3,63}$/.test(value) && !/^[a-z]+[A-Z]|^[A-Z][a-z]+[A-Z]/.test(value) && !notPasswords.has(value.toLowerCase());
}

/** The next character on the same line after `index`, past spaces and tabs; empty at the end of the line or text. */
function nextOnLine(text: string, index: number): string {
  let at = index;
  while (text[at] === " " || text[at] === "\t") at++;
  const next = text[at] ?? "";
  return next === "\n" || next === "\r" ? "" : next;
}

/* ---------- Private keys ---------- */

const keyBegin = /-----BEGIN ((?:[A-Z0-9]{1,16} ){0,4})PRIVATE KEY( BLOCK)?-----/g;
const keyHeader = /(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset): [^\r\n\\]{0,256}/y;
const keyNewline = /^(?:\r?\n|\\r\\n|\\n)/;
const keyTrailer = /(?:\r?\n|\\r\\n|\\n)[ \t]*$/;

/**
 * Private key blocks, raw or inside JSON strings (`\n` escapes): the base64 body goes and the BEGIN and END lines stay.
 * A body cut off before its END line (`head key.pem`) is hidden too once it holds a few lines' worth of base64.
 */
function redactPrivateKeys(text: string): string {
  if (!text.includes("PRIVATE KEY")) return text;
  let out = "";
  let copied = 0;
  keyBegin.lastIndex = 0;
  for (let begin = keyBegin.exec(text); begin; begin = keyBegin.exec(text)) {
    const start = begin.index + begin[0].length;
    const end = `-----END ${begin[1]}PRIVATE KEY${begin[2] ?? ""}-----`;
    const limit = Math.min(text.length, start + 65536);
    let at = start;
    let base64 = 0;
    let lineStart = true;
    let closed = false;
    while (at < limit) {
      if (text.startsWith(end, at)) { closed = true; break; }
      const char = text[at]!;
      if (char === "\n" || char === "\r") { at++; lineStart = true; continue; }
      if (char === "\\" && (text[at + 1] === "n" || text[at + 1] === "r")) { at += 2; lineStart = true; continue; }
      // Indentation only: a space after base64 on the same line ends the body, as it never occurs inside one.
      if ((char === " " || char === "\t") && lineStart) { at++; continue; }
      if (lineStart) {
        keyHeader.lastIndex = at;
        if (keyHeader.test(text)) { at = keyHeader.lastIndex; lineStart = false; continue; }
      }
      if (/[A-Za-z0-9+/=]/.test(char)) { at++; base64++; lineStart = false; continue; }
      break;
    }
    if (base64 && (closed || base64 >= 16)) {
      const body = text.slice(start, at);
      out += text.slice(copied, start) + (keyNewline.exec(body)?.[0] ?? "") + REDACTED + (keyTrailer.exec(body)?.[0] ?? "");
      copied = at;
    }
    keyBegin.lastIndex = closed ? at + end.length : Math.max(at, start);
  }
  return out + text.slice(copied);
}

/* ---------- Secret-named settings ---------- */

/** Names that end a key holding a secret: DB_PASSWORD, githubToken, client_secret, x-api-key, aws_secret_access_key. */
const secretKey = String.raw`pass(?:word|wd|phrase)|secret|token|api[_-]?key|(?:access|secret|private|auth|account|encryption|signing|master|session)[_-]?key`;
const secretWord = /pass|secret|token|key/i;
/** Quoted values: plain, single, or with JSON-escaped quotes inside a JSON string. Interpolating ones (`$`, backticks) are code. */
const quotedValue = String.raw`"((?:[^"\\\n\x60$]|\\[^\n]){1,8192})"|'([^'\n]{1,8192})'|\\"((?:[^"\\\n\x60$]|\\[^"\n]){1,8192})\\"`;
/** An unquoted value: one word, stopping at anything code or a shell would treat as structure, and never `==`. */
const bareValue = String.raw`([^\s'"\x60,;&|<>(){}\[\]$\\=][^\s'"\x60,;&|<>(){}\[\]$\\]{0,1023})`;
const assignment = new RegExp(String.raw`(${secretKey})((?:\\?["'])?)([ \t]{0,16}(?::=|=>|[:=])[ \t]{0,16}|[ \t]{1,16}(?:is|was)[ \t]{1,16})(?:${quotedValue}|${bareValue})`, "gi");
const prose = /^[ \t]+(?:is|was)[ \t]+$/i;

/**
 * `KEY=value` as in .env files, shells, flags and URLs hides any value; other separators (`key: value`, `key = value`,
 * `password is value`) hide an unquoted value only when it reads as a secret (digits with letters, a symbol, a long hex
 * run, or for a password a plain word that ends its line or sentence) and isn't code (`token: Uint8Array;`).
 */
function assignments(text: string, options: RedactOptions): string {
  return text.replace(assignment, (match: string, key: string, keyQuote: string, separator: string,
    double: string | undefined, single: string | undefined, escaped: string | undefined, bare: string | undefined, offset: number) => {
    let value = double ?? single ?? escaped ?? bare ?? "";
    let suffix = "";
    if (bare === undefined) {
      // Padding means concatenated code ("token: " + token + "), not a value.
      if (/^\s|\s$/.test(value)) return match;
    } else {
      // A sentence's full stop is not part of the value.
      if (/[^.]\.$/.test(value)) { value = value.slice(0, -1); suffix = "."; }
      const next = nextOnLine(text, offset + match.length);
      if (separator === "=") {
        // Any value, unless it's an argument in code: f(token=token).
        if (/[),}\]]/.test(next) ? !literal(value) : /^\d{1,5}$/.test(value)) return match;
      } else {
        const sentence = prose.test(separator);
        // Code goes on after a value it assigns (`token: Uint8Array;`); prose doesn't assign with `is`.
        if (!sentence && /[;,)}\]|<>({[=?:&]/.test(next)) return match;
        // A password's plain word must end its line (a YAML comment may follow) or its sentence.
        const ends = next === "" || (sentence ? /[.!?,;)"']/.test(next) : next === "#");
        if (!literal(value) && !(/^pass/i.test(key) && ends && plainPassword(value))) return match;
      }
    }
    if (!hideable(value, options)) return match;
    const shown = double !== undefined ? `"${REDACTED}"` : single !== undefined ? `'${REDACTED}'`
      : escaped !== undefined ? `\\"${REDACTED}\\"` : REDACTED + suffix;
    return key + keyQuote + separator + shown;
  });
}

/** `--password value`, `--api-key "value"`: the space-separated flags `KEY=value` doesn't cover. */
const flag = new RegExp(String.raw`(--(?:[A-Za-z0-9]{1,32}-){0,4}(?:pass(?:word|wd|phrase)|secret|token|api-?key|(?:access|secret|private|auth)-key))([ \t]{1,16})(?:"([^"\\\n\x60$]{1,1024})"|'([^'\n]{1,1024})'|([^\s'"\x60,;&|<>(){}\[\]$\\-][^\s'"\x60,;&|<>(){}\[\]$\\]{0,1023}))`, "gi");

function flags(text: string, options: RedactOptions): string {
  if (!text.includes("--")) return text;
  return text.replace(flag, (match: string, name: string, space: string, double: string | undefined, single: string | undefined, bare: string | undefined) => {
    const value = double ?? single ?? bare ?? "";
    if (!hideable(value, options)) return match;
    return name + space + (double !== undefined ? `"${REDACTED}"` : single !== undefined ? `'${REDACTED}'` : REDACTED);
  });
}

/* ---------- Credentials in commands, files, headers and URLs ---------- */

/** curl's `-u user:password`; other commands' `-u` takes a user or uid:gid, so only curl's is a password. */
const curlUser = /(\bcurl\b[^\n]{0,2048}?[ \t])(-u|--user)([ \t]{1,16}|=)(["']?)([^\s:'"\x60;&|<>(){}$\\]{1,256}):([^\s'"\x60;&|<>(){}$\\]{1,1024})\4(?![^\s])/g;
/** .netrc: `machine host [login user] password secret`, on one line or several. */
const netrc = /\b(machine[ \t\r\n]{1,64}[^\s]{1,253}[ \t\r\n]{1,64}(?:login[ \t\r\n]{1,64}[^\s]{1,253}[ \t\r\n]{1,64})?password[ \t\r\n]{1,64})([^\s]{1,1024})/g;
/** The credential of an Authorization header with a scheme, quoted or not, in any of the ways code and tools write it. */
const authorization = /\b((?:proxy-)?authorization["']?[ \t]{0,16}[:=][ \t]{0,16}["']?(?:bearer|basic|token|bot|digest|negotiate|apikey|sso-key)[ \t]{1,16})([A-Za-z0-9._~+/=:-]{1,4096})/gi;
/** A bearer token outside a header: long, and with a digit, so "bearer of bad news" stays. */
const bearer = /\b(bearer[ \t]{1,16})([A-Za-z0-9._~+/-]{16,4096}=*)(?![A-Za-z0-9._~+/=-])/gi;
/** The password in a URL's userinfo: https://x-access-token:SECRET@github.com, postgres://app:SECRET@db/app. */
const urlPassword = /\b([a-z][a-z0-9+.-]{1,30}:\/\/[^\s:/@?#'"<>[\]]{0,256}:)([^\s@/?#'"<>[\]]{1,1024})(?=@)/gi;

function credentials(text: string, options: RedactOptions): string {
  let result = text;
  if (result.includes("curl")) {
    result = result.replace(curlUser, (match: string, before: string, name: string, separator: string, quote: string, user: string, password: string) =>
      (/^\d+$/.test(user) && /^\d+$/.test(password)) || !hideable(password, options) ? match
        : `${before}${name}${separator}${quote}${user}:${REDACTED}${quote}`);
  }
  if (result.includes("machine")) {
    result = result.replace(netrc, (match: string, before: string, password: string) => hideable(password, options) ? before + REDACTED : match);
  }
  if (/bearer|authorization|basic|token|digest|negotiate|apikey|sso-key|bot/i.test(result)) {
    result = result.replace(authorization, (match: string, before: string, value: string) => hideable(value, options) ? before + REDACTED : match);
    result = result.replace(bearer, (match: string, before: string, value: string) =>
      /\d/.test(value) && hideable(value, options) ? before + REDACTED : match);
  }
  if (result.includes("://")) {
    result = result.replace(urlPassword, (match: string, before: string, password: string) => hideable(password, options) ? before + REDACTED : match);
  }
  return result;
}

/* ---------- Well-known token formats ---------- */

/** Each keeps its non-secret prefix (group 1) so a reader still sees what kind of credential was there. */
const tokenFormats: { pattern: RegExp; digit?: boolean }[] = [
  { pattern: /(?<![A-Za-z0-9_])(gh[pousr]_)([A-Za-z0-9]{36,251})(?![A-Za-z0-9_])/g },
  { pattern: /(?<![A-Za-z0-9_])(github_pat_)([A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g },
  { pattern: /(?<![A-Za-z0-9_.-])(gl(?:pat|dt|rt|ptt|cbt|imt|soat|agent|oas|ffct|ft)-)([A-Za-z0-9_.-]{20,255})/g },
  { pattern: /(?<![A-Za-z0-9_-])(xox[abposr]-)([A-Za-z0-9-]{10,255})/g },
  { pattern: /(?<![A-Za-z0-9_-])(xapp-)([A-Za-z0-9-]{10,255})/g },
  { pattern: /(https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)([A-Za-z0-9/_-]{16,255})/g },
  { pattern: /(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{1,30}\/)([A-Za-z0-9_-]{20,255})/g },
  { pattern: /(?<![A-Za-z0-9])(AKIA|ASIA|ABIA|ACCA)([A-Z0-9]{16})(?![A-Za-z0-9])/g },
  { pattern: /(?<![A-Za-z0-9_-])(sk-(?:proj-|ant-(?:api|admin)[0-9]{2}-|svcacct-|admin-)?)([A-Za-z0-9_-]{20,255})/g, digit: true },
  { pattern: /(?<![A-Za-z0-9_-])(AIza)([0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])/g },
  { pattern: /(?<![A-Za-z0-9_-])(GOCSPX-)([A-Za-z0-9_-]{28})(?![A-Za-z0-9_-])/g },
  { pattern: /(?<![A-Za-z0-9_])((?:sk|rk)_(?:live|test)_)([A-Za-z0-9]{10,255})/g },
  { pattern: /(?<![A-Za-z0-9_])(whsec_)([A-Za-z0-9+/=]{20,255})/g },
  { pattern: /(?<![A-Za-z0-9_])(npm_)([A-Za-z0-9]{36})(?![A-Za-z0-9])/g },
  { pattern: /(?<![A-Za-z0-9_-])(pypi-)([A-Za-z0-9_-]{50,255})/g },
  { pattern: /(?<![A-Za-z0-9_])(hf_)([A-Za-z0-9]{30,255})/g },
  { pattern: /(?<![A-Za-z0-9_.-])(SG\.)([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g },
  { pattern: /(?<![A-Za-z0-9_])(shp(?:at|ca|pa|ss)_)([a-fA-F0-9]{32})(?![A-Za-z0-9])/g },
  { pattern: /(?<![A-Za-z0-9_])(do[opr]_v1_)([a-f0-9]{64})(?![A-Za-z0-9])/g },
  { pattern: /(?<![A-Za-z0-9_.-])(hv[sb]\.)([A-Za-z0-9_-]{24,255})/g },
  { pattern: /(?<![A-Za-z0-9_.-])(dp\.(?:pt|st|sa|ct|scim|audit)\.)([A-Za-z0-9]{40,255})/g },
  { pattern: /(?<![A-Za-z0-9_])(lin_api_)([A-Za-z0-9]{40})(?![A-Za-z0-9])/g },
];
const tokenHint = /gh[pousr]_|github_pat_|gl[a-z]{1,5}-|xox[abposr]-|xapp-|hooks\.slack\.com|discord(?:app)?\.com|A(?:KIA|SIA|BIA|CCA)|sk-|AIza|GOCSPX-|[sr]k_(?:live|test)_|whsec_|npm_|pypi-|hf_|SG\.|shp(?:at|ca|pa|ss)_|do[opr]_v1_|hv[sb]\.|dp\.|lin_api_/;
/** A JSON Web Token: three base64url segments, the first two JSON objects. */
const jwt = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,1024}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,1024}(?![A-Za-z0-9_-])/g;
/** A Pistead share link's token: the link opens the session for anyone who has it. */
const shareLink = /(#\/shared\/)([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;

function tokens(text: string): string {
  let result = text;
  if (tokenHint.test(result)) {
    for (const { pattern, digit } of tokenFormats) {
      result = result.replace(pattern, (match: string, prefix: string, secret: string) => digit && !/\d/.test(secret) ? match : prefix + REDACTED);
    }
  }
  if (result.includes("eyJ")) result = result.replace(jwt, REDACTED);
  if (result.includes("#/shared/")) result = result.replace(shareLink, `$1${REDACTED}`);
  return result;
}

/* ---------- Entry points ---------- */

/** `text` with every value that looks like a secret replaced by REDACTED. Applying it again changes nothing. */
export function redactSecrets(text: string, options: RedactOptions = {}): string {
  if (typeof text !== "string" || !text) return text;
  let result = options.command ? text : redactPrivateKeys(text);
  // Structured credentials first: in https://x-access-token:SECRET@host the generic rule would take the host along.
  result = credentials(result, options);
  if (secretWord.test(result)) result = flags(assignments(result, options), options);
  return tokens(result);
}

/** An operation as people see it: free text redacted, commands only word by word; everything structural unchanged. */
export function redactOperation(operation: Operation): Operation {
  switch (operation.kind) {
    case "bash": return { ...operation, command: redactSecrets(operation.command, { command: true }) };
    case "permission": return { ...operation, target: redactSecrets(operation.target, { command: true }) };
    case "git.commit": return { ...operation, message: redactSecrets(operation.message) };
    case "github.comment": return { ...operation, body: redactSecrets(operation.body) };
    case "git.push": return operation.pullRequest
      ? { ...operation, pullRequest: { ...operation.pullRequest, title: redactSecrets(operation.pullRequest.title), body: redactSecrets(operation.pullRequest.body) } }
      : operation;
    default: return operation;
  }
}

/** Approvals keep their review hash: it commits to the real operation, which is what runs once approved. */
export function redactApproval(approval: ApprovalRecord): ApprovalRecord {
  if (!approval || typeof approval !== "object" || !approval.operation || typeof approval.operation !== "object") return approval;
  return { ...approval, operation: redactOperation(approval.operation), ...(typeof approval.result === "string" ? { result: redactSecrets(approval.result) } : {}) };
}

export function redactEntry(entry: EntryView): EntryView {
  return entry && typeof entry === "object" && typeof entry.text === "string" ? { ...entry, text: redactSecrets(entry.text) } : entry;
}

/** A session view as people see it: entries and approvals redacted, everything else unchanged. */
export function redactView(view: SessionView): SessionView {
  if (!view || typeof view !== "object") return view;
  return { ...view, ...(Array.isArray(view.entries) ? { entries: view.entries.map(redactEntry) } : {}),
    ...(Array.isArray(view.approvals) ? { approvals: view.approvals.map(redactApproval) } : {}) };
}

/** Whether redaction hid something in `value`, e.g. to tell an approver an operation holds a secret they can't see. */
export function containsRedaction(value: unknown): boolean {
  return JSON.stringify(value ?? "").includes(REDACTED);
}
