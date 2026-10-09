---
"fulldev": minor
---

Every app through one Fulldev MCP server, at `https://app.full.dev/mcp`, with one sign-in. `fulldev login`, `fulldev status` and `fulldev logout` no longer take an app, and `status` and `logout` print that one sign-in as one object instead of a list under `apps`; a sign-in error names `fulldev login`. Each app's tools start with its name, such as `cms_list_repositories`. `fulldev instructions`, `fulldev tools` and `fulldev call` work across every app you may use; `fulldev <app> instructions|tools|call` show and call that app's part, with tool names with or without its prefix. `FULLDEV_URL` replaces `FULLDEV_<APP>_URL`.
