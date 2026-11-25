import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { type Call, checkPolicy, decide } from '../src/policy.ts'
import { isReadOnly, statementKinds } from '../src/sql.ts'

describe('sql', () => {
  it.each([
    ['select * from customers where id = 4', ['select']],
    ['SELECT 1; DELETE FROM customers', ['select', 'delete']],
    ["select 'drop table x' as s -- delete everything", ['select']],
    ['with gone as (delete from orders returning *) select count(*) from gone', ['select', 'delete']],
    ['WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SELECT * FROM t', ['select']],
    ['explain analyze delete from orders', ['explain', 'delete']],
    ['explain select 1', ['explain']],
    ['select * from accounts for update', ['select']],
    ["select replace(name, 'a', 'b') from t", ['select']],
    ['/* hi */ TRUNCATE "Customers"', ['truncate']],
    ['insert into t values (1), (2)', ['insert']],
    ['frobnicate the table', ['unknown']],
  ])('%s', (sql, kinds) => {
    expect(statementKinds(sql)).toEqual(kinds)
  })

  it('treats anything unplaced as a write', () => {
    expect(isReadOnly('select 1')).toBe(true)
    expect(isReadOnly('frobnicate')).toBe(false)
  })
})

const policy = checkPolicy(
  parse(`
rules:
  - name: no deletes, ever
    match: "*/query"
    if: [{ sql: [delete, drop, truncate] }]
    then: deny
  - name: reads in the warehouse
    match: warehouse/query
    if: [{ sql_only: [select] }]
    then: allow
  - name: refunds above 200 EUR wait for a person
    match: payments/refund
    if: [{ arg: amount, gt: 200 }]
    then: hold
  - match: payments/refund
    then: allow
  - name: mail outside the company waits
    match: send_email
    if: [{ arg: to, domain_not: [acme.eu] }]
    then: hold
  - name: an IBAN never leaves by mail
    match: send_email
    if: [{ carries: [iban] }]
    then: deny
default:
  read: allow
  write: hold
`),
)

const call = (server: string, tool: string, args: Record<string, unknown>, extra: Partial<Call> = {}): Call => ({
  server, tool, args, access: 'unknown', carries: [], ...extra,
})

describe('policy', () => {
  it('lets a select through and stops a delete hidden behind one', () => {
    expect(decide(policy, call('warehouse', 'query', { sql: 'select * from orders' }))).toEqual({ verdict: 'allow', rule: 'reads in the warehouse' })
    expect(decide(policy, call('warehouse', 'query', { sql: 'select 1; delete from orders' })).verdict).toBe('deny')
  })

  it('holds a refund above the threshold, lets the small ones go', () => {
    expect(decide(policy, call('payments', 'refund', { amount: 450 })).verdict).toBe('hold')
    expect(decide(policy, call('payments', 'refund', { amount: '120.00' })).verdict).toBe('allow')
  })

  it('reads every address, display names included', () => {
    expect(decide(policy, call('mail', 'send_email', { to: ['ops@acme.eu', 'Jo <jo@gmail.com>'] })).verdict).toBe('hold')
    expect(decide(policy, call('mail', 'send_email', { to: 'paris@eu.acme.eu' })).verdict).toBe('hold')
    expect(decide(policy, call('mail', 'send_email', { to: 'ops@acme.eu' }, { carries: ['iban'] })).verdict).toBe('deny')
  })

  it('falls back on what the server says the tool does', () => {
    expect(decide(policy, call('crm', 'get_customer', {}, { access: 'read' }))).toEqual({ verdict: 'allow' })
    expect(decide(policy, call('crm', 'merge_customers', {}, { access: 'unknown' }))).toEqual({ verdict: 'hold' })
  })

  it('refuses a rule it cannot read', () => {
    expect(() => checkPolicy(parse('rules: [{ match: "*", then: alow }]'))).toThrow(/allow, deny or hold/)
    expect(() => checkPolicy(parse('rules: [{ match: "*", then: deny, if: [{ grater: 3 }] }]'))).toThrow(/unknown condition grater/)
  })
})
