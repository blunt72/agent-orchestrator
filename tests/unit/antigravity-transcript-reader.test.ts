import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, linkSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { readAntigravityTranscriptPair } from "../../src/integrations/antigravity-transcript-reader.js";

const roots: string[] = [];
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agy-reader-"))); roots.push(root);
  mkdirSync(join(root, "session"), {mode:0o700});
  const bytes = Buffer.from([
    {source:"USER",type:"REQUEST",content:"request",created_at:"2026-10-14T00:00:00Z"},
    {source:"MODEL",type:"PLANNER_RESPONSE",content:"response",created_at:"2026-10-14T00:00:01Z"},
  ].map(v => JSON.stringify(v)).join("\n") + "\n");
  const path = join(root, "session/transcript.jsonl"); writeFileSync(path, bytes, {mode:0o600});
  const selector = JSON.stringify({sourceSha256:sha(bytes),requestLine:1,responseLine:2,requestSha256:sha("request"),responseSha256:sha("response")});
  return {root,path,selector};
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
describe("confined transcript read", () => {
  it("reads exact bytes without granting review authority", () => {
    const f = fixture(), r = readAntigravityTranscriptPair(f.root,"session/transcript.jsonl",f.selector);
    expect(r.requestBytes.toString()).toBe("request"); expect(r.localFileSnapshotVerified).toBe(true);
    expect(r.sourceAuthenticated).toBe(false); expect(r.turnCompletionVerified).toBe(false); expect(r.canFinalizeReview).toBe(false);
  });
  it.each(["../escape", "/tmp/source", "session/../transcript.jsonl", "session//transcript.jsonl", "session/./transcript.jsonl", "session/\0bad"])("rejects path %s", path => {
    const f = fixture(); expect(() => readAntigravityTranscriptPair(f.root,path,f.selector)).toThrow();
  });
  it("rejects a leaf symlink", () => { const f = fixture(); symlinkSync(f.path,join(f.root,"link")); expect(() => readAntigravityTranscriptPair(f.root,"link",f.selector)).toThrow(); });
  it("rejects a directory symlink", () => { const f = fixture(); symlinkSync(join(f.root,"session"),join(f.root,"alias")); expect(() => readAntigravityTranscriptPair(f.root,"alias/transcript.jsonl",f.selector)).toThrow(); });
  it("rejects hard links", () => { const f = fixture(); linkSync(f.path,join(f.root,"copy")); expect(() => readAntigravityTranscriptPair(f.root,"session/transcript.jsonl",f.selector)).toThrow(); });
  it("rejects writable shared files and parents", () => {
    const f = fixture(); chmodSync(f.path,0o666); expect(() => readAntigravityTranscriptPair(f.root,"session/transcript.jsonl",f.selector)).toThrow();
    chmodSync(f.path,0o600); chmodSync(join(f.root,"session"),0o777); expect(() => readAntigravityTranscriptPair(f.root,"session/transcript.jsonl",f.selector)).toThrow();
  });
  it("rejects oversized bytes before parsing", () => { const f = fixture(); writeFileSync(f.path,Buffer.alloc(8*1024*1024+1)); expect(() => readAntigravityTranscriptPair(f.root,"session/transcript.jsonl",f.selector)).toThrow(); });
  it("rejects changed content pins", () => { const f = fixture(); writeFileSync(f.path,"{}\n"); expect(() => readAntigravityTranscriptPair(f.root,"session/transcript.jsonl",f.selector)).toThrow(); });
});
