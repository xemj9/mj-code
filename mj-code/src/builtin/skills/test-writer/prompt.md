# Test Writer Skill

When writing tests, follow this systematic approach:

## Test Structure

1. **Happy Path**: Does the function/module work correctly with valid input?
2. **Edge Cases**: Empty input, boundary values, large input, concurrent access.
3. **Error Conditions**: Invalid input, missing dependencies, network failures.
4. **Integration**: Does it work correctly with other modules?

## Before Writing

- Find and read existing test files to match the project's test patterns.
- Read the implementation to understand what to test.
- Identify the public API and exported functions.

## Writing

- Follow the project's existing test framework (Node test runner, Jest, etc.).
- Use descriptive test names that explain the expected behavior.
- One assertion per test when possible.
- Keep tests independent — no shared mutable state.

## After Writing

- Run the new tests and verify they pass.
- Run the full test suite to check for regressions.
- Report coverage gaps: what is still not tested.
