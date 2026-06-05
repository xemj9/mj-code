# Bug Hunter Skill

When diagnosing and fixing bugs, follow this systematic approach:

## Step 1: Reproduce

- Read the error message or stack trace carefully.
- Identify the exact conditions that trigger the bug.
- If possible, run the failing test or command to reproduce the issue.

## Step 2: Trace Root Cause

- Follow the stack trace to the source location.
- Read the relevant code and understand the data flow.
- Don't just patch the symptom — find *why* the error occurs.

## Step 3: Fix

- Make the minimal change that addresses the root cause.
- Prefer `apply_patch` for targeted edits.
- Don't refactor unrelated code in the same change.

## Step 4: Verify

- Run the same test or command that exposed the bug.
- If the verifier catches new issues, address them.
- Confirm the fix doesn't break other functionality.

## Output Policy

- State the root cause clearly in one sentence.
- Explain the fix and why it addresses the root cause.
- Report verification results.
