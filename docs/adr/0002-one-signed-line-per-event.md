# 2. One signed, chained, fsynced line per event

November 2026

## Context

The ledger is the product as far as an auditor is concerned. It must show that nothing was removed, reordered or edited, be checkable by someone who does not run our software, and survive a crash between "approved" on screen and the call going out.

The usual options were a database with audit triggers (trusted only as far as its administrator), a Merkle tree with signed roots in batches (efficient, but entries between two roots are not yet protected), or a plain hash chain.

## Decision

An append-only JSON Lines file. Each entry carries the SHA-256 of its canonical content (keys sorted at every level) and of the previous entry, and an Ed25519 signature over that hash. Every append is written and `fdatasync`ed before the call it records goes on. Arguments and results are stored after masking, with a digest of the raw result.

Evidence packs carry a slice of the file, the hash it chains from, the public key, and a manifest signed over the exact bytes of every file, so `openssl pkeyutl -verify` is enough to trust the manifest and `sha256sum` enough for the rest.

## Consequences

Measured on a laptop NVMe: 0.6 ms per entry including the signature and the fsync, about 1,700 entries a second, and around 100 µs per entry to verify. A tool call writes two or three entries, so the cost is a millisecond against calls that take tens or hundreds.

A chain does not prove its own end: truncating the file leaves a valid, shorter chain. Packs pin the head they were made at; the real answer is anchoring the head outside the machine on a schedule, which is the first thing to add for a production deployment. Likewise the key sits next to the ledger, readable by whoever runs the proxy: it protects against later edits by anyone else, not against the operator, until it moves into a KMS.
