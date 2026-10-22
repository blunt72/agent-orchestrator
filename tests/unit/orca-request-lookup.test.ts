import { describe, expect, it } from "vitest";
import { inspectOrcaRequestLookup, inspectOrcaMutationRecovery } from "../../src/integrations/orca-request-lookup.js";
const response = { id: "receipt", ok: true, result: { requestId: "request", state: "absent", interpretation: "not proof" }, _meta: { runtimeId: "runtime" } };
const run = (v: unknown = response) => inspectOrcaRequestLookup(Buffer.from(JSON.stringify(v)), "runtime", "request");
describe("synthetic CLI lookup normalization; absent only", () => {
  it("retains exact response bytes without granting retry", () => {
    const value = run();
    expect(value.responseBytes).toEqual(Buffer.from(JSON.stringify(response)));
    expect(value).toMatchObject({ state: "absent", nextAction: "INSPECT_REMOTE", canReplay: false, callerIdentityVerified: false, sourceAuthenticated: false, canCompleteTask: false });
  });
  it.each(["pending", "completed", "unknown"])("fails closed on unsupported %s", state => {
    expect(() => run({ ...response, result: { ...response.result, state } })).toThrow("UNSUPPORTED_ORCA_REQUEST_LOOKUP_STATE");
  });
  it.each([
    { ...response, ok: false }, { ...response, id: "bad\n" },
    { ...response, _meta: { runtimeId: "other" } },
    { ...response, result: { ...response.result, requestId: "other" } },
    { ...response, result: null }, { ...response, _meta: null },
  ])("rejects mismatched or invalid receipt %#", v => expect(() => run(v)).toThrow());
  it("ignores unknown capability-like fields, never accepts authority", () => {
    expect(run({ ...response, canReplay: true, result: { ...response.result, safeToRetry: true } }).canReplay).toBe(false);
  });
  it("rejects duplicate keys, UTF-8 errors and excessive size", () => {
    for (const b of [Buffer.from('{"ok":true,"ok":true}'), Buffer.from([255]), Buffer.alloc(262145)])
      expect(() => inspectOrcaRequestLookup(b, "runtime", "request")).toThrow();
  });
  it("copies caller-owned bytes", () => {
    const b = Buffer.from(JSON.stringify(response)), result = inspectOrcaRequestLookup(b, "runtime", "request");
    b.fill(0); expect(result.responseBytes.toString()).toBe(JSON.stringify(response));
  });
});

describe("source-informed synthetic mutation recovery envelopes, no replay", () => {
  const requestId = "12345678-1234-1234-1234-123456789abc";
  const data = { orchestrationRequestId: requestId, originalCommand: ["arbitrary", "untrusted"],
    recovery: { orchestrationRequestId: requestId, disposition: "outcome_unknown", workerDeathInferred: false,
      queryCommand: ["malicious"], retryCommand: ["do-not-execute"] } };
  const envelope = { id: "receipt", ok: false, _meta: { runtimeId: "runtime" }, error: { code: "runtime_timeout", data } };
  const run = (d: unknown = data, code = "runtime_timeout") => inspectOrcaMutationRecovery(
    Buffer.from(JSON.stringify({ ...envelope, error: { code, data: d } })), "runtime");
  it.each(["runtime_timeout", "runtime_unavailable", "remote_runtime_unavailable", "invalid_runtime_response"])("retains reported identity on %s without argv execution", code => {
    const value = run(data, code);
    expect(value).toMatchObject({ requestId, nextAction: "LOOKUP_REQUEST", canReplay: false, callerIdentityVerified: false });
    expect(Object.keys(value)).not.toContain("retryCommand");
    expect(Object.keys(value)).not.toContain("queryCommand");
    expect(value.responseBytes).toEqual(Buffer.from(JSON.stringify({ ...envelope, error: { code, data } })));
  });
  it("suggests exact dispatch inspection if reported, not a terminal action", () => {
    expect(run({ ...data, dispatchId: "ctx_dispatch", recovery: { ...data.recovery, dispatchId: "ctx_dispatch" } }))
      .toMatchObject({ dispatchId: "ctx_dispatch", nextAction: "INSPECT_DISPATCH", canCompleteTask: false });
  });
  it("does not fabricate a remote ID from a local operation token", () => {
    expect(() => run({ orchestrationRequestId: "local-operation" })).toThrow();
  });
  it.each([
    { ...data, orchestrationRequestId: requestId + "\n" },
    { ...data, recovery: { ...data.recovery, orchestrationRequestId: "other" } },
    { ...data, recovery: { ...data.recovery, workerDeathInferred: true } },
    { ...data, recovery: { ...data.recovery, disposition: "safe_to_retry" } },
    { ...data, recovery: { ...data.recovery, dispatchId: "different" }, dispatchId: "ctx_dispatch" },
    { ...data, dispatchId: "bad\n" }, null,
  ])("rejects contradictory recovery %#", d => expect(() => run(d)).toThrow());
  it("rejects other errors, mismatched runtime and duplicate keys", () => {
    expect(() => run(data, "invalid_argument")).toThrow();
    expect(() => inspectOrcaMutationRecovery(Buffer.from(JSON.stringify(envelope)), "other")).toThrow();
    expect(() => inspectOrcaMutationRecovery(Buffer.from('{"ok":false,"ok":false}'), "runtime")).toThrow();
  });
  it("accepts reported UUID without optional recovery commands", () => {
    expect(run({ orchestrationRequestId: requestId }).requestId).toBe(requestId);
  });
});
