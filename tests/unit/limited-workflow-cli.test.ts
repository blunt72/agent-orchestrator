import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {it,expect} from "vitest";
const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../dist/index.js");
// Parser-only subprocess checks against the built CLI; no task, provider or lifecycle calls.
it.each([
 ["preflight"], ["request"], ["complete"], ["reconcile"],
 ["preflight","--unknown"], ["complete","--approve"], ["not-a-command"],
])("rejects parser options as JSON %#",args=>{
 const result=spawnSync(process.execPath,[cli,"automation","limited",...args],{shell:false,timeout:10000,maxBuffer:32768});
 expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);
 expect(result.stdout.toString()).toBe("");
 expect(JSON.parse(result.stderr.toString())).toEqual({ok:false,code:"INVALID_OPTIONS",automaticRetry:false});
});
