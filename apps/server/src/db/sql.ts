/**
 * Dialect translation. Application SQL is written once in SQLite syntax; the Postgres provider rewrites each
 * statement text through `translateToPostgres` (memoized per text). The rewrite is token based so string
 * literals, comments and quoted identifiers are never touched.
 *
 * Rules (see the migration plan):
 *  - `?` placeholders → `$1, $2, …`; `? IS [NOT] NULL` gets a `::text` cast so Postgres can type the parameter.
 *  - `json_extract(x, '$.a.b')` → `((x)::jsonb #>> '{a,b}')`; `json_each(x)` → `jsonb_array_elements_text((x)::jsonb)`
 *    (a bare `JOIN json_each(...)` without ON becomes `CROSS JOIN`); `json_group_array(x)` → `COALESCE(jsonb_agg(x), '[]'::jsonb)::text`;
 *    `json_array(...)` → `jsonb_build_array(...)::text`; `json(x)` → canonical text `((x)::jsonb::text)`;
 *    `json_type(x, '$.a')` → SQLite type names; `json_set(x, '$.a', v)` → `jsonb_set(...)::text`.
 *  - `a IS b` / `a IS NOT b` with a non-NULL operand → `IS [NOT] DISTINCT FROM`.
 *  - `changes()` → one extra parameter the provider binds to the previous statement's row count.
 *  - `lower(hex(randomblob(16)))` → `replace(gen_random_uuid()::text, '-', '')`.
 *  - `COLLATE NOCASE` is dropped (NOCASE columns are `citext` in the Postgres schema).
 *  - Unaliased `FROM (subquery)` gets an alias; mixed-case aliases are double-quoted so Postgres keeps their case.
 */

export interface PostgresStatement {
  text: string;
  /** Number of `?` placeholders in the source statement. */
  placeholders: number;
  /** True when the statement reads `changes()`; the provider binds the previous row count as parameter `placeholders + 1`. */
  changes: boolean;
}

export interface StatementShape {
  /** INSERT, UPDATE, DELETE or REPLACE at the top level (possibly after a WITH prefix). */
  write: boolean;
  returning: boolean;
}

type TokenKind = 'space' | 'string' | 'ident' | 'quoted' | 'number' | 'placeholder' | 'punct';
interface Token { kind: TokenKind; text: string }

const identStart = /[A-Za-z_]/;
const identChar = /[A-Za-z0-9_$]/;
const operators = ['->>', '<>', '!=', '<=', '>=', '||', '->'];

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      let end = i + 1;
      while (end < sql.length && /\s/.test(sql[end]!)) end++;
      tokens.push({ kind: 'space', text: sql.slice(i, end) });
      i = end;
    } else if (ch === '-' && sql[i + 1] === '-') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      tokens.push({ kind: 'space', text: sql.slice(i, end) });
      i = end;
    } else if (ch === '/' && sql[i + 1] === '*') {
      let end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated comment in SQL statement.');
      end += 2;
      tokens.push({ kind: 'space', text: sql.slice(i, end) });
      i = end;
    } else if (ch === "'" || ch === '"') {
      let end = i + 1;
      for (;;) {
        const close = sql.indexOf(ch, end);
        if (close === -1) throw new Error('Unterminated string literal in SQL statement.');
        if (sql[close + 1] === ch) { end = close + 2; continue; }
        end = close + 1;
        break;
      }
      tokens.push({ kind: ch === "'" ? 'string' : 'quoted', text: sql.slice(i, end) });
      i = end;
    } else if (ch === '?') {
      tokens.push({ kind: 'placeholder', text: '?' });
      i++;
    } else if (identStart.test(ch)) {
      let end = i + 1;
      while (end < sql.length && identChar.test(sql[end]!)) end++;
      tokens.push({ kind: 'ident', text: sql.slice(i, end) });
      i = end;
    } else if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < sql.length && /[0-9.]/.test(sql[end]!)) end++;
      tokens.push({ kind: 'number', text: sql.slice(i, end) });
      i = end;
    } else {
      const operator = operators.find(candidate => sql.startsWith(candidate, i));
      tokens.push({ kind: 'punct', text: operator ?? ch });
      i += operator ? operator.length : 1;
    }
  }
  return tokens;
}

const keywordList = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'AS', 'ON', 'JOIN', 'LEFT', 'RIGHT',
  'INNER', 'CROSS', 'OUTER', 'FULL', 'NATURAL', 'USING', 'GROUP', 'ORDER', 'BY', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL',
  'EXCEPT', 'INTERSECT', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'RETURNING', 'CONFLICT', 'DO', 'NOTHING',
  'WITH', 'RECURSIVE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'BETWEEN', 'LIKE', 'GLOB', 'DISTINCT', 'ASC', 'DESC',
  'COLLATE', 'CAST', 'LATERAL', 'EXCLUDED', 'TRUE', 'FALSE', 'REPLACE', 'DEFAULT', 'ESCAPE'];
const keywords: Record<string, true> = Object.fromEntries(keywordList.map(word => [word, true]));
const joinQualifiers: Record<string, true> = { CROSS: true, INNER: true, LEFT: true, RIGHT: true, FULL: true, OUTER: true, NATURAL: true };
const isKeyword = (token: Token | undefined): boolean => token?.kind === 'ident' && keywords[token.text.toUpperCase()] === true;
const isIdent = (token: Token | undefined, name: string): boolean => token?.kind === 'ident' && token.text.toUpperCase() === name;
const isPunct = (token: Token | undefined, text: string): boolean => token?.kind === 'punct' && token.text === text;

function next(tokens: Token[], from: number): number {
  let i = from;
  while (i < tokens.length && tokens[i]!.kind === 'space') i++;
  return i;
}
function previous(tokens: Token[], from: number): number {
  let i = from;
  while (i >= 0 && tokens[i]!.kind === 'space') i--;
  return i;
}
/** Index of the `)` closing the `(` at `open`. */
function closing(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')') && --depth === 0) return i;
  }
  throw new Error('Unbalanced parentheses in SQL statement.');
}
/** Top-level argument ranges `[from, to)` of the call whose `(` is at `open`. */
function callArguments(tokens: Token[], open: number, close: number): [number, number][] {
  const ranges: [number, number][] = [];
  let start = open + 1, depth = 0;
  for (let i = open + 1; i < close; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')')) depth--;
    else if (depth === 0 && isPunct(tokens[i], ',')) { ranges.push([start, i]); start = i + 1; }
  }
  if (next(tokens, start) < close) ranges.push([start, close]);
  return ranges;
}

function jsonPath(tokens: Token[], range: [number, number] | undefined): string[] {
  const token = range && tokens[next(tokens, range[0])];
  const literal = token?.kind === 'string' ? token.text.slice(1, -1) : null;
  if (literal === null || !/^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(literal) || next(tokens, next(tokens, range![0]) + 1) < range![1]) {
    throw new Error('Only literal JSON paths of the form \'$.a.b\' can be translated.');
  }
  return literal.slice(2).split('.');
}
const pathOperator = (segments: string[]): string =>
  segments.length === 1 ? `->> '${segments[0]}'` : `#>> '{${segments.join(',')}}'`;
const pathArray = (segments: string[]): string => `'{${segments.join(',')}}'`;

const CHANGES = '\u0000changes\u0000';

class Translator {
  placeholders = 0;
  changes = false;
  private subqueries = 0;
  /** Indices of `)` closing an unaliased FROM/JOIN subquery that needs an alias appended. */
  private readonly aliasAfter = new Set<number>();
  constructor(private readonly tokens: Token[]) {}

  range(from: number, to: number): string {
    const { tokens } = this;
    let out = '';
    for (let i = from; i < to;) {
      const token = tokens[i]!;
      if (token.kind === 'placeholder') {
        out += `$${++this.placeholders}`;
        const is = next(tokens, i + 1);
        if (isIdent(tokens[is], 'IS')) {
          let operand = next(tokens, is + 1);
          if (isIdent(tokens[operand], 'NOT')) operand = next(tokens, operand + 1);
          if (isIdent(tokens[operand], 'NULL')) out += '::text';
        }
        i++;
        continue;
      }
      if (token.kind === 'ident') {
        const call = next(tokens, i + 1);
        if (isPunct(tokens[call], '(')) {
          const translated = this.call(token.text.toLowerCase(), i, call);
          if (translated) { out += translated.text; i = translated.end; continue; }
        }
        const upper = token.text.toUpperCase();
        if (upper === 'IS') {
          const not = next(tokens, i + 1);
          const negated = isIdent(tokens[not], 'NOT');
          const literal = tokens[negated ? next(tokens, not + 1) : not];
          if (!isIdent(literal, 'NULL') && !isIdent(literal, 'DISTINCT') && !isIdent(literal, 'TRUE') && !isIdent(literal, 'FALSE')) {
            out += negated ? 'IS DISTINCT FROM' : 'IS NOT DISTINCT FROM';
            i = negated ? not + 1 : i + 1;
            continue;
          }
        } else if (upper === 'COLLATE' && isIdent(tokens[next(tokens, i + 1)], 'NOCASE')) {
          i = next(tokens, i + 1) + 1;
          continue;
        } else if (upper === 'JOIN' && joinQualifiers[tokens[previous(tokens, i - 1)]?.text.toUpperCase() ?? ''] !== true) {
          const fn = next(tokens, i + 1);
          const open = next(tokens, fn + 1);
          if (isIdent(tokens[fn], 'JSON_EACH') && isPunct(tokens[open], '(')) {
            let after = next(tokens, closing(tokens, open) + 1);
            if (isIdent(tokens[after], 'AS')) after = next(tokens, after + 1);
            if (tokens[after]?.kind === 'ident' && !isKeyword(tokens[after])) after = next(tokens, after + 1);
            if (!isIdent(tokens[after], 'ON') && !isIdent(tokens[after], 'USING')) { out += 'CROSS JOIN'; i++; continue; }
          }
        } else if (!isKeyword(token) && /[A-Z]/.test(token.text) && /[a-z]/.test(token.text)) {
          out += `"${token.text}"`;
          i++;
          continue;
        }
        out += token.text;
        i++;
        continue;
      }
      if (isPunct(token, '(')) {
        const before = tokens[previous(tokens, i - 1)];
        if ((isIdent(before, 'FROM') || isIdent(before, 'JOIN')) && isIdent(tokens[next(tokens, i + 1)], 'SELECT')) {
          const close = closing(tokens, i);
          const after = tokens[next(tokens, close + 1)];
          if (!isIdent(after, 'AS') && !(after?.kind === 'ident' && !isKeyword(after))) this.aliasAfter.add(close);
        }
      } else if (isPunct(token, ')') && this.aliasAfter.has(i)) {
        out += `) AS sq${++this.subqueries}`;
        i++;
        continue;
      }
      out += token.text;
      i++;
    }
    return out;
  }

  private call(name: string, at: number, open: number): { text: string; end: number } | null {
    const { tokens } = this;
    const close = closing(tokens, open);
    const args = callArguments(tokens, open, close);
    const end = close + 1;
    const argument = (index: number): string => {
      const range = args[index];
      if (!range) throw new Error(`${name}() needs ${index + 1} arguments.`);
      return this.range(range[0], range[1]).trim();
    };
    switch (name) {
      case 'json_extract':
        return { text: `((${argument(0)})::jsonb ${pathOperator(jsonPath(tokens, args[1]))})`, end };
      case 'json_each':
        return { text: `jsonb_array_elements_text((${argument(0)})::jsonb)`, end };
      case 'json_group_array':
        return { text: `COALESCE(jsonb_agg(${this.range(open + 1, close).trim()}), '[]'::jsonb)::text`, end };
      case 'json_array':
        return { text: `jsonb_build_array(${this.range(open + 1, close).trim()})::text`, end };
      case 'json':
        return { text: `((${argument(0)})::jsonb::text)`, end };
      case 'json_type': {
        const value = args.length > 1 ? `((${argument(0)})::jsonb #> ${pathArray(jsonPath(tokens, args[1]))})` : `((${argument(0)})::jsonb)`;
        return { text: `(CASE jsonb_typeof(${value}) WHEN 'boolean' THEN (${value} #>> '{}') WHEN 'string' THEN 'text'`
          + ` WHEN 'number' THEN (CASE WHEN (${value} #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END) ELSE jsonb_typeof(${value}) END)`, end };
      }
      case 'json_set': {
        const path = pathArray(jsonPath(tokens, args[1]));
        const valueRange = args[2];
        if (!valueRange) throw new Error('json_set() needs 3 arguments.');
        const bare = next(tokens, valueRange[0]);
        const value = tokens[bare]?.kind === 'placeholder' && next(tokens, bare + 1) >= valueRange[1] ? `${argument(2)}::text` : argument(2);
        return { text: `jsonb_set((${argument(0)})::jsonb, ${path}, to_jsonb(${value}))::text`, end };
      }
      case 'changes':
        if (args.length) return null;
        this.changes = true;
        return { text: CHANGES, end };
      case 'lower': {
        const hex = next(tokens, open + 1), hexOpen = next(tokens, hex + 1), blob = next(tokens, hexOpen + 1);
        const blobOpen = next(tokens, blob + 1), size = next(tokens, blobOpen + 1);
        if (isIdent(tokens[hex], 'HEX') && isPunct(tokens[hexOpen], '(') && isIdent(tokens[blob], 'RANDOMBLOB')
          && isPunct(tokens[blobOpen], '(') && tokens[size]?.text === '16' && closing(tokens, blobOpen) === next(tokens, size + 1)
          && closing(tokens, hexOpen) === next(tokens, closing(tokens, blobOpen) + 1) && close === next(tokens, closing(tokens, hexOpen) + 1)) {
          return { text: "replace(gen_random_uuid()::text, '-', '')", end };
        }
        return null;
      }
      default:
        return null;
    }
  }
}

const postgresCache = new Map<string, PostgresStatement>();

export function translateToPostgres(sql: string): PostgresStatement {
  const cached = postgresCache.get(sql);
  if (cached) return cached;
  const tokens = tokenize(sql);
  const translator = new Translator(tokens);
  let text = translator.range(0, tokens.length);
  if (translator.changes) text = text.replaceAll(CHANGES, `$${translator.placeholders + 1}`);
  const statement: PostgresStatement = { text, placeholders: translator.placeholders, changes: translator.changes };
  if (postgresCache.size >= 2048) postgresCache.clear();
  postgresCache.set(sql, statement);
  return statement;
}

const shapeCache = new Map<string, StatementShape>();

/** Whether a statement writes rows and whether it has a RETURNING clause (used by the SQLite provider to compute `changes`). */
export function statementShape(sql: string): StatementShape {
  const cached = shapeCache.get(sql);
  if (cached) return cached;
  const tokens = tokenize(sql);
  let depth = 0, verb: string | null = null, returning = false;
  for (const token of tokens) {
    if (isPunct(token, '(')) depth++;
    else if (isPunct(token, ')')) depth--;
    else if (depth === 0 && token.kind === 'ident') {
      const upper = token.text.toUpperCase();
      if (!verb && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(upper)) verb = upper;
      if (upper === 'RETURNING') returning = true;
    }
  }
  const shape = { write: verb !== null && verb !== 'SELECT', returning };
  if (shapeCache.size >= 2048) shapeCache.clear();
  shapeCache.set(sql, shape);
  return shape;
}
