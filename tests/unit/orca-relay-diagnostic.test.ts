import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { persistRelayIntent, persistRelayRecovery } from "../../src/integrations/orca-relay-journal.js";
import { diagnoseOrcaRelayRecovery } from "../../src/integrations/orca-relay-diagnostic.js";
describe("synthetic readonly recovery chain, no CLI", () => {
  it("keeps missing ID and absent lookup fail-closed across restart reads", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "diagnostic-")));
    const identity = { runtimeId: "runtime", callerId: "caller", taskId: "task", generation: 1,
      bindingDigest: "a".repeat(64), policyDigest: "b".repeat(64) };
    const request = Buffer.from("request");
    const raw = JSON.stringify({ version: 1, identity, operationId: "local", requestDigest: createHash("sha256").update(request).digest("hex"), kind: "reply", phase: "INTENT", receiptDigest: null });
    const current = JSON.stringify(identity), requestId = "12345678-1234-1234-1234-123456789abc";
    const lookup = (id = requestId) => Buffer.from(JSON.stringify({ id: "receipt", ok: true, result: { requestId: id, state: "absent" }, _meta: { runtimeId: "runtime" } }));
    try {
      await persistRelayIntent(root, raw, request);
      expect(await diagnoseOrcaRelayRecovery(root, raw, current, null)).toMatchObject({ stage: "REMOTE_ID_UNAVAILABLE", canReplay: false });
      await expect(diagnoseOrcaRelayRecovery(root, raw, current, lookup())).rejects.toThrow("UNEXPECTED_ORCA_LOOKUP");
      const error = Buffer.from(JSON.stringify({ id: "error", ok: false, _meta: { runtimeId: "runtime" }, error: { code: "runtime_timeout", data: { orchestrationRequestId: requestId } } }));
      await persistRelayRecovery(root, raw, current, error);
      expect(await diagnoseOrcaRelayRecovery(root, raw, current, null)).toMatchObject({ stage: "LOOKUP_REQUIRED", requestId, canReplay: false });
      const names = await fs.readdir(path.join(root, "data/orca-relay-journal-v1"));
      const before = await Promise.all(names.map(n => fs.readFile(path.join(root, "data/orca-relay-journal-v1", n))));
      expect(await diagnoseOrcaRelayRecovery(root, raw, current, lookup())).toMatchObject({ stage: "REMOTE_RECEIPT_ABSENT", nextAction: "INSPECT_REMOTE", associationAuthenticated: false, callerIdentityVerified: false, canReplay: false, canCompleteTask: false });
      await expect(diagnoseOrcaRelayRecovery(root, raw, current, lookup("other"))).rejects.toThrow();
      await expect(diagnoseOrcaRelayRecovery(root, raw, JSON.stringify({ ...identity, generation: 2 }), lookup())).rejects.toThrow();
      expect(await Promise.all(names.map(n => fs.readFile(path.join(root, "data/orca-relay-journal-v1", n))))).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
