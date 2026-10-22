const MAX_BYTES = 262144;
const MAX_NODES = 20000;
const MAX_DEPTH = 24;
export const ORCA_SESSION_JSON_MAX_BYTES = 4 * 1024 * 1024;

export type OrcaJsonResult = { ok: true; value: unknown } | { ok: false; code: "INVALID_JSON" };

/** Decode bounded CLI JSON without accepting duplicate (including escaped) keys. */
export function decodeOrcaJson(input: unknown): OrcaJsonResult {
  return decodeBoundedJson(input, MAX_BYTES);
}

/** Separate fixed budget for original journal records; CLI limits never change. */
export function decodeOrcaSessionRecordJson(input: unknown): OrcaJsonResult {
  return decodeBoundedJson(input, ORCA_SESSION_JSON_MAX_BYTES);
}

function decodeBoundedJson(input: unknown, maxBytes: number): OrcaJsonResult {
  if (typeof input !== "string" || input.length > maxBytes || Buffer.byteLength(input, "utf8") > maxBytes) {
    return { ok: false, code: "INVALID_JSON" };
  }
  const source = input;
  let offset = 0;
  let nodes = 0;
  const primitiveToken = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
  function whitespace() {
    while (offset < source.length && /[\x20\t\r\n]/.test(source.charAt(offset))) offset++;
  }
  function string(): string {
    const start = offset;
    if (source.charAt(offset++) !== '"') throw Error();
    // Iterative scanning avoids regular-expression stack growth on large strings.
    while (offset < source.length) {
      const ch = source.charAt(offset++);
      if (ch === '"') return JSON.parse(source.slice(start, offset)) as string;
      if (ch.charCodeAt(0) < 32) throw Error();
      if (ch !== "\\") continue;
      const escape = source.charAt(offset++);
      if (escape === "u") {
        if (!/^[a-fA-F0-9]{4}$/.test(source.slice(offset, offset + 4))) throw Error();
        offset += 4;
      } else if (!escape || !'"\\/bfnrt'.includes(escape)) throw Error();
    }
    throw Error();
  }
  // This grammar walk only detects ambiguity and enforces budgets; JSON.parse builds the value.
  function value(depth: number): void {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw Error();
    whitespace();
    const first = source.charAt(offset);
    if (first === '"') { string(); return; }
    if (first === "{" || first === "[") {
      const object = first === "{";
      const end = object ? "}" : "]";
      const keys = new Set<string>();
      offset++; whitespace();
      if (source.charAt(offset) === end) { offset++; return; }
      while (true) {
        if (object) {
          whitespace();
          const key = string();
          if (keys.has(key)) throw Error();
          keys.add(key); whitespace();
          if (source.charAt(offset++) !== ":") throw Error();
        }
        value(depth + 1); whitespace();
        if (source.charAt(offset) === end) { offset++; return; }
        if (source.charAt(offset++) !== ",") throw Error();
      }
    }
    primitiveToken.lastIndex = offset;
    const match = primitiveToken.exec(source);
    if (!match || (match[0] !== "null" && match[0] !== "true" && match[0] !== "false" && !Number.isFinite(Number(match[0])))) throw Error();
    offset = primitiveToken.lastIndex;
  }
  try {
    value(0); whitespace();
    if (offset !== input.length) throw Error();
    return { ok: true, value: JSON.parse(input) };
  } catch { return { ok: false, code: "INVALID_JSON" }; }
}
