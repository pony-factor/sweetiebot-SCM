# Sweetiebot commit instructions starter kit

Commit titles should start with one professional emoji that matches the change type, followed by a space and a concise imperative title.

Briefly describe the actual staged change in the title.

When committing directly to main, add one or two descriptive body sentences explaining what changed and why.

Do not add co-author trailers, signatures, or other metadata to generated text; Sweetiebot handles those separately.

Generated commit subjects use change-type emojis; descriptions contain no emojis. A custom ordered priority list takes precedence. Bug-fix emojis are chosen randomly for each new fix on main, but reused within each PR branch, including concurrent commit-generation jobs. Do not inherit a PR branch's emoji from main or a stacked branch's parent. Equivalent nonrandom choices use the first listed emoji.
