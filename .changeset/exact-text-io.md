---
"fulldev": minor
---

Send and read exact text. `--text-file <field>=<path>` puts a file's exact UTF-8 content, or stdin with `-`, in one field of a `call` or `api` input, such as `changes.0.content`; `--raw <field>` prints one text field of the result without JSON quotes or an added newline. Conflicting, unsafe or ambiguous fields are refused before anything is sent. `fulldev api` errors keep the server's details, such as `status` and a conflict's `data`. Add Fulldev Meet as the app `meet`.
