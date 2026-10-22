import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { selectOrcaDeliveryEnvelope } from "../../src/integrations/orca-delivery-envelope.js";
const sha = (v: Buffer) => createHash("sha256").update(v).digest("hex");
const binding = { agenthubTaskId: "synthetic", projectId: "project", revision: "2", generation: 1, runtimeId: "runtime", hostId: "local",
  runId: "run", taskId: "task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: "/synthetic", terminalHandle: "terminal",
  developer: "gemini", reviewer: "codex", provider: "antigravity", ownerId: "gemini", claimId: null };
const fixture = (): any => ({ id: "receipt", ok: true, _meta: { runtimeId: "runtime" }, result: {
  runId: "run", deliveryId: "delivery", count: 1, replayed: false, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false,
  messages: [{ id: "message", type: "worker_done", delivery_contract: "current_delivery", run_id: "run", from_handle: "terminal", to_handle: "run:run",
    payload: JSON.stringify({ taskId: "task", dispatchId: "dispatch", outcome: "succeeded" }) }] } });
const select = (v = fixture(), patch = {}) => {
  const bytes = Buffer.from(JSON.stringify(v, null, 2));
  return selectOrcaDeliveryEnvelope(JSON.stringify(binding), bytes, JSON.stringify({ receiptId: "receipt", deliveryId: "delivery", messageId: "message", envelopeSha256: sha(bytes), ...patch }));
};
describe("explicit delivery envelope selection (synthetic, no authority)", () => {
  it("retains original envelope and labels serialized message as derived", () => {
    const v = fixture(), r = select(v);
    expect(r.envelopeBytes.toString()).toBe(JSON.stringify(v, null, 2));
    expect(JSON.parse(r.derivedMessageBytes.toString())).toEqual(v.result.messages[0]);
    expect(r.envelopeSha256).toBe(sha(r.envelopeBytes));
    expect(r.derivedMessageSha256).toBe(sha(Buffer.from(JSON.stringify(v.result.messages[0]))));
    expect(r.messageId).toBe("message"); expect(r.deliveryId).toBe("delivery");
    expect(r).toMatchObject({ representation: "DERIVED_JSON_MESSAGE", sourceAuthenticated: false, canCompleteTask: false });
  });
  it("accepts a legitimately failed worker outcome without granting authority", () => {
    const v = fixture(); const p = JSON.parse(v.result.messages[0].payload); p.outcome = "failed";
    v.result.messages[0].payload = JSON.stringify(p); expect(select(v).canCompleteTask).toBe(false);
  });
  it("checks exact envelope and expectation UTF-8 byte boundaries", () => {
    const v = fixture(); v.result.padding = "中";
    const raw = JSON.stringify(v), base = Buffer.from(raw);
    const exact = Buffer.concat([base, Buffer.alloc(262144 - base.length, 32)]);
    const e = JSON.stringify({ receiptId: "receipt", deliveryId: "delivery", messageId: "message", envelopeSha256: sha(exact) });
    const inspect = (bytes: Buffer, expectation: string) => selectOrcaDeliveryEnvelope(JSON.stringify(binding), bytes, expectation);
    expect(inspect(exact, e).envelopeBytes.length).toBe(262144);
    const over = Buffer.concat([exact, Buffer.from(" ")]);
    expect(() => inspect(over, JSON.stringify({ ...JSON.parse(e), envelopeSha256: sha(over) }))).toThrow();
    const padded = e + " ".repeat(4096 - Buffer.byteLength(e));
    expect(inspect(exact, padded).messageId).toBe("message");
    expect(() => inspect(exact, padded + " ")).toThrow();
  });
  it("enforces node and depth budgets at exact boundaries", () => {
    const count = (v: any): number => 1 + (v && typeof v === "object" ? Object.values(v).reduce<number>((n, x) => n + count(x), 0) : 0);
    const v = fixture(); v.result.padding = [];
    v.result.padding = Array(20000 - count(v)).fill(null);
    expect(count(v)).toBe(20000); expect(select(v).messageId).toBe("message");
    v.result.padding.push(null); expect(() => select(v)).toThrow();
    const nested = fixture(); let value: any = null;
    for (let i = 0; i < 22; i++) value = [value];
    nested.result.padding = value; expect(select(nested).messageId).toBe("message");
    nested.result.padding = [value]; expect(() => select(nested)).toThrow();
  });
  it("rejects malformed outer JSON even with a matching supplied hash", () => {
    const raw = JSON.stringify(fixture());
    const withBody = fixture(); withBody.result.messages[0].body = "marker";
    const invalidUtf8 = Buffer.from(JSON.stringify(withBody)); invalidUtf8[invalidUtf8.indexOf("marker")] = 255;
    for (const bytes of [invalidUtf8, Buffer.from("\ufeff" + raw), Buffer.from(raw + " trailing"),
      Buffer.from(raw.replace('"ok":true', '"ok":true,"\\u006fk":true')), Buffer.from("[]")]) {
      const e = JSON.stringify({ receiptId: "receipt", deliveryId: "delivery", messageId: "message", envelopeSha256: sha(bytes) });
      expect(() => selectOrcaDeliveryEnvelope(JSON.stringify(binding), bytes, e)).toThrow();
    }
  });
  it("rejects ambiguous or malformed expectations", () => {
    const bytes = Buffer.from(JSON.stringify(fixture()));
    const e = { receiptId: "receipt", deliveryId: "delivery", messageId: "message", envelopeSha256: sha(bytes) };
    const raw = JSON.stringify(e);
    for (const bad of ["{}", "[]", "null", JSON.stringify({ ...e, extra: true }), JSON.stringify({ ...e, envelopeSha256: "bad" }),
      raw.replace('"messageId":"message"', '"messageId":"message","\\u006dessageId":"message"')])
      expect(() => selectOrcaDeliveryEnvelope(JSON.stringify(binding), bytes, bad)).toThrow();
    const v = fixture(); v.result.messages[0].id = "bad\n";
    expect(() => select(v, { messageId: "bad\n" })).toThrow();
  });
  it("rejects unsuccessful envelopes, extra top-level fields and invalid outcome", () => {
    for (const mode of ["ok", "extra", "outcome"]) {
      const v = fixture();
      if (mode === "ok") v.ok = false;
      if (mode === "extra") v.extra = true;
      if (mode === "outcome") v.result.messages[0].payload = { taskId: "task", dispatchId: "dispatch", outcome: "other" };
      expect(() => select(v)).toThrow();
    }
  });
  it.each(["receiptId", "messageId", "deliveryId", "envelopeSha256"])("rejects wrong pinned %s", field => {
    expect(() => select(fixture(), { [field]: field === "envelopeSha256" ? "a".repeat(64) : "other" })).toThrow();
  });
  it.each(["runId", "deliveryId", "count", "replayed", "acknowledged", "timedOut", "cancelled", "connectionLost"])("rejects altered delivery field %s", key => {
    const v = fixture(); v.result[key] = key === "count" ? 2 : ["replayed", "timedOut", "cancelled", "connectionLost"].includes(key) ? true : "wrong";
    expect(() => select(v)).toThrow();
  });
  it.each(["id", "type", "delivery_contract", "run_id", "from_handle", "to_handle"])("rejects altered message field %s", key => {
    const v = fixture(); v.result.messages[0][key] = "other"; expect(() => select(v)).toThrow();
  });
  it("rejects wrong runtime, duplicate/missing messages and ambiguous payload", () => {
    for (const mode of ["runtime", "duplicate", "missing", "payload", "task", "dispatch"]) {
      const v = fixture();
      if (mode === "runtime") v._meta.runtimeId = "other";
      if (mode === "duplicate") v.result.messages.push(v.result.messages[0]);
      if (mode === "missing") v.result.messages = [];
      if (mode === "payload") v.result.messages[0].payload = '{"taskId":"task","taskId":"task","dispatchId":"dispatch","outcome":"succeeded"}';
      if (mode === "task" || mode === "dispatch") {
        const p = JSON.parse(v.result.messages[0].payload); p[mode === "task" ? "taskId" : "dispatchId"] = "other";
        v.result.messages[0].payload = JSON.stringify(p);
      }
      expect(() => select(v)).toThrow();
    }
  });
  it("rejects non-object metadata/result/message/payload and non-array messages", () => {
    for (const mode of ["meta", "result", "message", "payload", "messages"]) {
      const v = fixture();
      if (mode === "meta") v._meta = [];
      if (mode === "result") v.result = [];
      if (mode === "message") v.result.messages = [null];
      if (mode === "payload") v.result.messages[0].payload = [];
      if (mode === "messages") v.result.messages = {};
      expect(() => select(v)).toThrow();
    }
  });
});
