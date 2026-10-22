import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe,it,expect,beforeEach,afterEach } from "vitest";
import { OrcaEvidenceStore,ORCA_EVIDENCE_MAX_BYTES } from "../../src/integrations/orca-evidence.js";
let root:string,store:OrcaEvidenceStore;
beforeEach(async()=>{root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"orca-evidence-")));store=new OrcaEvidenceStore(root);});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
describe("content addressed evidence (synthetic bytes, actual local storage)",()=>{
  it("preserves exact bytes and deduplicates without replacing",async()=>{
    const value=Buffer.from('  output\n\u4e2d\n');
    const ref=await store.put(value);
    expect(ref.sha256).toBe(createHash('sha256').update(value).digest('hex'));
    expect(await store.read(ref)).toEqual(value);
    const file=path.join(root,'data/orca-evidence-v1',ref.sha256);
    const before=await fs.stat(file);
    expect(await store.put(value)).toEqual(ref);
    expect((await fs.stat(file)).ino).toBe(before.ino);
  });
  it("handles empty bytes and exact limit, rejects one byte over",async()=>{
    for(const value of [Buffer.alloc(0),Buffer.alloc(ORCA_EVIDENCE_MAX_BYTES)]) expect((await store.read(await store.put(value))).equals(value)).toBe(true);
    await expect(store.put(Buffer.alloc(ORCA_EVIDENCE_MAX_BYTES+1))).rejects.toThrow();
  });
  it("fails closed for missing/corrupt data and never repairs existing corruption",async()=>{
    const ref=await store.put(Buffer.from('original'));
    const file=path.join(root,'data/orca-evidence-v1',ref.sha256);
    await fs.writeFile(file,'tampered');
    await expect(store.read(ref)).rejects.toThrow();
    await expect(store.put(Buffer.from('original'))).rejects.toThrow();
    expect(await fs.readFile(file,'utf8')).toBe('tampered');
    await fs.unlink(file);
    await expect(store.read(ref)).rejects.toThrow();
  });
  it.each([{version:1,sha256:'../escape',bytes:1},{version:1,sha256:'a'.repeat(64),bytes:-1},
    {version:1,sha256:'a'.repeat(64),bytes:0,extra:true}])("rejects malformed ref %#",async ref=>{
    await expect(store.read(ref as any)).rejects.toThrow();
  });
  it("rejects symlinked artifact and directory without reading targets",async()=>{
    const ref=await store.put(Buffer.from('evidence'));
    const dir=path.join(root,'data/orca-evidence-v1'),file=path.join(dir,ref.sha256);
    const target=path.join(root,'outside'); await fs.writeFile(target,'evidence');
    await fs.unlink(file); await fs.symlink(target,file);
    await expect(store.read(ref)).rejects.toThrow();
    await fs.unlink(file); await fs.rmdir(dir); await fs.mkdir(path.join(root,'other'));
    await fs.symlink(path.join(root,'other'),dir);
    await expect(store.put(Buffer.from('evidence'))).rejects.toThrow();
    expect(await fs.readdir(path.join(root,'other'))).toEqual([]);
  });
  it.skipIf(process.platform==='win32')('promptly rejects a pre-existing FIFO on read and duplicate publication',async()=>{
    const ref=await store.put(Buffer.from('fifo evidence'));
    const file=path.join(root,'data/orca-evidence-v1',ref.sha256);
    await fs.unlink(file);execFileSync('mkfifo',[file]);
    await expect(store.read(ref)).rejects.toThrow('INVALID_ORCA_EVIDENCE');
    await expect(store.put(Buffer.from('fifo evidence'))).rejects.toThrow('INVALID_ORCA_EVIDENCE');
    expect((await fs.lstat(file)).isFIFO()).toBe(true);
  },1000);
});
