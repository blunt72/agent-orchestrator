import { inspectRelayRecovery } from "./orca-relay-journal.js";
import { inspectOrcaRequestLookup } from "./orca-request-lookup.js";
import { decodeOrcaJson } from "./orca-json.js";

/** Local read-only association + externally collected read-only lookup bytes.
 * No CLI invocation, remote retry or completion. Association stays unverified. */
export async function diagnoseOrcaRelayRecovery(root: string, rawIntent: string, rawCurrent: string, lookup: Buffer | null) {
  const bytes = lookup === null ? null : Buffer.from(lookup);
  const association = await inspectRelayRecovery(root, rawIntent, rawCurrent);
  if (!association.requestId) {
    if (bytes !== null) throw Error("UNEXPECTED_ORCA_LOOKUP");
    return { ...association, stage: "REMOTE_ID_UNAVAILABLE" as const, lookupVerified: false };
  }
  if (bytes === null) return { ...association, stage: "LOOKUP_REQUIRED" as const, lookupVerified: false };
  const current = decodeOrcaJson(rawCurrent);
  if (!current.ok) throw Error("INVALID_ORCA_RELAY_DIAGNOSTIC");
  const runtime = (current.value as { runtimeId: string }).runtimeId;
  const checked = inspectOrcaRequestLookup(bytes, runtime, association.requestId);
  return { ...association, nextAction: checked.nextAction, stage: "REMOTE_RECEIPT_ABSENT" as const,
    lookupVerified: true, lookupSha256: checked.responseSha256, callerIdentityVerified: false as const };
}
