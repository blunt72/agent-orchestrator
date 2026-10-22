import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { captureAntigravityPrint } from "../../src/integrations/antigravity-print-capture.js";
import { inspectAntigravityPrintSource } from "../../src/integrations/antigravity-print-source.js";
const roots: string[] = [];
function config(prompt = "success") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"agy-capture-"))); roots.push(root);
  const executable = path.join(root,"fixture");
  fs.copyFileSync(path.resolve("tests/fixtures/antigravity-print-process.mjs"),executable); fs.chmodSync(executable,0o700);
  return {executable,cwd:root,evidenceRoot:root,requestId:randomUUID(),prompt,timeoutMs:3000};
}
afterEach(()=>{vi.restoreAllMocks(); for(const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true});});
it("retains exact request, output and close receipt without authority",async()=> {
  const c = {...config(),timeoutMs:10000}, r = await captureAntigravityPrint(c);
  expect(r.failure).toBeNull();
  expect(r.status).toBe("CAPTURED"); expect(r.protocol?.response).toBe("OK\n"); expect(r.canFinalizeReview).toBe(false);
  expect(fs.readFileSync(path.join(r.evidenceDirectory,"request.bin"),"utf8")).toBe(c.prompt);
  expect(JSON.parse(fs.readFileSync(path.join(r.evidenceDirectory,"process.json"),"utf8")).code).toBe(0);
  await expect(captureAntigravityPrint(c)).rejects.toThrow();
},15000);
it.each([["failure","PROCESS_FAILED"],["bad","PROTOCOL_FAILED"],["overflow","STDOUT_LIMIT"],["hang","TIMEOUT"]])("retains %s failure without retry",async(prompt,failure)=> {
  const c = config(prompt); if(prompt === "overflow") Object.assign(c,{maxStdoutBytes:100}); if(prompt === "hang") c.timeoutMs = 200;
  const r = await captureAntigravityPrint(c); expect(r.status).toBe("FAILED"); expect(r.failure).toBe(failure);
  expect(fs.existsSync(path.join(r.evidenceDirectory,"stdout.bin"))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(r.evidenceDirectory,"process.json"),"utf8")).automaticRetry).toBe(false);
  await expect(captureAntigravityPrint(c)).rejects.toThrow();
});
it("rejects invalid prompt before creating intent",async()=> {
  const c = config("x".repeat(65537)); await expect(captureAntigravityPrint(c)).rejects.toThrow();
  expect(fs.existsSync(path.join(c.evidenceRoot,c.requestId))).toBe(false);
});
it("retains spawn failure without retry",async()=> {
  const c = config(); fs.chmodSync(c.executable,0o600);
  const r = await captureAntigravityPrint(c); expect(r.failure).toBe("SPAWN_ERROR");
  expect(r.protocol).toBe(null); await expect(captureAntigravityPrint(c)).rejects.toThrow();
});
it("bounds stderr independently and marks truncation",async()=> {
  const c = {...config("stderr-overflow"),maxStderrBytes:100};
  const r = await captureAntigravityPrint(c); expect(r.failure).toBe("STDERR_LIMIT");
  expect(fs.statSync(path.join(r.evidenceDirectory,"stderr.bin")).size).toBe(100);
  expect(JSON.parse(fs.readFileSync(path.join(r.evidenceDirectory,"process.json"),"utf8")).truncated).toBe(true);
});
it("does not inherit Orca identity",async()=> {
  const old = process.env.ORCA_TERMINAL_HANDLE; process.env.ORCA_TERMINAL_HANDLE = "must-not-inherit";
  try { expect((await captureAntigravityPrint(config())).status).toBe("CAPTURED"); }
  finally { if(old === undefined) delete process.env.ORCA_TERMINAL_HANDLE; else process.env.ORCA_TERMINAL_HANDLE = old; }
});
it("rejects a partial output write without publishing misleading hashes",async()=> {
  const c = config(), write = fs.writeFileSync.bind(fs);
  vi.spyOn(fs,"writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>)=> {
    if (typeof args[0] === "number" && Buffer.isBuffer(args[1]) && args[1].includes(Buffer.from('"event"'))) {
      write(args[0],args[1].subarray(0,5)); throw new Error("INJECTED_WRITE_FAILURE");
    }
    return write(...args);
  });
  await expect(captureAntigravityPrint(c)).rejects.toThrow("INJECTED_WRITE_FAILURE");
  expect(fs.existsSync(path.join(c.evidenceRoot,c.requestId,"process.json"))).toBe(false);
  await expect(captureAntigravityPrint(c)).rejects.toThrow();
});
it("closes both stream descriptors even if stdout flush fails",async()=> {
  const c = config(), open = fs.openSync.bind(fs), sync = fs.fsyncSync.bind(fs), targets: number[] = [];
  vi.spyOn(fs,"openSync").mockImplementation((...args: Parameters<typeof fs.openSync>)=> {
    const fd = open(...args); if (String(args[0]).endsWith("stdout.bin") || String(args[0]).endsWith("stderr.bin")) targets.push(fd); return fd;
  });
  vi.spyOn(fs,"fsyncSync").mockImplementation(fd=> { if(fd === targets[0]) throw new Error("INJECTED_FLUSH_FAILURE"); sync(fd); });
  const close = vi.spyOn(fs,"closeSync");
  await expect(captureAntigravityPrint(c)).rejects.toThrow("CAPTURE_CLEANUP_FAILED");
  expect(targets).toHaveLength(2); for(const fd of targets) expect(close).toHaveBeenCalledWith(fd);
  expect(fs.existsSync(path.join(c.evidenceRoot,c.requestId,"process.json"))).toBe(false);
});
it("uses explicit version two read profile without changing default acceptance",async()=> {
  const c={...config("read-profile"),readOnlyPaths:[] as string[]};c.readOnlyPaths=[c.cwd+"/fixture.txt"];
  const r=await captureAntigravityPrint(c);expect(r.status).toBe("CAPTURED");
  const read=(name:string)=>fs.readFileSync(path.join(r.evidenceDirectory,name));
  const intent=JSON.parse(read("intent.json").toString()),receipt=JSON.parse(read("process.json").toString());
  expect(intent.version).toBe(2);expect(receipt.profile).toEqual(intent.profile);
  const expected={requestId:c.requestId,cwd:c.cwd,executable:c.executable,requestSha256:intent.requestSha256,profile:intent.profile};
  const inspect=(e:any,p=read("process.json"))=>inspectAntigravityPrintSource(read("request.bin"),read("intent.json"),read("stdout.bin"),read("stderr.bin"),p,JSON.stringify(e));
  expect(inspect(expected).profile).toBe("view-file-v1");
  const old={...expected};delete old.profile;expect(()=>inspect(old)).toThrow();
  const changed=structuredClone(receipt);changed.profile.allowedPaths=[c.cwd+"/other"];
  expect(()=>inspect(expected,Buffer.from(JSON.stringify(changed)))).toThrow();
});
it("does not automatically switch a no-tool capture to read mode",async()=> {
  expect((await captureAntigravityPrint(config("read-profile"))).failure).toBe("PROTOCOL_FAILED");
});
it("rejects invalid or sparse path allowlists before intent",async()=> {
  const c=config();for(const readOnlyPaths of [new Array(1),["relative"],["/"+"x".repeat(4097)]]) {
    await expect(captureAntigravityPrint({...c,readOnlyPaths})).rejects.toThrow();
    expect(fs.existsSync(path.join(c.evidenceRoot,c.requestId))).toBe(false);
  }
});
it("retains overflow and termination error separately on natural child close",async()=> {
  const c={...config("overflow"),maxStdoutBytes:100};
  vi.spyOn(process,"kill").mockImplementation(()=>{throw Object.assign(new Error("injected"),{code:"EPERM"});});
  const r=await captureAntigravityPrint(c);expect(r.status).toBe("FAILED");expect(r.failure).toBe("STDOUT_LIMIT");
  const p=JSON.parse(fs.readFileSync(path.join(r.evidenceDirectory,"process.json"),"utf8"));
  expect(p.terminationFailure).toEqual({code:"EPERM"});expect(p.truncated).toBe(true);
});
it("pins Gemini in actual argv and version-three source metadata",async()=> {
  const c={...config("model-check"),model:"gemini-3.8-flash-high" as const},r=await captureAntigravityPrint(c);expect(r.status).toBe("CAPTURED");
  const read=(name:string)=>fs.readFileSync(path.join(r.evidenceDirectory,name)),i=JSON.parse(read("intent.json").toString());
  expect(i.version).toBe(3);expect(i.model).toBe(c.model);
  const expected={requestId:c.requestId,cwd:c.cwd,executable:c.executable,requestSha256:i.requestSha256,model:c.model};
  const inspect=(e:any)=>inspectAntigravityPrintSource(read("request.bin"),read("intent.json"),read("stdout.bin"),read("stderr.bin"),read("process.json"),JSON.stringify(e));
  expect(inspect(expected).configuredModel).toBe(c.model);expect(inspect(expected).modelIdentityVerified).toBe(false);
  expect(()=>inspect({...expected,model:"gemini-3.8-flash-low"})).toThrow();
  const unpinned={...expected};delete (unpinned as any).model;expect(()=>inspect(unpinned)).toThrow();
});
it.each(["claude-sonnet-4-6","gpt-oss-120b-medium","gemini-unknown",null])("rejects unsupported configured model %s before intent",async model=> {
  const c=config();await expect(captureAntigravityPrint({...c,model:model as any})).rejects.toThrow("INVALID_PRINT_MODEL");
  expect(fs.existsSync(path.join(c.evidenceRoot,c.requestId))).toBe(false);
});
it.each(["gemini-3.8-flash-medium","gemini-3.8-flash-low"] as const)("pins %s together with read profile",async model=> {
  const c=config("read-profile"),r=await captureAntigravityPrint({...c,model,readOnlyPaths:[c.cwd+"/fixture.txt"]});expect(r.status).toBe("CAPTURED");
  const read=(name:string)=>fs.readFileSync(path.join(r.evidenceDirectory,name)),i=JSON.parse(read("intent.json").toString());
  const source=inspectAntigravityPrintSource(read("request.bin"),read("intent.json"),read("stdout.bin"),read("stderr.bin"),read("process.json"),
    JSON.stringify({requestId:c.requestId,cwd:c.cwd,executable:c.executable,requestSha256:i.requestSha256,model,profile:i.profile}));
  expect(source.configuredModel).toBe(model);expect(source.modelIdentityVerified).toBe(false);
});
