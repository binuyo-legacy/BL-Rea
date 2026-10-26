import { expect, it } from "vitest";
import {
  ANDROID_MAPPING_LIMITS,
  projectAndroidMapping,
} from "./androidMapping.js";
import {
  parseProguardMapping,
  type ProguardMapping,
  residualDexType,
  resolveProguardClass,
  resolveProguardField,
  resolveProguardMethod,
} from "./proguardMapping.js";

const fixture = [
  "# compiler: R8",
  "# compiler_version: 8.5.35",
  "# min_api: 24",
  '# {"id":"com.android.tools.r8.mapping","version":"2.2"}',
  "# pg_map_id: 1a2b3c4",
  "# pg_map_hash: SHA-256 1a2b3c4d5e6f",
  "    int orphan -> z",
  "com.example.app.LoginActivity -> a.a:",
  '# {"id":"sourceFile","fileName":"LoginActivity.kt"}',
  "    int attempts -> a",
  "    java.lang.String userName -> b",
  "    com.example.app.Session session -> c",
  "    1:4:void <init>():12:15 -> <init>",
  "    1:1:void submit(int):30:30 -> a",
  "    2:2:void submit(java.lang.String):40:40 -> a",
  "    3:3:boolean validate(java.lang.String):50:50 -> b",
  "    4:4:int com.example.app.Util.clamp(int):7:7 -> c",
  "    4:4:void retry():60 -> c",
  "    5:7:void render():90:92 -> d",
  "    8:9:void render():95:96 -> d",
  "    10:10:void log(java.lang.String,int):80:80 -> e",
  '    # {"id":"com.android.tools.r8.residualsignature","signature":"()V"}',
  "    void handle() -> do",
  "    11:x:void broken() -> f",
  "    void missingArrow()",
  "    # {not json — plain comment}",
  "com.example.app.LoginActivity$Callback -> a.a$a:",
  "    void onDone(com.example.app.Session) -> a",
  "com.example.app.Session -> a.b:",
  "    long id -> a",
  "    java.lang.String token -> a",
  "com.example.app.First -> a.f:",
  "com.example.app.Second -> a.f:",
  "com.example.app.Broken -> a.e",
  "    int lost -> a",
].join("\n");

const parse = (text: string): ProguardMapping => {
  const parsed = parseProguardMapping(text, ANDROID_MAPPING_LIMITS);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const mapping = parse(fixture);
const app = "com.example.app";
const method = (
  name: string,
  parameter_types: string[] = [],
  return_type = "void",
) => ({ class: `${app}.LoginActivity`, name, return_type, parameter_types });

it("reports header facts, valid record counts and malformed line samples", () => {
  expect(mapping.reported).toEqual({
    compiler: "R8",
    compiler_version: "8.5.35",
    min_api: "24",
    map_version: "2.2",
    pg_map_id: "1a2b3c4",
    pg_map_hash: "SHA-256 1a2b3c4d5e6f",
  });
  expect(mapping.records).toEqual({
    classes: 5,
    fields: 5,
    methods: 11,
    malformed: 5,
  });
  expect(mapping.malformed).toEqual([
    { line: 7, reason: "member-without-class" },
    { line: 24, reason: "member-line" },
    { line: 25, reason: "member-line" },
    { line: 34, reason: "class-line" },
    { line: 35, reason: "member-without-class" },
  ]);
});

it("maps classes only through exactly one residual record", () => {
  expect(resolveProguardClass(mapping, "a.a")).toEqual({
    status: "mapped",
    mapped: { name: `${app}.LoginActivity` },
    verified_by: "class",
  });
  expect(resolveProguardClass(mapping, "a.a$a")).toMatchObject({
    status: "mapped",
    mapped: { name: `${app}.LoginActivity$Callback` },
  });
  expect(resolveProguardClass(mapping, "a.f")).toEqual({
    status: "ambiguous",
    reason: "multiple-records",
    candidates: [{ name: `${app}.First` }, { name: `${app}.Second` }],
  });
  expect(resolveProguardClass(mapping, "a.z")).toEqual({ status: "unmapped" });
});

it.each([
  ["a.a", "c", "La/b;", { class: `${app}.LoginActivity`, name: "session" }],
  ["a.b", "a", "J", { class: `${app}.Session`, name: "id", type: "long" }],
  ["a.b", "a", "Ljava/lang/String;", { name: "token" }],
])(
  "maps field %s.%s %s by its residual type",
  (className, name, type, mapped) => {
    expect(
      resolveProguardField(mapping, { className, name, type }),
    ).toMatchObject({ status: "mapped", mapped, verified_by: "type" });
  },
);

it("refuses a field whose observed type matches no record", () => {
  expect(
    resolveProguardField(mapping, { className: "a.b", name: "a", type: "I" }),
  ).toMatchObject({ status: "ambiguous", reason: "type-mismatch" });
});

it.each([
  ["a.a", "a", "(I)V", method("submit", ["int"])],
  ["a.a", "a", "(Ljava/lang/String;)V", method("submit", ["java.lang.String"])],
  ["a.a", "c", "()V", method("retry")],
  ["a.a", "d", "()V", method("render")],
  ["a.a", "e", "()V", method("log", ["java.lang.String", "int"])],
  ["a.a", "<init>", "()V", method("<init>")],
  ["a.a", "do", "()V", method("handle")],
  [
    "a.a$a",
    "a",
    "(La/b;)V",
    {
      class: `${app}.LoginActivity$Callback`,
      name: "onDone",
      return_type: "void",
      parameter_types: [`${app}.Session`],
    },
  ],
])(
  "maps method %s.%s%s by its residual prototype",
  (className, name, descriptor, mapped) => {
    expect(
      resolveProguardMethod(mapping, { className, name, descriptor }),
    ).toEqual({ status: "mapped", mapped, verified_by: "descriptor" });
  },
);

it("keeps same-range overloads that are not an inline stack", () => {
  const overloads = parse(
    [
      "com.example.Owner -> a.o:",
      "    1:1:void first():1:1 -> a",
      "    1:1:void second(int):1:1 -> a",
    ].join("\n"),
  );
  const owner = { class: "com.example.Owner", return_type: "void" };
  expect(
    resolveProguardMethod(overloads, {
      className: "a.o",
      name: "a",
      descriptor: "()V",
    }),
  ).toEqual({
    status: "mapped",
    mapped: { ...owner, name: "first", parameter_types: [] },
    verified_by: "descriptor",
  });
  expect(
    resolveProguardMethod(overloads, {
      className: "a.o",
      name: "a",
      descriptor: "(I)V",
    }),
  ).toEqual({
    status: "mapped",
    mapped: { ...owner, name: "second", parameter_types: ["int"] },
    verified_by: "descriptor",
  });
});

it("never maps a lone name-only method candidate", () => {
  expect(
    resolveProguardMethod(mapping, {
      className: "a.a",
      name: "c",
      descriptor: "(I)I",
    }),
  ).toEqual({
    status: "ambiguous",
    reason: "descriptor-mismatch",
    candidates: [method("retry")],
  });
  expect(
    resolveProguardMethod(mapping, {
      className: "a.a",
      name: "b",
      descriptor: "(I)Z",
    }),
  ).toEqual({
    status: "ambiguous",
    reason: "descriptor-mismatch",
    candidates: [method("validate", ["java.lang.String"], "boolean")],
  });
  expect(
    resolveProguardMethod(mapping, {
      className: "a.a",
      name: "g",
      descriptor: "()V",
    }),
  ).toEqual({ status: "unmapped" });
});

it("reports members of a class with several records as ambiguous", () => {
  const ambiguous = parse(
    [
      "com.example.First -> a.f:",
      "    void run() -> a",
      "    int count -> b",
      "com.example.Second -> a.f:",
      "    void run() -> a",
    ].join("\n"),
  );
  expect(
    resolveProguardMethod(ambiguous, {
      className: "a.f",
      name: "a",
      descriptor: "()V",
    }),
  ).toMatchObject({
    status: "ambiguous",
    reason: "ambiguous-class",
    candidates: [
      { class: "com.example.First" },
      { class: "com.example.Second" },
    ],
  });
  expect(
    resolveProguardField(ambiguous, {
      className: "a.f",
      name: "b",
      type: "I",
    }),
  ).toMatchObject({ status: "ambiguous", reason: "ambiguous-class" });
});

it("disambiguates overloads collapsed to one name and caps reported candidates", () => {
  const overloads = parse(
    [
      "com.example.Many -> a.m:",
      ...Array.from(
        { length: 10 },
        (_, index) => `    void run${index}(int${"[]".repeat(index)}) -> a`,
      ),
    ].join("\n"),
  );
  expect(
    resolveProguardMethod(overloads, {
      className: "a.m",
      name: "a",
      descriptor: "([[[I)V",
    }),
  ).toMatchObject({ status: "mapped", mapped: { name: "run3" } });
  const report = projectAndroidMapping(
    {
      file: { path: "/tmp/mapping.txt", sha256: "a".repeat(64), bytes: 1 },
      mapping: overloads,
    },
    [
      { kind: "class", name: "a.m", raw_name: "a.m" },
      {
        kind: "method",
        class_raw_name: "a.m",
        name: "a",
        overload_index: 0,
        raw_name: "a",
        dex_descriptor: "(J)V",
      },
      { kind: "class", name: "a.n", raw_name: "a.n" },
    ],
  );
  expect(report.symbols[1]?.resolution).toMatchObject({
    status: "ambiguous",
    reason: "descriptor-mismatch",
    candidate_count: 10,
  });
  const resolution = report.symbols[1]?.resolution;
  expect(
    resolution?.status === "ambiguous" ? resolution.candidates : [],
  ).toHaveLength(ANDROID_MAPPING_LIMITS.candidates);
  expect(report.coverage).toEqual({
    symbols: 3,
    mapped: 1,
    ambiguous: 1,
    unmapped: 1,
  });
});

it("translates original types to residual DEX types", () => {
  const renamed = parse(
    [
      "com.example.Outer$Inner -> a.b$c:",
      "com.example.Twice -> a.t:",
      "com.example.Twice -> a.u:",
    ].join("\n"),
  );
  expect(residualDexType(renamed, "int[][]")).toBe("[[I");
  expect(residualDexType(renamed, "com.example.Outer$Inner[]")).toBe(
    "[La/b$c;",
  );
  expect(residualDexType(renamed, "java.util.List")).toBe("Ljava/util/List;");
  expect(residualDexType(renamed, "com.example.Twice")).toBeUndefined();
});

it("uses residual signature metadata and reports an invalid payload", () => {
  const metadata = parse(
    [
      "com.example.Meta -> a.m:",
      "    int count -> a",
      '    # {"id":"com.android.tools.r8.residualsignature","signature":"J"}',
      "    void run() -> b",
      '    # {"id":"com.android.tools.r8.residualsignature","signature":"V"}',
    ].join("\n"),
  );
  expect(
    resolveProguardField(metadata, { className: "a.m", name: "a", type: "J" }),
  ).toMatchObject({ status: "mapped", mapped: { name: "count" } });
  expect(metadata.malformed).toEqual([{ line: 5, reason: "metadata" }]);
});

it("treats CRLF and tab indentation like LF and spaces", () => {
  expect(
    parse(fixture.replaceAll("\n", "\r\n").replaceAll("    ", "\t")),
  ).toEqual(mapping);
});

it.each([
  ["empty", ""],
  ["comment-only", "# compiler: R8\n# just a comment\n"],
  ["usage.txt", "com.example.Unused\n    void unused()\n    int field\n"],
  ["seeds.txt", "com.example.Keep: void keep()\n"],
])("fails closed on a %s file without class records", (_name, text) => {
  expect(parseProguardMapping(text, ANDROID_MAPPING_LIMITS)).toEqual({
    ok: false,
    error: "no-class-records",
  });
});
