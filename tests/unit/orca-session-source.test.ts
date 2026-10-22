import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { extractOrcaSessionToolOutput, readOrcaSessionToolOutput, ORCA_SESSION_MAX_BYTES, ORCA_SESSION_LINE_MAX_BYTES } from "../../src/integrations/orca-session-source.js";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sessionId = "11111111-1111-4111-8111-111111111111";
const rows = () => [{ ordinal: 0, type: "session_meta", payload: { id: sessionId, session_id: sessionId } },
  { ordinal: 1, type: "response_item", payload: { type: "function_call", call_id: "call_one", name: "exec_command", arguments: "untrusted; never execute" } },
  { ordinal: 2, type: "response_item", payload: { type: "function_call_output", call_id: "call_one", output: " exact\n\u4e2d\n" } }];
const encode = (value: unknown[]) => Buffer.from(value.map(row => JSON.stringify(row)).join("\n") + "\n");
const selector = (bytes: Buffer) => JSON.stringify({ callId: "call_one", ordinal: 2, sessionId, sourceSha256: sha(bytes), toolName: "exec_command" });
const extract = (bytes = encode(rows())) => extractOrcaSessionToolOutput(bytes, selector(bytes));
let root: string;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orca-session-"))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe("pinned local session extraction (synthetic journals, no authorship/provider authority)", () => {
  it("retains original line bytes and decoded exact UTF-8 output with no execution or authority", () => {
    const bytes = encode(rows()), result = extract(bytes), original = Buffer.from(JSON.stringify(rows()[2]) + "\n");
    expect(result.recordBytes.equals(original)).toBe(true);
    expect(result.recordSha256).toBe(sha(original)); expect(result.outputBytes.toString()).toBe(" exact\n\u4e2d\n");
    expect(result.outputSha256).toBe(sha(Buffer.from(" exact\n\u4e2d\n")));
    expect(result).toMatchObject({callOrdinal:1,ordinal:2,sourceAuthenticated:false,canCompleteTask:false});
    bytes.fill(0); expect(result.recordBytes.equals(original)).toBe(true);
  });
  it("reads a confined actual file without changing its bytes", async () => {
    const bytes = encode(rows()), file = path.join(root, "session.jsonl"); await fs.writeFile(file, bytes);
    expect((await readOrcaSessionToolOutput(root, "session.jsonl", selector(bytes))).outputBytes.toString()).toBe(" exact\n\u4e2d\n");
    expect((await fs.readFile(file)).equals(bytes)).toBe(true);
  });
  it("preserves a noncanonical lexical line without reserializing it",()=>{
    const line=' { "payload" : { "output" : "\\u4e2d", "call_id":"call_one", "type":"function_call_output" }, "type":"response_item", "ordinal":2 } \r\n';
    const bytes=Buffer.concat([encode(rows().slice(0,2)),Buffer.from(line)]),result=extract(bytes);
    expect(result.recordBytes.equals(Buffer.from(line))).toBe(true);expect(result.recordSha256).toBe(sha(Buffer.from(line)));
    expect(result.outputBytes.equals(Buffer.from("\u4e2d"))).toBe(true);
  });
  it("rejects wrong full-file pin, session/tool/call IDs and ordinal", () => {
    const bytes = encode(rows()), original = JSON.parse(selector(bytes));
    for (const patch of [{sourceSha256:"a".repeat(64)},{sessionId:"22222222-2222-4222-8222-222222222222"},{toolName:"other"},{callId:"call_other"},{ordinal:3}])
      expect(() => extractOrcaSessionToolOutput(bytes, JSON.stringify({...original,...patch}))).toThrow();
  });
  it("rejects duplicate outputs/calls/headers, nonmonotonic ordinal and output-before-call", () => {
    const r = rows();
    for (const value of [[...r,{...r[2],ordinal:3}], [r[0],r[1],{...r[1],ordinal:2},{...r[2],ordinal:3}],
      [r[0],{...r[0],ordinal:1}, {...r[1],ordinal:2},{...r[2],ordinal:3}], [r[0],r[1],{...r[2],ordinal:1}],
      [r[0],{...r[2],ordinal:1},{...r[1],ordinal:2}]]) expect(() => extract(encode(value))).toThrow("INVALID_ORCA_SESSION_SOURCE");
  });
  it("rejects ambiguous JSON keys, invalid UTF-8, BOM, blank lines and incomplete final records", () => {
    const bytes=encode(rows()), text=bytes.toString();
    for(const bad of [Buffer.from(text.replace('"ordinal":2','"ordinal":2,"\\u006frdinal":2')),Buffer.concat([bytes,Buffer.from([0xff,10])]),
      Buffer.concat([Buffer.from("\ufeff"),bytes]),Buffer.concat([bytes,Buffer.from("\n")]),bytes.subarray(0,bytes.length-1)])
      expect(()=>extract(bad)).toThrow("INVALID_ORCA_SESSION_SOURCE");
  });
  it("rejects unsupported output format, absent record, wrong session alias and unpaired surrogate", () => {
    const first=rows(); (first[2].payload as any).output={summary:"not original text"};
    const second=rows(); (second[2].payload as any).type="custom_tool_call_output";
    const third=rows(); third[0].payload.session_id="other";
    const fourth=rows(); fourth[2].payload.output="\ud800";
    for(const r of [first,second,third,fourth]) expect(()=>extract(encode(r))).toThrow("INVALID_ORCA_SESSION_SOURCE");
    expect(()=>extract(encode(rows().slice(0,2)))).toThrow("ORCA_SESSION_RECORD_NOT_FOUND");
  });
  it("preserves empty output and accepts CRLF without altering raw line hash",()=>{
    const r=rows();r[2].payload.output="";const bytes=Buffer.from(encode(r).toString().replace(/\n/g,"\r\n"));
    expect(extract(bytes).outputBytes.length).toBe(0);expect(extract(bytes).recordBytes.toString().endsWith("\r\n")).toBe(true);
  });
  it("enforces exact line and selector UTF-8 limits",()=>{
    const r=rows(),prefix=encode(r.slice(0,2)),line=Buffer.from(JSON.stringify(r[2]));
    const exact=Buffer.concat([prefix,line,Buffer.alloc(ORCA_SESSION_LINE_MAX_BYTES-line.length,32),Buffer.from("\n")]);
    expect(extract(exact).ordinal).toBe(2);
    const over=Buffer.concat([prefix,line,Buffer.alloc(ORCA_SESSION_LINE_MAX_BYTES+1-line.length,32),Buffer.from("\n")]);
    expect(()=>extract(over)).toThrow("INVALID_ORCA_SESSION_SOURCE");
    const raw=selector(exact),padded=raw+" ".repeat(4096-Buffer.byteLength(raw));
    expect(extractOrcaSessionToolOutput(exact,padded).ordinal).toBe(2);
    expect(()=>extractOrcaSessionToolOutput(exact,padded+" ")).toThrow("INVALID_ORCA_SESSION_SOURCE");
    expect(()=>extract(Buffer.alloc(ORCA_SESSION_MAX_BYTES+1))).toThrow("INVALID_ORCA_SESSION_SOURCE");
  });
  it("rejects selector extra/duplicate fields and invalid tokens",()=>{
    const bytes=encode(rows()),raw=selector(bytes),value=JSON.parse(raw);
    for(const bad of [JSON.stringify({...value,extra:true}),JSON.stringify({...value,callId:"call_one\n"}),JSON.stringify({...value,ordinal:-1}),
      raw.replace('"ordinal":2','"ordinal":2,"ordinal":2')])expect(()=>extractOrcaSessionToolOutput(bytes,bad)).toThrow("INVALID_ORCA_SESSION_SOURCE");
  });
  it("rejects traversal, symlink file/ancestor/root and hardlink aliases",async()=>{
    const bytes=encode(rows()),file=path.join(root,"session.jsonl");await fs.writeFile(file,bytes);await fs.mkdir(path.join(root,"real"));await fs.writeFile(path.join(root,"real/s.jsonl"),bytes);
    await fs.symlink(file,path.join(root,"link.jsonl"));await fs.symlink(path.join(root,"real"),path.join(root,"alias"));
    for(const name of ["../escape","link.jsonl","alias/s.jsonl","/absolute","./session.jsonl"])
      await expect(readOrcaSessionToolOutput(root,name,selector(bytes))).rejects.toThrow();
    await expect(readOrcaSessionToolOutput(path.join(root,"alias"),"s.jsonl",selector(bytes))).rejects.toThrow();
    await fs.link(file,path.join(root,"hard.jsonl"));await expect(readOrcaSessionToolOutput(root,"hard.jsonl",selector(bytes))).rejects.toThrow();
  });
  it.skipIf(process.platform==="win32")("rejects a FIFO without blocking",async()=>{
    execFileSync("mkfifo",[path.join(root,"pipe")]);await expect(readOrcaSessionToolOutput(root,"pipe",selector(encode(rows())))).rejects.toThrow("INVALID_ORCA_SESSION_SOURCE");
  },1000);
});
