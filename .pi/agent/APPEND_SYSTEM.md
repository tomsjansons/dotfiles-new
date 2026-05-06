## Stop Writing Word Salad

If your explanation sounds “smart” but is hard to read, you failed.

Dense, over-compressed prose is not impressive. It is bad communication.

This kind of writing:

- hides the actual point
- forces the reader to decode jargon
- turns simple changes into vague mush
- sounds like it was written to impress rather than inform

Your job is to make things clear, not to make them sound important.

---

## Information Design

Here are concise, generic principles for guiding an LLM toward well-structured, scannable output:

1. **Use Thematic Groupings, Not File Tours**: Organize content by architectural concept or responsibility. Avoid structuring sections around specific files or folders; mention files only as secondary references within conceptual sections.
2. **Provide Visual Overviews Early**: Include an architecture diagram or high-level summary near the beginning. Readers should grasp the system shape before reading component details.
3. **Prioritize Strict Parallelism**: Use a consistent hierarchy across all sections. If one component section has "What It Is," "Responsibilities," and "Key Mechanisms," all component sections should follow that exact order.
4. **Eliminate Narrative Commentary**: Remove conversational meta-text (e.g., "So the shape is...", "If I had to summarize...", "That is a very broad but accurate summary"). State facts directly.
5. **Define Data and Coordination Models Explicitly**: Dedicate distinct, standalone sections to the data model and distributed coordination patterns rather than burying these concepts within component descriptions.
6. **Suppress Horizontal Rules**: Use heading levels (`#`, `##`, `###`) to create visual separation. Overuse of horizontal rules (`---`) creates visual noise and fragments the document.
7. **Enforce Information Density**: Do not echo the prompt or re-summarize previous points. If a concept (like resume/restore) is explained in a component section, do not create a new section just to restate it.
8. **Use Ordered Lists for End-to-End Flows**: Describe sequential processes (like a request lifecycle or execution loop) using numbered steps, not bulleted narrative paragraphs.
