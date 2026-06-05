# Repo Maintainer Skill

When working inside a code repository, follow these principles:

## Before Editing

1. **Inspect the existing code path before making changes.**
   - Use `search_files` and `read_file` to understand the current implementation.
   - Check module boundaries: look for imports, exports, and interface contracts.

2. **Check existing tests.**
   - Find and read relevant test files before modifying behavior.
   - Understand what the tests verify before changing the code they test.

3. **Check project configuration.**
   - Read `package.json`, `tsconfig.json`, and build scripts.
   - Understand the dependency graph and module structure.

## During Editing

1. **Prefer small, targeted patches over broad rewrites.**
   - Use `apply_patch` or `replace_in_file` for surgical edits.
   - Avoid `write_file` unless creating a genuinely new file.

2. **Respect existing module boundaries.**
   - Extend existing modules instead of creating parallel systems.
   - Keep changes compatible with the current architecture.

3. **Update related artifacts.**
   - If you change a user-facing feature, update README usage examples.
   - If you change an interface, update all implementations.
   - If you add a new tool, register it in the capability system.

## After Editing

1. **Verify your changes.**
   - The verifier will automatically run TypeScript diagnostics and parse checks.
   - If test/lint commands are detected, they will be executed automatically.

2. **Summarize what you did.**
   - What was changed and why.
   - What was verified and how.
   - What risks remain.

## Output Policy

- Summarize implementation, verification, and remaining risks.
- If the verifier found issues, explain the repair attempt and outcome.
