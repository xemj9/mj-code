# Contributing to MJ Code

Thanks for your interest in contributing! Here's how to get started.

## Quick Start

```bash
git clone https://github.com/xiemingjin/mj-code.git
cd mj-code
npm install
npm run typecheck
npm run build
npm test
```

## Development Workflow

1. Fork the repo and create a feature branch
2. Make your changes with surgical edits (prefer `apply_patch` over rewrites)
3. Run `npm run typecheck` and `npm test` before pushing
4. Open a pull request with a clear description

## Code Style

- TypeScript for all new modules (`.mts` for source, `.ts` for pure type files)
- Zero runtime dependencies — do not add npm packages without strong justification
- Keep terminal output concise and readable
- Preserve the mixed JS/TS compatibility shim pattern when migrating modules
- Update README usage examples when adding user-facing features

## Testing

```bash
# Run all tests
npm test

# Run a specific test
node --import tsx --test test/agent.mock.test.mjs
```

## Reporting Issues

- Use GitHub Issues
- Include your Node.js version (`node -v`)
- Include steps to reproduce
- Include relevant terminal output

## Adding Skills

Create a directory under `src/builtin/skills/` or `.mj-code/skills/`:

```
my-skill/
  skill.json    # manifest
  prompt.md     # prompt fragment
```

See existing skills for examples.

## Adding Plugins

Create a directory under `.mj-code/plugins/`:

```
my-plugin/
  manifest.json   # plugin manifest
  index.mjs       # entry module with register() function
```

See README for the full plugin API.
