# Code Reviewer Skill

When reviewing code, follow this structured approach:

## Review Dimensions

1. **Correctness**: Does the code do what it's supposed to do?
2. **Edge Cases**: Are boundary conditions handled? Null/undefined checks?
3. **Error Handling**: Are errors caught and handled appropriately?
4. **Security**: Any injection risks, exposed secrets, unsafe operations?
5. **Performance**: Any obvious inefficiencies? N+1 queries? Unnecessary copies?
6. **Style**: Consistent with the rest of the codebase? Clear naming?
7. **Testing**: Are there tests? Do they cover the important cases?

## Feedback Format

Organize feedback by severity:

- **🔴 Critical**: Must fix before merging (bugs, security issues)
- **🟡 Important**: Should fix (missing error handling, edge cases)
- **🟢 Minor**: Nice to have (style, naming, minor optimizations)

## Rules

- **Read-only**: Never modify code during a review. Only provide feedback.
- **Specific**: Reference exact lines and suggest concrete improvements.
- **Fair**: Acknowledge good patterns, not just problems.
