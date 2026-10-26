import { err, ok, type Result } from "../result.js";
import { dexDescriptorSchema, dexTypeSchema } from "./dexTypes.js";

/** Why one mapping line could not be used; raw line text is never retained. */
export type ProguardMalformedReason =
  | "class-line"
  | "member-line"
  | "member-without-class"
  | "metadata";

/** A mapping-derived class name; never an observed DEX identity. */
export interface MappedClass {
  readonly name: string;
}
/** A mapping-derived field: its mapped class, name and original Java type. */
export interface MappedField {
  readonly class: string;
  readonly name: string;
  readonly type: string;
}
/** A mapping-derived method: its mapped class, name and original Java types. */
export interface MappedMethod {
  readonly class: string;
  readonly name: string;
  readonly return_type: string;
  readonly parameter_types: readonly string[];
}

/** A residual record and its optional R8 residual signature metadata. */
interface MemberRecord<Mapped> {
  readonly mapped: Mapped;
  residual: string | undefined;
}
interface ClassRecord {
  readonly name: string;
  readonly fields: Map<string, MemberRecord<MappedField>[]>;
  /** Outermost frames only, deduplicated across line-range splits. */
  readonly methods: Map<string, MemberRecord<MappedMethod>[]>;
  /** `methods` entries keyed by obfuscated name and original identity. */
  readonly methodIndex: Map<string, MemberRecord<MappedMethod>[]>;
}

/** Facts parsed from one R8/ProGuard mapping file. */
export interface ProguardMapping {
  readonly reported: {
    readonly compiler: string | null;
    readonly compiler_version: string | null;
    readonly min_api: string | null;
    readonly map_version: string | null;
    readonly pg_map_id: string | null;
    readonly pg_map_hash: string | null;
  };
  /** Class records keyed by residual (obfuscated) binary name. */
  readonly classes: ReadonlyMap<string, readonly ClassRecord[]>;
  /** Residual binary names recorded for each original class. */
  readonly residualNames: ReadonlyMap<string, readonly string[]>;
  readonly records: {
    readonly classes: number;
    readonly fields: number;
    readonly methods: number;
    readonly malformed: number;
  };
  readonly malformed: readonly {
    readonly line: number;
    readonly reason: ProguardMalformedReason;
  }[];
}

/** Outcome of looking one observed raw DEX symbol up in a mapping. */
export type ProguardResolution<Mapped, Verifier extends string> =
  | {
      readonly status: "mapped";
      readonly mapped: Mapped;
      readonly verified_by: Verifier;
    }
  | {
      readonly status: "ambiguous";
      readonly reason:
        | "multiple-records"
        | "descriptor-mismatch"
        | "type-mismatch"
        | "ambiguous-class";
      readonly candidates: readonly Mapped[];
    }
  | { readonly status: "unmapped" };

const HEADER =
  /^#\s*(compiler|compiler_version|min_api|pg_map_id|pg_map_hash):\s*(.*)$/u;
const CLASS_LINE = /^([^\s:()]+) -> ([^\s:()]+):$/u;
const FIELD_LINE = /^\s+([^\s:()]+) ([^\s:()]+) -> ([^\s:()]+)$/u;
const METHOD_LINE =
  /^\s+(?:(\d+):(?:(\d+):)?)?([^\s:()]+) ([^\s:()]+)\(([^()]*)\)(?::(\d+)(?::(\d+))?)? -> ([^\s:()]+)$/u;
const TYPE_TOKEN = /^[^\s(),;<>:[\]]+(?:\[\])*$/u;
const DEX_PRIMITIVES = new Map([
  ["boolean", "Z"],
  ["byte", "B"],
  ["char", "C"],
  ["short", "S"],
  ["int", "I"],
  ["long", "J"],
  ["float", "F"],
  ["double", "D"],
  ["void", "V"],
]);

/** The type without its trailing `[]` dimensions. */
const arrayElement = (type: string): string => {
  let end = type.length;
  while (type.endsWith("[]", end)) end -= 2;
  return type.slice(0, end);
};

/** `void` is valid only as a return type and never as an array element. */
const validType = (type: string, isReturn: boolean): boolean => {
  const element = arrayElement(type);
  return (
    TYPE_TOKEN.test(type) &&
    (element !== "void" || (isReturn && element === type))
  );
};

/** Split `com.x.Y.name` into its mapped class and member name. */
const memberOwner = (
  qualified: string,
  section: string,
): { readonly class: string; readonly name: string } => {
  const dot = qualified.lastIndexOf(".");
  return dot <= 0
    ? { class: section, name: qualified }
    : { class: qualified.slice(0, dot), name: qualified.slice(dot + 1) };
};

interface MethodGroup {
  readonly record: ClassRecord;
  readonly obfuscated: string;
  readonly range: string | null;
  outermost: MappedMethod;
  residual: string | undefined;
}

interface ParseState {
  readonly sampleLimit: number;
  readonly reported: {
    -readonly [Key in keyof ProguardMapping["reported"]]: string | null;
  };
  readonly classes: Map<string, ClassRecord[]>;
  readonly residualNames: Map<string, string[]>;
  readonly records: {
    classes: number;
    fields: number;
    methods: number;
    malformed: number;
  };
  readonly malformed: { line: number; reason: ProguardMalformedReason }[];
  /** undefined before any class; null after a malformed class line. */
  current: ClassRecord | null | undefined;
  group: MethodGroup | undefined;
  /** The member a following residual-signature comment describes. */
  last: MemberRecord<MappedField> | MethodGroup | undefined;
}

const malformed = (
  state: ParseState,
  line: number,
  reason: ProguardMalformedReason,
): void => {
  state.records.malformed++;
  if (state.malformed.length < state.sampleLimit)
    state.malformed.push({ line, reason });
};

const append = <Value>(
  map: Map<string, Value[]>,
  key: string,
  value: Value,
): void => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
};

// Validated names and types hold no whitespace, so spaces separate safely.
const methodKey = (obfuscated: string, method: MappedMethod): string =>
  `${obfuscated} ${method.class} ${method.name} ${method.return_type} ${method.parameter_types.join(",")}`;

/** Commit a frame stack's outermost original, merging line-range splits. */
const closeGroup = (state: ParseState): void => {
  const group = state.group;
  state.group = undefined;
  if (group === undefined) return;
  const key = methodKey(group.obfuscated, group.outermost);
  const same = group.record.methodIndex
    .get(key)
    ?.find(
      (candidate) =>
        candidate.residual === undefined ||
        group.residual === undefined ||
        candidate.residual === group.residual,
    );
  if (same !== undefined) {
    same.residual ??= group.residual;
    return;
  }
  const record = { mapped: group.outermost, residual: group.residual };
  append(group.record.methods, group.obfuscated, record);
  append(group.record.methodIndex, key, record);
};

const parseClassLine = (state: ParseState, line: string, number: number) => {
  closeGroup(state);
  state.last = undefined;
  const match = CLASS_LINE.exec(line);
  if (match === null) {
    state.current = null;
    malformed(state, number, "class-line");
    return;
  }
  const [, original = "", residual = ""] = match;
  const record: ClassRecord = {
    name: original,
    fields: new Map(),
    methods: new Map(),
    methodIndex: new Map(),
  };
  state.current = record;
  state.records.classes++;
  append(state.classes, residual, record);
  append(state.residualNames, original, residual);
};

const parseField = (state: ParseState, record: ClassRecord, line: string) => {
  const match = FIELD_LINE.exec(line);
  if (match === null) return false;
  const [, type = "", name = "", obfuscated = ""] = match;
  if (!validType(type, false)) return false;
  closeGroup(state);
  const field: MemberRecord<MappedField> = {
    mapped: { ...memberOwner(name, record.name), type },
    residual: undefined,
  };
  append(record.fields, obfuscated, field);
  state.records.fields++;
  state.last = field;
  return true;
};

const methodRange = (start?: string, end?: string): string | null | false => {
  if (start === undefined) return null;
  const last = end ?? start;
  return Number(start) > Number(last) ? false : `${start}:${last}`;
};

const parseMethod = (state: ParseState, record: ClassRecord, line: string) => {
  const match = METHOD_LINE.exec(line);
  if (match === null) return false;
  const [
    ,
    start,
    end,
    returnType = "",
    name = "",
    args = "",
    originalStart,
    originalEnd,
    obfuscated = "",
  ] = match;
  const parameters = args === "" ? [] : args.split(",");
  const range = methodRange(start, end);
  if (
    range === false ||
    !validType(returnType, true) ||
    !parameters.every((type) => validType(type, false))
  )
    return false;
  const mapped: MappedMethod = {
    ...memberOwner(name, record.name),
    return_type: returnType,
    parameter_types: parameters,
  };
  state.records.methods++;
  const group = state.group;
  // A caller frame records its single call-site line (`:7`); a line with an
  // original range is a separate method that happens to share the range.
  if (
    group !== undefined &&
    range !== null &&
    group.obfuscated === obfuscated &&
    group.range === range &&
    originalStart !== undefined &&
    originalEnd === undefined
  ) {
    group.outermost = mapped;
    return true;
  }
  closeGroup(state);
  state.group = {
    record,
    obfuscated,
    range,
    outermost: mapped,
    residual: undefined,
  };
  state.last = state.group;
  return true;
};

const parseMember = (state: ParseState, line: string, number: number) => {
  const record = state.current;
  if (record === undefined || record === null) {
    closeGroup(state);
    state.last = undefined;
    malformed(state, number, "member-without-class");
    return;
  }
  if (parseField(state, record, line) || parseMethod(state, record, line))
    return;
  closeGroup(state);
  state.last = undefined;
  malformed(state, number, "member-line");
};

const metadataObject = (body: string): Record<string, unknown> | undefined => {
  if (!body.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "id" in value &&
    typeof value.id === "string"
    ? (value as Record<string, unknown>)
    : undefined;
};

/** Attach R8 metadata the v1 resolver uses; other ids are ignored. */
const parseMetadata = (
  state: ParseState,
  metadata: Record<string, unknown>,
  number: number,
) => {
  if (metadata.id === "com.android.tools.r8.mapping") {
    if (state.current !== undefined) return;
    if (typeof metadata.version === "string")
      state.reported.map_version = metadata.version;
    else malformed(state, number, "metadata");
    return;
  }
  if (metadata.id !== "com.android.tools.r8.residualsignature") return;
  const target = state.last;
  if (target === undefined) return;
  const schema = "outermost" in target ? dexDescriptorSchema : dexTypeSchema;
  const signature = schema.safeParse(metadata.signature);
  if (signature.success) target.residual = signature.data;
  else malformed(state, number, "metadata");
};

const parseComment = (state: ParseState, line: string, number: number) => {
  const body = line.trimStart().slice(1).trim();
  const metadata = metadataObject(body);
  if (metadata !== undefined) {
    parseMetadata(state, metadata, number);
    return;
  }
  const header = state.current === undefined ? HEADER.exec(line) : null;
  if (header === null) return;
  const [, key = "", value = ""] = header;
  state.reported[key as keyof ParseState["reported"]] =
    value === "" ? null : value;
};

const parseLine = (state: ParseState, raw: string, number: number) => {
  const line = raw.trimEnd();
  if (line === "") return;
  if (/^\s*#/u.test(line)) parseComment(state, line, number);
  else if (/^\s/u.test(line)) parseMember(state, line, number);
  else parseClassLine(state, line, number);
};

/**
 * Parse an R8/ProGuard mapping. Malformed records are counted and sampled
 * while parsing continues; a file without any class record fails closed.
 */
export const parseProguardMapping = (
  text: string,
  limits: { readonly malformedSamples: number },
): Result<ProguardMapping, "no-class-records"> => {
  const state: ParseState = {
    sampleLimit: limits.malformedSamples,
    reported: {
      compiler: null,
      compiler_version: null,
      min_api: null,
      map_version: null,
      pg_map_id: null,
      pg_map_hash: null,
    },
    classes: new Map(),
    residualNames: new Map(),
    records: { classes: 0, fields: 0, methods: 0, malformed: 0 },
    malformed: [],
    current: undefined,
    group: undefined,
    last: undefined,
  };
  text.split("\n").forEach((line, index) => parseLine(state, line, index + 1));
  closeGroup(state);
  if (state.records.classes === 0) return err("no-class-records");
  return ok({
    reported: state.reported,
    classes: state.classes,
    residualNames: state.residualNames,
    records: state.records,
    malformed: state.malformed,
  });
};

/** Translate one original Java type to its residual DEX type, if verifiable. */
export const residualDexType = (
  mapping: ProguardMapping,
  type: string,
): string | undefined => {
  const element = arrayElement(type);
  const dimensions = "[".repeat((type.length - element.length) / 2);
  const primitive = DEX_PRIMITIVES.get(element);
  if (primitive !== undefined) return dimensions + primitive;
  const residual = new Set(mapping.residualNames.get(element) ?? [element]);
  if (residual.size !== 1) return undefined;
  return `${dimensions}L${[...residual][0]?.replaceAll(".", "/")};`;
};

const residualDescriptor = (
  mapping: ProguardMapping,
  record: MemberRecord<MappedMethod>,
): string | undefined => {
  if (record.residual !== undefined) return record.residual;
  const parameters = record.mapped.parameter_types.map((type) =>
    residualDexType(mapping, type),
  );
  const returned = residualDexType(mapping, record.mapped.return_type);
  if (returned === undefined || parameters.includes(undefined))
    return undefined;
  return `(${parameters.join("")})${returned}`;
};

/** Resolve an observed raw class name; several records are ambiguous. */
export const resolveProguardClass = (
  mapping: ProguardMapping,
  rawName: string,
): ProguardResolution<MappedClass, "class"> => {
  const records = mapping.classes.get(rawName) ?? [];
  const [only] = records;
  if (only === undefined) return { status: "unmapped" };
  if (records.length === 1)
    return {
      status: "mapped",
      mapped: { name: only.name },
      verified_by: "class",
    };
  return {
    status: "ambiguous",
    reason: "multiple-records",
    candidates: records.map(({ name }) => ({ name })),
  };
};

/** One observed member and the residual identity its candidates must match. */
interface MemberQuery<Mapped> {
  readonly records: readonly ClassRecord[];
  readonly candidates: (record: ClassRecord) => readonly MemberRecord<Mapped>[];
  readonly matches: (record: MemberRecord<Mapped>) => boolean;
  readonly mismatch: "descriptor-mismatch" | "type-mismatch";
}

/** Shared fail-closed member rule: only one identity-verified candidate maps. */
const resolveMember = <Mapped, Verifier extends string>(
  query: MemberQuery<Mapped>,
  verifier: Verifier,
): ProguardResolution<Mapped, Verifier> => {
  const candidates = query.records.flatMap(query.candidates);
  if (candidates.length === 0) return { status: "unmapped" };
  const mapped = (records: readonly MemberRecord<Mapped>[]) =>
    records.map((record) => record.mapped);
  if (query.records.length > 1)
    return {
      status: "ambiguous",
      reason: "ambiguous-class",
      candidates: mapped(candidates),
    };
  const verified = candidates.filter(query.matches);
  const [only] = verified;
  if (only !== undefined && verified.length === 1)
    return { status: "mapped", mapped: only.mapped, verified_by: verifier };
  return verified.length > 1
    ? {
        status: "ambiguous",
        reason: "multiple-records",
        candidates: mapped(verified),
      }
    : {
        status: "ambiguous",
        reason: query.mismatch,
        candidates: mapped(candidates),
      };
};

/** Resolve an observed raw method by its DEX prototype; names alone never map. */
export const resolveProguardMethod = (
  mapping: ProguardMapping,
  observed: {
    readonly className: string;
    readonly name: string;
    readonly descriptor: string;
  },
): ProguardResolution<MappedMethod, "descriptor"> =>
  resolveMember(
    {
      records: mapping.classes.get(observed.className) ?? [],
      candidates: (record) => record.methods.get(observed.name) ?? [],
      matches: (record) =>
        residualDescriptor(mapping, record) === observed.descriptor,
      mismatch: "descriptor-mismatch",
    },
    "descriptor",
  );

/** Resolve an observed raw field by its DEX type; names alone never map. */
export const resolveProguardField = (
  mapping: ProguardMapping,
  observed: {
    readonly className: string;
    readonly name: string;
    readonly type: string;
  },
): ProguardResolution<MappedField, "type"> =>
  resolveMember(
    {
      records: mapping.classes.get(observed.className) ?? [],
      candidates: (record) => record.fields.get(observed.name) ?? [],
      matches: (record) =>
        (record.residual ?? residualDexType(mapping, record.mapped.type)) ===
        observed.type,
      mismatch: "type-mismatch",
    },
    "type",
  );
