import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {it,expect} from "vitest";

const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../dist/index.js");

it.each([["-h"],["--help"]])("server %s prints help instead of treating it as --host",flag=>{
 const result=spawnSync(process.execPath,[cli,"server",flag],{shell:false,timeout:10000,encoding:"utf8"});
 expect(result.error).toBeUndefined();
 expect(result.status).toBe(0);
 expect(result.stdout).toContain("Start the AgentHub REST API server");
 expect(result.stderr).toBe("");
});
