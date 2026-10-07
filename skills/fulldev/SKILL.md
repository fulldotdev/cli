---
name: fulldev
description: Use the Fulldev CLI to work with Fulldev products for the person. Use cms when they want to change their Fulldev website, such as text, pages, images, prices, opening hours, or contact details, or publish a change. Use connect when they want to use their business tools, such as Shopify, through Fulldev Connect. Use scan to scan websites, only for Fulldev administrators. Use sites when they want Fulldev to make a new website from a brief, only for Fulldev administrators for now.
license: MIT
compatibility: Needs Node.js 24 or later and network access to cms.full.dev, connect.full.dev, scan.full.dev, sites.full.dev and clerk.full.dev.
---

# Fulldev

The `fulldev` CLI talks to the MCP server of each Fulldev product. The tools, their schemas and the instructions come from the server, so they are always current.

| Product   | For                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `cms`     | Editing the person's website. Every change goes to a branch and a draft pull request, within the file permissions Fulldev grants the person. |
| `connect` | The person's business tools, such as Shopify, with the access their organization grants them.                                                |
| `scan`    | Scanning websites. Only for Fulldev administrators.                                                                                          |
| `sites`   | Making a new website with Fulldev Sites from a brief and design options. Only for Fulldev administrators for now.                            |

## Run

Use `fulldev` when it is installed. Otherwise run every command as `npx -y fulldev <command>`.

Every product has the same commands:

```sh
fulldev <product> instructions          # read first
fulldev <product> tools                 # list the tools
fulldev <product> tools <name>          # one tool: description, input and output schema
fulldev <product> call <tool> '<json>'  # call a tool
```

Data is JSON on stdout. Progress lines go to stderr. Every error is one JSON object on stderr, `{"error":{"code":"...","message":"..."}}`.

Exit codes:

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | Done                                                                  |
| 1    | Error, from the tool or the CLI                                       |
| 2    | `form wait` stopped waiting                                           |
| 3    | Sign-in needed; the error says which `fulldev login <product>` to run |
| 64   | The command was called wrongly; the error names the help to read      |

`fulldev --help`, `fulldev <product> --help` and `fulldev <product> <command> --help` explain every command.

## Sign in

The person signs in once per product with their Fulldev account and picks an organization:

```sh
fulldev login cms          # opens the browser
fulldev login              # every product, one after the other
fulldev status             # per product: signed in, still valid, email, organization, expiry
fulldev logout cms         # revokes the sign-in and deletes the tokens
```

Tell the person a sign-in page opened, or give them the link from stderr. Login waits up to five minutes.

Without a terminal, as when you run commands, a product command never starts a sign-in: it exits with 3 at once. Then run the `fulldev login <product>` from the error and ask the person to finish it. The organization is chosen at sign-in; to switch organization, run `fulldev login <product>` again.

## First, read the instructions

Run `fulldev <product> instructions` at the start of every session and follow them. They come from the server and describe the workflow, permissions and limits. They win over anything in this skill.

Read `fulldev <product> tools <name>` before the first call to a tool.

## Call tools

Give a tool's input as a JSON argument, from a file with `--file`, or from stdin with `-`. Use stdin or `--file` for long or quoted text, so the shell does not change it.

```sh
fulldev cms call list_projects
fulldev cms call read_file '{"branchId":"<id>","path":"src/content/home.md"}'
fulldev cms call commit_files - <<'JSON'
{"branchId":"<id>","expectedRevision":"<revision>","changes":[{"path":"src/content/home.md","edits":[{"oldText":"Open 9 to 5","newText":"Open 8 to 6"}]}]}
JSON
```

## Forms in the CMS

After `create_form`, give the person the form link. Then run:

```sh
fulldev cms form wait <branchId> <formId>
```

Run it in the background when you can, so you can keep talking to the person. It prints the answers when the person sends the form. On exit code 2 it stopped waiting; run it again, or continue when the person says they are done.

By default the CMS writes the answers to the branch and commits them itself. Then check the result with `get_diff` and the preview, and do not write the answers again. Write them yourself only when the form was created with `apply` false.
