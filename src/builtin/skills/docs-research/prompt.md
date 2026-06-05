# Docs Research Skill

When the task depends on external knowledge, follow these principles:

## Retrieval Strategy

1. **Prefer official documentation over blog posts or tutorials.**
   - Look for `docs.*`, `developers.*`, `api.*` domains first.
   - Prioritize canonical sources: official API references, RFCs, spec documents.

2. **Prefer primary sources over secondary write-ups.**
   - Go to the original GitHub repo, not a Medium summary.
   - Read the actual spec, not someone's interpretation.

3. **Preserve source-qualified names.**
   - When multiple tools, providers, or libraries overlap, use fully qualified names
     to avoid ambiguity (e.g., `OpenAI web_search` vs `Brave web_search`).

4. **Cite your sources.**
   - Always include `[S1]`, `[S2]` citations when web-derived information informs the answer.
   - If the model forgets to cite, the runtime will append a fallback Sources block.

## Network Mode Awareness

- In `docs-only` mode, only official docs/API/release/source-code URLs are accessible.
- In `open-web` mode, all URLs are accessible but still ranked by trust.
- Always check `/network-mode` if web access seems restricted.

## Output Policy

- Summarize key findings concisely.
- Include direct links to canonical documentation.
- Flag when information might be outdated (check `retrievedAt` timestamps).
