---
name: report-extension-issue
description: Use when an Agent Wrangler extension misbehaves mid-session (one of its tools errors or returns nonsense, its skill's instructions are wrong, it is quarantined), or when the human wishes a specific installed extension did something differently ("I wish X had…", "X should…", "it'd be nice if X…"). Drafts a bug report, or after the human says yes a feature request, with the report_extension_issue tool; never files it yourself.
---

# Report an extension issue or request a feature

`report_extension_issue` drafts an issue for an extension's owner and returns a
new-issue URL with the title and body filled in. **The human reviews and
submits it.** You never post it: no `gh issue create`, no GitHub API call, no
comment on an existing issue.

It covers extensions installed from git, and core extensions (whose issues go
to Agent Wrangler's own repository). Find the extension id from a tool's name or
description, or ask the human to check Settings → Extensions.

## Bugs: `kind: "bug"` (the default)

Draft one when an extension, not your own work, is what went wrong:

- One of its MCP tools fails, or returns something that contradicts its own
  description.
- Its skill tells you to do something that does not work.
- The human mentions it is broken or quarantined.

Not for problems in your own code or the repository you are working on, and not
for Agent Wrangler's core tools unless the human asks. Report each problem once
per session.

Pass `title` (one line, the symptom), `description` (what you did, what happened,
what you expected, the exact error text) and `steps` when you know them.

## Feature requests: `kind: "feature"`, only after a yes

When the human wishes a **specific** extension did something differently ("I
wish the widgets panel showed totals", "it'd be nice if the Jira chip had the
status"), **offer** in one line:

> Want me to draft a feature request for acme/widgets-ext?

Then:

- Draft it only if they say yes. Offer at most once per wish, and never draft one
  unprompted.
- A vague grumble ("this is slow", "I hate this UI") gets no offer unless it is
  clearly about one extension.
- Pass `title` (the wish in a line), `description` (what they would like), `why`
  (what they were doing, or why it matters) and `how` if they described how it
  might look. Use their words; don't invent requirements.

## Then

The tool adds the extension version and Agent Wrangler version itself, plus the
commit, host API, state and OS for a bug, so don't repeat them. Give the human
the `url` with one line on what it asks for. If `prefilled` is false, or
`truncated` is true, also give them the `title` and `body` to paste.

Leave out secrets, tokens, customer data and private paths: the issue may be
public. If the tool says the extension names no issue tracker, tell the human
instead.
