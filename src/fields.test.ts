import { describe, expect, it } from "vite-plus/test"

import { parseField, ruledOutText } from "./fields.ts"

const field = (text: string) => parseField(text, "--raw")

describe("ruledOutText", () => {
  const receipt = {
    type: "object",
    properties: {
      pageId: { type: "string" },
      version: { type: "integer" },
      blocks: { type: "array", items: { $ref: "#/$defs/block" } },
      submittedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    $defs: {
      block: {
        type: "object",
        properties: { markdown: { type: "string" } },
        additionalProperties: false,
      },
    },
  }

  it.each([
    ["version", "version is an integer"],
    ["pageId.sha", "pageId is a string, so it has no sha"],
    ["blocks.0.title", "blocks.0 has no title"],
    ["blocks.0.markdown.x", "blocks.0.markdown is a string, so it has no x"],
    ["blocks.first", "blocks is an array, so it has no first"],
  ])("rules out %s", (path, reason) => {
    expect(ruledOutText(receipt, field(path))).toBe(reason)
  })

  it.each([
    "pageId",
    "blocks.0.markdown",
    "submittedAt",
    // Not declared, and the object is open.
    "markdown",
    "anything.deeper",
  ])("allows %s", (path) => {
    expect(ruledOutText(receipt, field(path))).toBeUndefined()
  })

  it.each([
    ["no schema", undefined],
    ["an empty schema", {}],
    ["the server's open response schema", { anyOf: [{}, { not: {} }] }],
    ["an unknown reference", { $ref: "https://example.com/page.json" }],
    ["a reference cycle", { $ref: "#" }],
    [
      "a union with an open branch",
      { anyOf: [{ type: "integer" }, { type: "object" }] },
    ],
    [
      "a pattern of properties",
      {
        type: "object",
        patternProperties: { "^m": { type: "string" } },
        additionalProperties: false,
      },
    ],
    [
      "properties from a composition",
      {
        type: "object",
        allOf: [{ properties: { markdown: { type: "string" } } }],
        additionalProperties: false,
      },
    ],
  ])("allows any field under %s", (_, schema) => {
    expect(ruledOutText(schema, field("markdown"))).toBeUndefined()
  })

  it("rules out a field only when every branch of a union does", () => {
    expect(
      ruledOutText(
        { anyOf: [{ type: "integer" }, { type: "null" }] },
        field("markdown"),
      ),
    ).toBe("the result is an integer, so it has no markdown")
  })

  it("resolves OpenAPI component references against the whole document", () => {
    const spec = {
      components: {
        schemas: {
          Receipt: {
            type: "object",
            properties: { version: { type: "integer" } },
          },
        },
      },
    }
    expect(
      ruledOutText(
        { $ref: "#/components/schemas/Receipt" },
        field("version"),
        spec,
      ),
    ).toBe("version is an integer")
  })
})
