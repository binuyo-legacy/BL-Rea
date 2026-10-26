import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { parseReferenceSourceEntries } from "./ReferenceSourceImportEntries.js";
import { historicalSourceLanguages } from "../domain/referenceSourceGraph.js";
import type { ReferenceSourceRead } from "../reference/ReferenceSourceReaderTypes.js";

it("projects an unsupported non-regular entry as unknown kind instead of file", () => {
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [
      {
        status: "failed",
        kind: "other",
        path: "src/pipe",
        code: "unsupported",
        message: "Entry is not a regular file",
        size: 0,
      },
    ],
    bytesRead: 0,
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(read, new Set(), []);
  expect(parsed.entries).toContainEqual({
    path: "src/pipe",
    kind: "unknown",
    classifications: ["unknown"],
    limitations: [
      "Entry is not a regular file Exclude this entry or replace it with a regular file.",
    ],
  });
  expect(parsed.entries.some((entry) => entry.kind === "file")).toBe(false);
});

it("keeps a failed regular file as file kind", () => {
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [
      {
        status: "failed",
        kind: "file",
        path: "src/broken.ts",
        code: "io",
        message: "Entry could not be read",
      },
    ],
    bytesRead: 0,
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(read, new Set(), []);
  expect(parsed.entries).toContainEqual({
    path: "src/broken.ts",
    kind: "file",
    sha256: null,
    size: null,
    language: null,
    classifications: ["source"],
    content_state: "unreadable",
    limitations: [
      "Entry could not be read This file could not be read. Check its permissions, then try again.",
    ],
  });
});

it("keeps source entries when a module has an empty specifier", () => {
  const files = [
    ["main.mjs", 'import "";\n'],
    ["other.txt", "retained\n"],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };

  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
    [],
  );

  expect(parsed.entries.map(({ path }) => path)).toEqual([
    "main.mjs",
    "other.txt",
  ]);
  expect(parsed.relationships).toEqual([]);
  expect(parsed.limitations).toEqual([
    "Empty module specifier in main.mjs was not recorded as a relationship.",
  ]);
});

it("retains Kotlin source identity and language across the inventory projection", () => {
  const files = [
    [
      "MainActivity.kt",
      "import android.app.Activity\nclass MainActivity : Activity()\n",
      ["source"],
      "Kotlin",
    ],
    ["task.kts", 'println("hello")\n', ["source"], "Kotlin"],
    [
      "build.gradle.kts",
      'plugins { kotlin("jvm") version "2.3.0" }\n',
      ["manifest", "source"],
      "Kotlin",
    ],
    ["MainActivity.kt.backup", "backup\n", ["unknown"], null],
    ["Legacy.java", "class Legacy {}\n", ["source"], "Java"],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
    [],
  );
  for (const [path, content, classifications, language] of files)
    expect(parsed.entries).toContainEqual({
      path,
      kind: "file",
      language,
      classifications,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      content_state: "hashed",
      limitations: [],
    });
  expect(historicalSourceLanguages(parsed.entries)).toEqual(["Java", "Kotlin"]);
  expect(parsed.parseFailures).toEqual([]);
  expect(parsed.relationships).toEqual([]);
});

it("resolves declared package mains and index fallback from source-owned fields", () => {
  const files = [
    [
      "main.cjs",
      'require("./pkg");\nrequire("./dep");\nrequire("./fallback");\n',
    ],
    [
      "main.cts",
      'import dep = require("./typed");\n' +
        'require("./typed");\n' +
        'import data = require("./json-package");\n' +
        'require("./emitted.js");\n',
    ],
    ["pkg/package.json", '{"main":"actual.js"}\n'],
    ["pkg/actual.js", 'module.exports = "package main";\n'],
    ["fallback/package.json", "{}\n"],
    ["fallback/index.js", 'module.exports = "index";\n'],
    ["fallback/phantom.js", 'module.exports = "host decoy";\n'],
    ["dep.js", 'module.exports = "file";\n'],
    ["dep/index.ts", 'export const value = "index";\n'],
    ["typed.js", 'module.exports = "runtime file";\n'],
    ["typed/index.ts", 'export const value = "source index";\n'],
    ["json-package/package.json", '{"main":"data"}\n'],
    ["json-package/data.json", '{"value":"package main"}\n'],
    ["json-package/index.js", 'module.exports = "fallback index";\n'],
    ["emitted.ts", 'export const value = "source counterpart";\n'],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };

  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "main");
  let parsed: ReturnType<typeof parseReferenceSourceEntries>;
  try {
    Object.defineProperty(Object.prototype, "main", {
      configurable: true,
      writable: true,
      value: "phantom.js",
    });
    parsed = parseReferenceSourceEntries(
      read,
      new Set(files.map(([path]) => path)),
      [],
    );
  } finally {
    if (previous === undefined)
      Reflect.deleteProperty(Object.prototype, "main");
    else Object.defineProperty(Object.prototype, "main", previous);
  }

  expect(parsed.relationships).toContainEqual({
    from_path: "main.cjs",
    to: "fallback/index.js",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(parsed.relationships).toContainEqual({
    from_path: "main.cjs",
    to: "pkg/actual.js",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(parsed.relationships).toContainEqual({
    from_path: "main.cjs",
    to: "dep.js",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(parsed.relationships).toContainEqual({
    from_path: "main.cts",
    to: "typed/index.ts",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(parsed.relationships).toContainEqual({
    from_path: "main.cts",
    to: "typed.js",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(parsed.relationships).toContainEqual({
    from_path: "main.cts",
    to: "json-package/data.json",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(parsed.relationships).toContainEqual({
    from_path: "main.cts",
    to: "emitted.ts",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
});

it("matches package manifests by exact or unique canonical directory identity", () => {
  const composed = "caf\u00e9";
  const decomposed = "cafe\u0301";
  const composedTwin = "r\u00e9sum\u00e9";
  const decomposedTwin = "re\u0301sume\u0301";
  const files = [
    [
      "main.cjs",
      [composed, composedTwin, decomposedTwin]
        .map((name) => `require(${JSON.stringify(`./${name}`)});`)
        .join("\n"),
    ],
    [`${decomposed}/package.json`, '{"main":"unique.js"}\n'],
    [`${decomposed}/unique.js`, 'module.exports = "unique";\n'],
    [`${composed}/unique.js`, 'module.exports = "unrelated exact spelling";\n'],
    [`${composedTwin}/package.json`, '{"main":"exact-composed.js"}\n'],
    [`${composedTwin}/exact-composed.js`, 'module.exports = "composed";\n'],
    [`${decomposedTwin}/package.json`, '{"main":"exact-decomposed.js"}\n'],
    [
      `${decomposedTwin}/exact-decomposed.js`,
      'module.exports = "decomposed";\n',
    ],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };

  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
    [],
  );

  expect(parsed.relationships.map(({ to }) => to)).toEqual([
    `${decomposed}/unique.js`,
    `${composedTwin}/exact-composed.js`,
    `${decomposedTwin}/exact-decomposed.js`,
  ]);
});

it("resolves extensionless imports and requires to .mts and .cts files and directory indexes", () => {
  const files = [
    [
      "src/index.ts",
      'import "./esm";\nimport "./pkg-esm";\nimport cjs = require("./cjs");\nimport pkgCjs = require("./pkg-cjs");\n',
    ],
    ["src/esm.mts", "export const esm = 1;\n"],
    ["src/pkg-esm/index.mts", "export const pkgEsm = 2;\n"],
    ["src/cjs.cts", "module.exports = { cjs: 3 };\n"],
    ["src/pkg-cjs/index.cts", "module.exports = { pkgCjs: 4 };\n"],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
    [],
  );
  expect(parsed.relationships).toEqual(
    expect.arrayContaining([
      {
        from_path: "src/index.ts",
        to: "src/esm.mts",
        kind: "imports",
        resolution: "internal",
        parse_state: "parsed",
      },
      {
        from_path: "src/index.ts",
        to: "src/pkg-esm/index.mts",
        kind: "imports",
        resolution: "internal",
        parse_state: "parsed",
      },
      {
        from_path: "src/index.ts",
        to: "src/cjs.cts",
        kind: "requires",
        resolution: "internal",
        parse_state: "parsed",
      },
      {
        from_path: "src/index.ts",
        to: "src/pkg-cjs/index.cts",
        kind: "requires",
        resolution: "internal",
        parse_state: "parsed",
      },
    ]),
  );
});

const readSource = (
  files: readonly (readonly [string, string])[],
): ReferenceSourceRead => ({
  root: "/selected/source",
  entries: files.map(([path, content]) => ({
    status: "read",
    kind: "file",
    path,
    bytes: Buffer.from(content),
    size: Buffer.byteLength(content),
  })),
  bytesRead: files.reduce(
    (sum, [, content]) => sum + Buffer.byteLength(content),
    0,
  ),
  limitations: [],
});

const relationshipsOf = (files: readonly (readonly [string, string])[]) =>
  parseReferenceSourceEntries(
    readSource(files),
    new Set(files.map(([path]) => path)),
    [],
  ).relationships;

it("resolves query and fragment ESM requests to the inventoried pathname (#3916)", () => {
  const relationships = relationshipsOf([
    [
      "main.mjs",
      'import "./dep.mjs?revision=1#first";\n' +
        'import "./query.mjs?v=2";\n' +
        'import "./fragment.mjs#part";\n' +
        'await import("./dynamic.mjs?lazy");\n',
    ],
    ["dep.mjs", "export const value = 1;\n"],
    ["query.mjs", "export const value = 2;\n"],
    ["fragment.mjs", "export const value = 3;\n"],
    ["dynamic.mjs", "export const value = 4;\n"],
  ]);
  for (const to of ["dep.mjs", "query.mjs", "fragment.mjs", "dynamic.mjs"])
    expect(relationships).toContainEqual(
      expect.objectContaining({
        from_path: "main.mjs",
        to,
        resolution: "internal",
      }),
    );
});

it("resolves an ESM query to the pathname even when a literal-suffix filename is inventoried", () => {
  const relationships = relationshipsOf([
    ["main.mjs", 'import "./dep.mjs?v=1";\n'],
    ["dep.mjs", "export const value = 1;\n"],
    ["dep.mjs?v=1", "export const value = 2;\n"],
  ]);
  expect(relationships).toContainEqual(
    expect.objectContaining({
      from_path: "main.mjs",
      to: "dep.mjs",
      resolution: "internal",
    }),
  );
  expect(relationships).not.toContainEqual(
    expect.objectContaining({ to: "dep.mjs?v=1" }),
  );
});

it("decodes percent-encoded ESM pathnames to literal filenames", () => {
  const relationships = relationshipsOf([
    [
      "main.mjs",
      'import "./dep.mjs%3Fv=1";\n' +
        'import "./name%3Fq.mjs?v=2";\n' +
        'import "./a%20b.mjs";\n',
    ],
    ["dep.mjs", "export const value = 1;\n"],
    ["dep.mjs?v=1", "export const value = 2;\n"],
    ["name?q.mjs", "export const value = 3;\n"],
    ["a b.mjs", "export const value = 4;\n"],
  ]);
  for (const to of ["dep.mjs?v=1", "name?q.mjs", "a b.mjs"])
    expect(relationships).toContainEqual(
      expect.objectContaining({
        from_path: "main.mjs",
        to,
        resolution: "internal",
      }),
    );
  expect(relationships).not.toContainEqual(
    expect.objectContaining({ to: "dep.mjs" }),
  );
});

it("leaves ESM pathnames Node rejects unresolved with their source spelling", () => {
  const relationships = relationshipsOf([
    ["main.mjs", 'import "./sub%2Fx.mjs";\nimport "./100%.mjs";\n'],
    ["sub/x.mjs", "export const value = 1;\n"],
    ["100%.mjs", "export const value = 2;\n"],
  ]);
  for (const to of ["sub%2Fx.mjs", "100%.mjs"])
    expect(relationships).toContainEqual(
      expect.objectContaining({
        from_path: "main.mjs",
        to,
        resolution: "unresolved",
      }),
    );
});

it("leaves ./a%5Cb.mjs unresolved, stricter than Node's backslash decode", () => {
  // Node 24 on Linux decodes `%5C` to a file literally named `a\b.mjs` and
  // rejects only `%2F`. This inventory rejects the encoded separator instead.
  const relationships = relationshipsOf([
    ["main.mjs", 'import "./a%5Cb.mjs";\n'],
    ["a\\b.mjs", "export const value = 1;\n"],
  ]);
  expect(relationships).toContainEqual(
    expect.objectContaining({
      from_path: "main.mjs",
      to: "a%5Cb.mjs",
      resolution: "unresolved",
    }),
  );
  expect(relationships).not.toContainEqual(
    expect.objectContaining({ to: "a\\b.mjs", resolution: "internal" }),
  );
});

it("keeps an unmatched query-bearing ESM request unresolved", () => {
  expect(
    relationshipsOf([["main.mjs", 'import "./missing.mjs?v=1";\n']]),
  ).toContainEqual(
    expect.objectContaining({
      from_path: "main.mjs",
      to: "missing.mjs?v=1",
      resolution: "unresolved",
    }),
  );
});

it("keeps dot segments inside an unmatched ESM query", () => {
  expect(
    relationshipsOf([["main.mjs", 'import "./missing.mjs?v=1/..";\n']]),
  ).toContainEqual(
    expect.objectContaining({
      from_path: "main.mjs",
      to: "missing.mjs?v=1/..",
      resolution: "unresolved",
    }),
  );
});

it("keeps dot segments inside an unmatched ESM fragment", () => {
  expect(
    relationshipsOf([["main.mjs", 'import "./missing.mjs#a/../b";\n']]),
  ).toContainEqual(
    expect.objectContaining({
      from_path: "main.mjs",
      to: "missing.mjs#a/../b",
      resolution: "unresolved",
    }),
  );
});

it("keeps an unmatched ESM query when the importer is in a subdirectory", () => {
  const relationships = relationshipsOf([
    ["pkg/main.mjs", 'import "./missing.mjs?v=1/..";\n'],
    ["main.mjs", 'import "./pkg/missing.mjs?v=1/..";\n'],
  ]);
  expect(relationships).toContainEqual(
    expect.objectContaining({
      from_path: "pkg/main.mjs",
      to: "pkg/missing.mjs?v=1/..",
      resolution: "unresolved",
    }),
  );
  expect(relationships).toContainEqual(
    expect.objectContaining({
      from_path: "main.mjs",
      to: "pkg/missing.mjs?v=1/..",
      resolution: "unresolved",
    }),
  );
});

it("does not strip a query from a CommonJS require specifier", () => {
  expect(
    relationshipsOf([
      ["main.cjs", 'require("./dep.js?v=1");\n'],
      ["dep.js", "module.exports = 1;\n"],
    ]),
  ).toContainEqual(
    expect.objectContaining({
      from_path: "main.cjs",
      resolution: "unresolved",
    }),
  );
});

it("keeps CommonJS require specifiers literal", () => {
  expect(
    relationshipsOf([
      ["main.cjs", 'require("./dep.js?v=1");\nrequire("./a%20b.js");\n'],
      ["dep.js", "module.exports = 1;\n"],
      ["dep.js?v=1", "module.exports = 2;\n"],
      ["a b.js", "module.exports = 3;\n"],
    ]),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        from_path: "main.cjs",
        to: "dep.js?v=1",
        resolution: "internal",
      }),
      expect.objectContaining({
        from_path: "main.cjs",
        to: "a%20b.js",
        resolution: "unresolved",
      }),
    ]),
  );
});
