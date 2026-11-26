# 3. Reversible tokens in memory, not masks

November 2026

## Context

Masking personal data before the model sees it is the easy half. The hard half is that the agent usually needs that data to do its job: it looks up a customer, then emails them or refunds them. If the email address comes back as `****`, the agent is useless; if it comes back in clear, the model provider has it and so does every log.

## Decision

Values found in tool results become tokens of the form `[EMAIL_2ec3e7fe]`: the kind, then eight hex digits of an HMAC of the value under a key generated at start-up. The same value always gets the same token within a run, so the model can reason about "this customer" consistently. When the agent sends a token back as a tool argument, Sceau puts the value back before forwarding the call, and tells the policy which kinds it restored (`carries`).

The table from token to value lives only in the proxy's memory, capped and oldest-first. The ledger, the console, the evidence packs and the model only ever see tokens.

Detection checks what can be checked: IBAN length by country and mod 97, card numbers by Luhn, key formats by provider. That keeps order numbers and timestamps readable.

## Consequences

`carries` turned out to be the useful part. "Mail to an address that came out of our CRM is fine, mail to an address the agent typed is held, mail carrying an IBAN is refused" is one rule each, and it is the distinction a security team actually wants.

A restart forgets every token. An agent that still holds one gets the token text back instead of the value and the tool call fails visibly; we prefer that to writing the table to disk. Several replicas behind a load balancer would need a shared, encrypted store for the table, which is a later problem.
