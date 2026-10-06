---
name: fulldev
description: Use when the person wants to change their Fulldev website, such as text, pages, images, prices, opening hours, or contact details, or publish a change.
---

# Fulldev

The `fulldev` CLI edits the person's website repository through the Fulldev CMS. Every change goes to a branch and a draft pull request, within the file permissions Fulldev grants the person.

## Run

Use `fulldev` when it is installed. Otherwise run every command as `npx -y fulldev <command>`.

Results are JSON on stdout. Hints and errors go to stderr. Exit codes: 0 done, 1 error, 2 form wait timed out, 3 sign-in needed.

## Sign in

Run `fulldev login`. It opens the browser, where the person signs in and picks their organization, and waits up to five minutes. Tell the person a sign-in page opened. Any other command also starts a sign-in when needed. `fulldev status` shows who is signed in.

## First, read the instructions

Run `fulldev instructions` at the start of every session and follow them. They come from the server and describe the workflow, permissions, allowance, previews, reviews, and merging. They win over anything in this skill.

`fulldev tools` lists the tools. `fulldev tools <name>` shows a tool's description and input schema; read it before the first call to a tool.

## Edit

Call a tool with a JSON object as the argument, from a file with `--file`, or from stdin with `-`:

```sh
fulldev call list_projects
fulldev call open_branch '{"projectId":"<id>","name":"Update opening hours"}'
fulldev call read_file '{"branchId":"<id>","path":"src/content/home.md"}'
fulldev call commit_files - <<'JSON'
{"branchId":"<id>","expectedRevision":"<revision>","changes":[{"path":"src/content/home.md","edits":[{"oldText":"Open 9 to 5","newText":"Open 8 to 6"}]}]}
JSON
fulldev call get_preview '{"branchId":"<id>"}'
```

Pass the latest revision as `expectedRevision`. Use stdin or `--file` for long or quoted text, so the shell does not change it.

## Forms

After `create_form`, give the person the form link. Then run:

```sh
fulldev form wait <branchId> <formId>
```

Run it in the background when you can, so you can keep talking to the person. It prints the answers when the person sends the form. On exit code 2 it stopped waiting; run it again, or continue when the person says they are done.

By default the CMS writes the answers to the branch and commits them itself. Then check the result with `get_diff` and the preview, and do not write the answers again. Write them yourself only when the form was created with `apply` false.
