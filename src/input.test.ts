import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vite-plus/test"

import { UsageError } from "./errors.ts"
import { readToolArguments } from "./input.ts"

const noStdin = () => Promise.reject(new Error("stdin was read"))

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
        readStdin: () => Promise.resolve('{"n":1}\n'),
      }),
    ).toEqual({ n: 1 })
    expect(
      await readToolArguments({
        json: "-",
        readStdin: () => Promise.resolve(""),
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
