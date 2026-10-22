import path from "node:path";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";

const hashes = ["bindingHash", "deliveryDigest", "testRunHash", "finalizationHash", "captureHash", "workspaceHash",
  "bindingDigest", "enrollmentDigest", "originalTaskDigest", "settlementSha256", "releaseSha256"];
const keys = [...hashes, "taskId", "revision", "attempt", "operator", "changedFiles", "workerIncarnation", "resourceId"].sort().join(",");
const fail = (): never => { throw Error("INVALID_MANAGED_DRAFT_SUBJECTS"); };

/** Fixed local draft schema only. Does not establish evidence, lifecycle permission or approval. */
export function parseOrcaManagedDraftSubjects(bytes: Buffer) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 32768) return fail();
  const parsed = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const s = parsed.ok ? parsed.value as any : null;
  if (!s || Array.isArray(s) || Object.keys(s).sort().join(",") !== keys ||
      hashes.some(key => typeof s[key] !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(s[key])) ||
      typeof s.taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(s.taskId) ||
      !Number.isSafeInteger(s.revision) || s.revision < 1 || s.revision > Number.MAX_SAFE_INTEGER - 2 ||
      !["initial", "recovery"].includes(s.attempt) ||
      typeof s.resourceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}(?![\s\S])/.test(s.resourceId) ||
      typeof s.workerIncarnation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(s.workerIncarnation) ||
      !s.operator || Object.keys(s.operator).sort().join(",") !== "namespace,subject" ||
      s.operator.namespace !== "agenthub-local-operator-v1" || typeof s.operator.subject !== "string" ||
      s.operator.subject.length < 1 || s.operator.subject.length > 256 ||
      !Array.isArray(s.changedFiles) || s.changedFiles.length < 1 || s.changedFiles.length > 256) return fail();
  const files: string[] = s.changedFiles;
  if (files.some(file => typeof file !== "string" || file.length < 1 || file.length > 1024 ||
      /[\x00-\x1f\x7f\\]/.test(file) || path.posix.isAbsolute(file) || path.win32.isAbsolute(file) ||
      file.includes(":") || file.split("/").some(part => !part || part === "." || part === "..")) ||
      new Set(files).size !== files.length || files.some((file, i) => i > 0 && files[i - 1] >= file)) return fail();
  return { subjects: s, scope: "VALIDATED_MANAGED_DRAFT_SCHEMA", evidenceVerified: false,
    approvalIssued: false, canCompleteTask: false, canReleaseWorker: false, globalGateApproved: false };
}
