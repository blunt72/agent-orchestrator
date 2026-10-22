import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, appendFileSync, renameSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({afterRead: undefined as undefined | (() => void), closed: 0}));
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {...original,
    readSync: (...args: Parameters<typeof original.readSync>) => {
      const n = original.readSync(...args);
      const hook = control.afterRead; control.afterRead = undefined; hook?.();
      return n;
    },
    closeSync: (fd: number) => { control.closed++; return original.closeSync(fd); },
  };
});
import { readAntigravityTranscriptPair } from "../../src/integrations/antigravity-transcript-reader.js";

const roots: string[] = [];
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agy-drift-"))); roots.push(root);
  mkdirSync(join(root,"session"),{mode:0o700});
  const bytes = Buffer.from([
    {source:"USER",type:"REQUEST",content:"request",created_at:"2026-10-14T00:00:00Z"},
    {source:"MODEL",type:"PLANNER_RESPONSE",content:"response",created_at:"2026-10-14T00:00:01Z"},
  ].map(v => JSON.stringify(v)).join("\n") + "\n");
  const path = join(root,"session/transcript.jsonl"); writeFileSync(path,bytes,{mode:0o600});
  const selector = JSON.stringify({sourceSha256:sha(bytes),requestLine:1,responseLine:2,requestSha256:sha("request"),responseSha256:sha("response")});
  return {root,path,bytes,selector};
}
afterEach(() => { control.afterRead = undefined; control.closed = 0; for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });

// Only timing is injected. Source bytes, descriptors and mutations use real
// temporary files, not provider records or a simulated production acceptance.
it.each(["append","truncate","replace","permissions","directory"])("rejects mid-read %s and closes descriptor", kind => {
  const f = fixture();
  control.afterRead = () => {
    if (kind === "append") appendFileSync(f.path,"{}\n");
    if (kind === "truncate") writeFileSync(f.path,"");
    if (kind === "replace") { renameSync(f.path, f.path + ".old"); writeFileSync(f.path,f.bytes,{mode:0o600}); }
    if (kind === "permissions") chmodSync(f.path,0o666);
    if (kind === "directory") {
      renameSync(join(f.root,"session"),join(f.root,"old"));
      mkdirSync(join(f.root,"session"),{mode:0o700}); writeFileSync(f.path,f.bytes,{mode:0o600});
    }
  };
  expect(() => readAntigravityTranscriptPair(f.root,"session/transcript.jsonl",f.selector)).toThrow();
  expect(control.closed).toBe(1);
});

it("closes descriptor on extractor failure", () => {
  const f = fixture();
  expect(() => readAntigravityTranscriptPair(f.root,"session/transcript.jsonl","{}")).toThrow();
  expect(control.closed).toBe(1);
});
