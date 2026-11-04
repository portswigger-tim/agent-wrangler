---
name: report-extension-issue
description: Use when an Agent Wrangler extension misbehaves mid-session (one of its tools errors or returns nonsense, its skill's instructions are wrong, it is quarantined) and the human should report it to the extension's owner. Drafts the issue with the report_extension_issue tool; never files it yourself.
---

# Report an extension issue

When an extension, not your own work, is what went wrong, draft an issue for its
owner with `report_extension_issue`. It returns a new-issue URL with the title
and body filled in. **The human reviews and submits it.** You never post it:
no `gh issue create`, no GitHub API call, no comment on an existing issue.

## When

- One of an extension's MCP tools fails, or returns something that contradicts
  its own description.
- An extension's skill tells you to do something that does not work.
- The human mentions an extension is broken or quarantined.

Not for problems in your own code or the repository you are working on, and not
for Agent Wrangler's own core tools unless the human asks. Report each problem
once per session.

## How

1. Find the extension id. A tool's owner is in its name or description; the
   human can also see it in Settings → Extensions.
2. Call `report_extension_issue` with:
   - `extensionId`
   - `title`: one line, the symptom (`list_widgets returns an empty list after a restart`).
   - `description`: what you did, what happened, what you expected, and the exact
     error text.
   - `steps`: numbered steps, when you know them.
   The tool adds the extension version, installed commit, Agent Wrangler version,
   host API, enabled or quarantine state and OS itself, so don't repeat them.
3. Give the human the `url` with one line on what it reports. If `prefilled` is
   false, or `truncated` is true, also give them the `title` and `body` to paste.

Leave out secrets, tokens, customer data and private paths: the issue may be
public. If the tool says the extension names no issue tracker, tell the human
what went wrong instead.
