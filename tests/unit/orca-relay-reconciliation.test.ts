import { describe, expect, it } from "vitest";
import { reconcileOrcaRelay } from "../../src/integrations/orca-relay-reconciliation.js";

const hash = "a".repeat(64), other = "b".repeat(64);
const identity = { runtimeId: "runtime", callerId: "caller", taskId: "task", generation: 1, bindingDigest: hash, policyDigest: hash };
const intent = { version: 1, identity, operationId: "request", requestDigest: hash, kind: "reply", phase: "INTENT", receiptDigest: null };
const observed = { identity, operationId: "request", requestDigest: hash, status: "completed", receiptDigest: hash };
const run = (i: unknown = intent, o: unknown = observed, c: unknown = identity) =>
  reconcileOrcaRelay(JSON.stringify(i), JSON.stringify(o), JSON.stringify(c));

describe("synthetic normalized relay reconciliation, no CLI or persistence", () => {
  it("requires retained receipt before recording completed observation", () => {
    expect(run()).toEqual({ action: "RETAIN_RECEIPT", canReplay: false, canReleaseDevelopment: false, canCompleteTask: false, sourceAuthenticated: false });
  });
  it.each(["create", "release_development", "reply", "ack", "cleanup"])("never replays %s from pending", kind => {
    expect(run({ ...intent, kind }, { ...observed, status: "pending", receiptDigest: null }).action).toBe("WAIT_ORIGINAL");
  });
  it.each(["absent", "unreachable"])("%s never proves no side effect", status => {
    expect(run(intent, { ...observed, status, receiptDigest: null }).action).toBe("INSPECT_REMOTE");
  });
  it.each(Object.keys(identity))("rejects drift of %s on current identity and remote observation", key => {
    const changed = { ...identity, [key]: key === "generation" ? 2 : key.endsWith("Digest") ? other : "changed" };
    expect(run(intent, observed, changed).action).toBe("CONFLICT");
    expect(run(intent, { ...observed, identity: changed }).action).toBe("CONFLICT");
  });
  it.each(["operationId", "requestDigest"])("conflicts on %s", key => {
    expect(run(intent, { ...observed, [key]: key === "requestDigest" ? other : "different" }).action).toBe("CONFLICT");
  });
  it("deduplicates observed receipt but rejects conflicting bytes", () => {
    const retained = { ...intent, phase: "OBSERVED", receiptDigest: hash };
    expect(run(retained).action).toBe("RETAINED");
    expect(run(retained, { ...observed, receiptDigest: other }).action).toBe("CONFLICT");
  });
  it.each(["pending", "absent", "unreachable"])("does not erase retained receipt on %s", status => {
    expect(run({ ...intent, phase: "OBSERVED", receiptDigest: hash }, { ...observed, status, receiptDigest: null }).action).toBe("RETAINED");
  });
  it.each([
    { ...intent, extra: true }, { ...intent, version: 2 }, { ...intent, phase: "DONE" },
    { ...intent, receiptDigest: hash }, { ...intent, phase: "OBSERVED" },
    { ...intent, kind: "shell" }, { ...intent, operationId: "bad\n" },
    { ...intent, identity: { ...identity, generation: 0 } },
    { ...intent, identity: { ...identity, generation: Number.MAX_SAFE_INTEGER + 1 } },
    { ...intent, identity: { ...identity, bindingDigest: "short" } },
    { ...intent, identity: { ...identity, extra: true } },
  ])("rejects malformed intent %#", input => expect(() => run(input)).toThrow("INVALID_RELAY_RECONCILIATION"));
  it.each([
    { ...observed, extra: true }, { ...observed, status: "missing" },
    { ...observed, receiptDigest: null }, { ...observed, status: "absent" },
    { ...observed, identity: null }, { ...observed, requestDigest: "short" },
  ])("rejects malformed observation %#", input => expect(() => run(intent, input)).toThrow());
  it("rejects duplicate keys and oversized JSON", () => {
    expect(() => reconcileOrcaRelay('{"version":1,"version":1}', JSON.stringify(observed), JSON.stringify(identity))).toThrow();
    expect(() => reconcileOrcaRelay(" ".repeat(262145), JSON.stringify(observed), JSON.stringify(identity))).toThrow();
  });
  it("does not mutate supplied records", () => {
    const before = JSON.stringify({ intent, observed, identity }); run();
    expect(JSON.stringify({ intent, observed, identity })).toBe(before);
  });
});
