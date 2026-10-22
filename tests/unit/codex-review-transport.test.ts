import { describe, it, expect } from "vitest";
import { validateCodexReviewTransport } from "../../src/agents/codex-review-transport.js";
const session = "aaaaaaaa-0000-4000-8000-000000000004";
const thread = "01900000-0000-7000-8000-000000000002";
const value = { version: 1, code: 0, adapterSessionId: session, providerSessionId: thread, finalHash: "a".repeat(64), stderrBase64: "", stdout: [{type:"thread.started",thread_id:thread},{type:"turn.started"},{type:"turn.completed"}].map(v=>JSON.stringify(v)).join("\n") };
describe("native transport binding (synthetic)", () => {
  it("binds final bytes and both session identities", () => {
    expect(validateCodexReviewTransport(JSON.stringify(value), value.finalHash, session)).toEqual({adapterSessionId:session,providerSessionId:thread});
  });
  it.each([{code:1},{providerSessionId:session},{adapterSessionId:"bad"},{finalHash:"b".repeat(64)},{stdout:""},{stderrBase64:"!"},{extra:true}])("rejects changed subject %#", patch => {
    expect(()=>validateCodexReviewTransport(JSON.stringify({...value,...patch}),value.finalHash,session)).toThrow();
  });
  it("rejects wrong expected session and oversized raw input", () => {
    expect(()=>validateCodexReviewTransport(JSON.stringify(value),value.finalHash,thread)).toThrow();
    expect(()=>validateCodexReviewTransport("x".repeat(4194305),value.finalHash)).toThrow();
  });
});
