import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it } from "vitest";
import { extractOrcaSessionTextBlock, readOrcaSessionTextBlockStreaming, ORCA_SESSION_MAX_BYTES,
  ORCA_SESSION_STREAM_MAX_BYTES, ORCA_SESSION_LINE_MAX_BYTES } from "../../src/integrations/orca-session-source.js";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sessionId = "11111111-1111-4111-8111-111111111111";
const rows = () => [{ ordinal: 0, type: "session_meta", payload: { id: sessionId } },
  { ordinal: 1, type: "response_item", payload: { type: "custom_tool_call", call_id: "call_one", name: "functions.exec" } },
  { ordinal: 2, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_one", output: [{ type: "input_text", text: " exact \u4e2d\n" }] } }];
const encode = (r: unknown[]) => Buffer.from(r.map(row => JSON.stringify(row)).join("\n") + "\n");
const selection = (bytes: Buffer) => JSON.stringify({ sessionId, callId: "call_one", toolName: "functions.exec", ordinal: 2,
  sourceSha256: sha(bytes), blockIndex: 0, blockSha256: sha(Buffer.from(" exact \u4e2d\n")) });
let root: string;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orca-stream-"))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const read = async (bytes = encode(rows()), raw = selection(bytes)) => {
  await fs.writeFile(path.join(root, "session.jsonl"), bytes);
  return readOrcaSessionTextBlockStreaming(root, "session.jsonl", raw);
};
it("matches exact buffered extraction including original line bytes", async () => {
  const bytes = encode(rows()); expect(await read(bytes)).toEqual(extractOrcaSessionTextBlock(bytes, selection(bytes)));
});
it("preserves lexical whitespace, CRLF and block UTF-8", async () => {
  const r = rows(), prefix = encode(r.slice(0, 2));
  const bytes = Buffer.concat([prefix, Buffer.from(" " + JSON.stringify(r[2]) + " \r\n")]);
  const result = await read(bytes); expect(result.recordBytes.toString().endsWith(" \r\n")).toBe(true);
  expect(result.outputBytes.toString()).toBe(" exact \u4e2d\n");
});
it("handles a multibyte character split across chunk boundary", async () => {
  const bytes = encode(rows()), index = bytes.indexOf(Buffer.from("\u4e2d"));
  const padded = Buffer.concat([bytes.subarray(0, index), Buffer.alloc(65535 - index, 32), bytes.subarray(index)]);
  // Padding is within the output string, so the exact selected block pin also changes.
  const raw = JSON.parse(selection(padded)); raw.blockSha256 = sha(Buffer.from(" exact " + " ".repeat(65535 - index) + "\u4e2d\n"));
  expect((await read(padded, JSON.stringify(raw))).outputSha256).toBe(raw.blockSha256);
});
it("reads above buffered cap without changing that cap", async () => {
  const r: unknown[] = rows();
  const pad = "x".repeat(1024 * 1024);
  for (let ordinal = 3; ordinal < 36; ordinal++) r.push({ ordinal, type: "event_msg", payload: { pad } });
  const bytes = encode(r); expect(bytes.length).toBeGreaterThan(ORCA_SESSION_MAX_BYTES);
  expect(() => extractOrcaSessionTextBlock(bytes, selection(bytes))).toThrow("INVALID_ORCA_SESSION_SOURCE");
  expect((await read(bytes)).ordinal).toBe(2);
}, 10000);
it("rejects a trailing invalid record even after finding output", async () => {
  const bytes = Buffer.concat([encode(rows()), Buffer.from('{"ordinal":3,"ordinal":3,"type":"event_msg","payload":{}}\n')]);
  await expect(read(bytes)).rejects.toThrow("INVALID_ORCA_SESSION_SOURCE");
});
it("rejects duplicate output later in the journal", async () => {
  const r = rows(); r.push({ ...r[2], ordinal: 3 }); await expect(read(encode(r))).rejects.toThrow("INVALID_ORCA_SESSION_SOURCE");
});
it.each(["partial", "blank", "utf8", "bom"])("rejects %s framing", async kind => {
  const bytes = encode(rows());
  const bad = kind === "partial" ? bytes.subarray(0, bytes.length - 1) : kind === "blank" ? Buffer.concat([bytes, Buffer.from("\n")]) :
    kind === "utf8" ? Buffer.concat([bytes, Buffer.from([0xff, 10])]) : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
  await expect(read(bad)).rejects.toThrow("INVALID_ORCA_SESSION_SOURCE");
});
it("rejects wrong full-source and block pins", async () => {
  const bytes = encode(rows()), original = JSON.parse(selection(bytes));
  for (const patch of [{ sourceSha256: "a".repeat(64) }, { blockSha256: "a".repeat(64) }])
    await expect(read(bytes, JSON.stringify({ ...original, ...patch }))).rejects.toThrow();
});
it("rejects an oversized line split over many chunks", async () => {
  const bytes = Buffer.concat([encode(rows()), Buffer.alloc(ORCA_SESSION_LINE_MAX_BYTES + 1, 32), Buffer.from("\n")]);
  await expect(read(bytes)).rejects.toThrow("INVALID_ORCA_SESSION_SOURCE");
});
it("rejects file size above streaming cap before allocation", async () => {
  const file = path.join(root, "large.jsonl"); await fs.writeFile(file, ""); await fs.truncate(file, ORCA_SESSION_STREAM_MAX_BYTES + 1);
  await expect(readOrcaSessionTextBlockStreaming(root, "large.jsonl", selection(encode(rows())))).rejects.toThrow("INVALID_ORCA_SESSION_SOURCE");
});
it("rejects traversal, symlinks and hardlinks", async () => {
  const bytes = encode(rows()), raw = selection(bytes), file = path.join(root, "session.jsonl"); await fs.writeFile(file, bytes);
  await fs.symlink(file, path.join(root, "link"));
  for (const name of ["../escape", "./session.jsonl", "/absolute", "link"])
    await expect(readOrcaSessionTextBlockStreaming(root, name, raw)).rejects.toThrow();
  await fs.link(file, path.join(root, "hard"));
  await expect(readOrcaSessionTextBlockStreaming(root, "hard", raw)).rejects.toThrow();
});
it("accepts explicit matching nonzero fork header without renumbering", async () => {
  const r = rows(); r.forEach(row => { row.ordinal += 3108; });
  Object.assign(r[0].payload, { forked_from_id: "22222222-2222-4222-8222-222222222222", forked_from_ordinal_exclusive: 3108 });
  const bytes = encode(r), raw = JSON.parse(selection(bytes)); raw.ordinal = 3110;
  expect((await read(bytes, JSON.stringify(raw)))).toMatchObject({ ordinal: 3110, callOrdinal: 3109,
    sessionHeaderOrdinal: 3108, forkedFromOrdinalExclusive: 3108, forkedFromId: "22222222-2222-4222-8222-222222222222" });
  expect(() => extractOrcaSessionTextBlock(bytes, JSON.stringify(raw))).toThrow("INVALID_ORCA_SESSION_SOURCE");
});
it.each(["missing", "mismatch", "self", "bad-id", "negative"])("rejects invalid fork header: %s", async kind => {
  const r = rows(); r.forEach(row => { row.ordinal += 3108; });
  const header: any = r[0].payload;
  header.forked_from_id = kind === "self" ? sessionId : kind === "bad-id" ? "bad" : "22222222-2222-4222-8222-222222222222";
  header.forked_from_ordinal_exclusive = kind === "mismatch" ? 1 : kind === "negative" ? -1 : 3108;
  if (kind === "missing") delete header.forked_from_id;
  const bytes = encode(r), raw = JSON.parse(selection(bytes)); raw.ordinal = 3110;
  await expect(read(bytes, JSON.stringify(raw))).rejects.toThrow("INVALID_ORCA_SESSION_SOURCE");
});
