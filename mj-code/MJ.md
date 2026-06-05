# MJ Code Project Instructions

## General Rules

- prefer surgical edits over rewrites
- use apply_patch when a multi-line targeted edit is enough
- preserve the zero-dependency runtime unless there is a strong reason to add packages
- keep terminal output concise and readable
- update README usage examples when adding a user-facing feature
- keep provider integrations fallback-friendly because gateways vary in API compatibility

@rule code-style: prefer-apply-patch
@rule deps: zero-runtime-deps
@rule output: concise-and-readable
