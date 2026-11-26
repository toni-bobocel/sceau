# 1. Intercept the wire, and fail closed

November 2026

## Context

Guardrails for agents usually live inside the agent: a callback in LangChain, a hook in the Agents SDK, middleware in a framework. A company running three agent stacks then has three implementations of the same policy, each with its own gaps, and the security team cannot point at one place and say "this is where calls are checked".

MCP changes the shape of the problem. Tool calls are JSON-RPC messages over two transports, stdio and Streamable HTTP, and that is true whichever language or framework the agent uses.

## Decision

Sceau is a proxy on the transport. It parses JSON-RPC, tracks request ids to pair results with calls, and leaves everything it does not care about untouched. One `Gate` holds the whole pipeline (decide, hold, mask, scan, record) and two thin adapters feed it: the HTTP endpoint, and a relay that `sceau wrap` uses for stdio servers.

Wherever it has to choose, it refuses:

- a policy with a typo does not load, and the proxy does not start;
- a call no rule covers waits for a person unless the server declared the tool read-only;
- `wrap` without a reachable proxy refuses calls and withholds results;
- a ledger that no longer verifies at start-up stops the proxy, so nothing new is chained onto a tampered history.

## Consequences

Any MCP client and server work unchanged, including ones written in languages we do not use. The cost is owning protocol details an SDK would hide: Streamable HTTP's mix of JSON and event-stream answers, session ids, and the clients' own timeouts, which is why a held call answers as a stream with progress notifications.

Failing closed means an outage of Sceau is an outage of the agents' write access. That is the trade a company buying this wants; reads could be allowed through in a degraded mode later, explicitly.
