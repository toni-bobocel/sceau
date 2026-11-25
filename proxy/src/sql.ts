// Statement kinds in a SQL string, without a parser per dialect. The firewall
// only needs to know what a query would do, so it is deliberately pessimistic:
// anything it cannot place counts as a write.

const VERBS = new Set([
  'select', 'insert', 'update', 'delete', 'merge', 'upsert', 'replace', 'create', 'alter', 'drop', 'truncate',
  'grant', 'revoke', 'copy', 'call', 'exec', 'execute', 'pragma', 'attach', 'detach', 'vacuum', 'begin', 'commit',
  'rollback', 'set', 'show', 'describe', 'explain', 'values', 'with', 'use', 'lock', 'analyze', 'reindex', 'comment',
  'do', 'load', 'install', 'refresh', 'cluster', 'listen', 'notify', 'prepare', 'deallocate', 'savepoint', 'release',
])

export const READS = new Set(['select', 'show', 'describe', 'explain', 'values'])

function tokens(sql: string) {
  const clean = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " '' ")
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .replace(/"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g, ' ident ')
  return clean.toLowerCase().match(/[a-z_][a-z0-9_]*|[();]/g) ?? []
}

/** Every kind of statement the text would run, nested ones included. */
export function statementKinds(sql: string): string[] {
  const kinds = new Set<string>()
  const t = tokens(sql)
  let start = true
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!
    if (tok === ';') {
      start = true
      continue
    }
    if (start) {
      start = false
      if (tok === 'with') {
        kinds.add(mainAfterWith(t, i))
      } else if (tok === 'explain') {
        kinds.add('explain')
        // EXPLAIN ANALYZE runs the statement it explains
        if (t.slice(i + 1, i + 4).includes('analyze')) {
          const inner = t.slice(i + 1).find(x => VERBS.has(x) && x !== 'analyze')
          if (inner) kinds.add(inner)
        }
      } else {
        kinds.add(VERBS.has(tok) ? tok : 'unknown')
      }
      continue
    }
    // a statement opening a parenthesis: subqueries and data-modifying CTEs
    // (replace( and the like are function calls, not statements)
    if (t[i - 1] === '(' && t[i + 1] !== '(' && VERBS.has(tok) && tok !== 'values') kinds.add(tok)
  }
  return [...kinds]
}

function mainAfterWith(t: string[], from: number) {
  let depth = 0
  for (let i = from + 1; i < t.length; i++) {
    const tok = t[i]!
    if (tok === '(') depth++
    else if (tok === ')') depth--
    else if (tok === ';') break
    else if (depth === 0 && VERBS.has(tok) && tok !== 'with') return tok
  }
  return 'unknown'
}

export const isReadOnly = (sql: string) => statementKinds(sql).every(k => READS.has(k))
