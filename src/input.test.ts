import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vite-plus/test"

import { UsageError } from "./errors.ts"
import { parseTextFiles, readToolArguments } from "./input.ts"

const noStdin = () => Promise.reject(new Error("stdin was read"))
const stdin = (text: string) => () =>
  Promise.resolve(new TextEncoder().encode(text))

describe("readToolArguments", () => {
  it("defaults to an empty object", async () => {
    expect(await readToolArguments({ readStdin: noStdin })).toEqual({})
  })

  it("parses the argument", async () => {
    expect(
      await readToolArguments({ json: '{"path":"a.md"}', readStdin: noStdin }),
    ).toEqual({ path: "a.md" })
  })

  it("reads stdin for -", async () => {
    expect(
      await readToolArguments({
        json: "-",
        readStdin: stdin('{"n":1}\n'),
      }),
    ).toEqual({ n: 1 })
    expect(
      await readToolArguments({
        json: "-",
        readStdin: stdin(""),
      }),
    ).toEqual({})
  })

  it("reads a file", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "fulldev-")), "in.json")
    await writeFile(path, '{"files":[{"path":"a.md","content":"x"}]}')
    expect(await readToolArguments({ file: path, readStdin: noStdin })).toEqual(
      {
        files: [{ path: "a.md", content: "x" }],
      },
    )
  })

  it.each([
    [{ json: "{bad" }, /not valid JSON/],
    [{ json: "[1]" }, /must be a JSON object/],
    [{ json: "null" }, /must be a JSON object/],
    [{ json: '"text"' }, /must be a JSON object/],
    [{ json: "{}", file: "x.json" }, /not both/],
    [{ file: "/does/not/exist.json" }, /Cannot read/],
  ])("rejects %j", async (source, message) => {
    const result = readToolArguments({ ...source, readStdin: noStdin })
    await expect(result).rejects.toThrow(UsageError)
    await expect(result).rejects.toThrow(message)
  })
})

describe("--text-file", () => {
  const folder = mkdtemp(join(tmpdir(), "fulldev-text-"))
  const file = async (content: string | Uint8Array) => {
    const path = join(await folder, `${Math.random()}.md`)
    await writeFile(path, content)
    return path
  }
  const read = async (
    json: string | undefined,
    specs: Array<string>,
    readStdin: () => Promise<Uint8Array> = noStdin,
  ) =>
    readToolArguments({
      json,
      textFiles: parseTextFiles(specs, json),
      readStdin,
    })

  it.each([
    ["CRLF", "# Title\r\n\r\nLine one\r\nLine two\r\n"],
    ["Unicode", "Café ✓ 👩🏽‍💻 e\u0301 日本語"],
    ["indentation", "  - item\n\t- tab\n    code block\n"],
    ["empty", ""],
    ["a trailing newline", "text\n\n"],
    ["no trailing newline", "text"],
    ["a byte order mark", "\uFEFFtext"],
    ["only whitespace", " \n\t \n"],
  ])("keeps %s exactly", async (_, text) => {
    const input = await read("{}", [`content=${await file(text)}`])
    expect(input.content).toBe(text)
    const piped = await read("{}", ["content=-"], stdin(text))
    expect(piped.content).toBe(text)
  })

  it("sets fields inside existing arrays and new objects, keeping the rest", async () => {
    const path = await file("Hello\n")
    const input = await read(
      '{"pageId":"p","expectedVersion":3,"content":{"blocks":[{"type":"text"}]},"changes":[{"path":"a.md"},{"path":"b.md"}]}',
      [
        `content.blocks.0.markdown=${path}`,
        `changes.1.content=${path}`,
        `brief.about=${path}`,
      ],
    )
    expect(input).toEqual({
      pageId: "p",
      expectedVersion: 3,
      content: { blocks: [{ type: "text", markdown: "Hello\n" }] },
      changes: [{ path: "a.md" }, { path: "b.md", content: "Hello\n" }],
      brief: { about: "Hello\n" },
    })
  })

  it("reads the JSON from a file and the text from stdin", async () => {
    const json = await file('{"taskId":"t"}')
    expect(
      await readToolArguments({
        file: json,
        textFiles: parseTextFiles(["notes=-"], undefined),
        readStdin: stdin("New notes\n"),
      }),
    ).toEqual({ taskId: "t", notes: "New notes\n" })
  })

  it.each([
    ["__proto__.polluted=x"],
    ["constructor.prototype.polluted=x"],
    ["a.__proto__=x"],
    ["prototype=x"],
  ])("refuses the prototype field %s", (spec) => {
    expect(() => parseTextFiles([spec], undefined)).toThrow(UsageError)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it.each([
    [["content"], /<field>=<path>/],
    [["=a.md"], /<field>=<path>/],
    [["content="], /<field>=<path>/],
    [["a..b=x"], /needs a field/],
    [["content=a.md", "content=b.md"], /twice/],
    [["content=a.md", "content.text=b.md"], /inside it/],
    [["a=-", "b=-"], /one input can come from stdin/],
  ])("refuses %j", (specs, message) => {
    expect(() => parseTextFiles(specs, undefined)).toThrow(message)
  })

  it("refuses stdin for both the JSON and a text", () => {
    expect(() => parseTextFiles(["content=-"], "-")).toThrow(
      /one input can come from stdin/,
    )
  })

  it.each([
    ['{"content":"old"}', "content", /already has content/],
    ['{"content":null}', "content", /already has content/],
    [
      '{"changes":[{"path":"a","content":"x"}]}',
      "changes.0.content",
      /already/,
    ],
    ['{"changes":[{"path":"a"}]}', "changes.1.content", /no item 1/],
    ['{"changes":[{"path":"a"}]}', "changes.first.content", /no item first/],
    ['{"changes":[{"path":"a"}]}', "changes.0", /array element/],
    ["{}", "changes.0.content", /changes is missing/],
    ['{"title":"x"}', "title.text", /title is not an object/],
    ['{"changes":["a.md"]}', "changes.0.content", /changes.0 is not an object/],
  ])("refuses to set into %s at %s", async (json, field, message) => {
    const path = await file("text")
    await expect(read(json, [`${field}=${path}`])).rejects.toThrow(message)
  })

  it("refuses text that is not UTF-8 or a file that is missing", async () => {
    const path = await file(new Uint8Array([0x61, 0xff, 0x62]))
    await expect(read("{}", [`content=${path}`])).rejects.toThrow(
      /not valid UTF-8/,
    )
    await expect(read("{}", ["content=/does/not/exist.md"])).rejects.toThrow(
      /Cannot read/,
    )
  })
})
