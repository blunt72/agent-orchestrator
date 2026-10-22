import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env }; delete env.NODE_OPTIONS;
let created = false;
try {
  const args = process.argv.slice(2), root = args[1];
  if (args.length !== 2 || args[0] !== '--output' || !path.isAbsolute(root) || path.resolve(root) !== root ||
      /[\x00-\x1f\x7f]/.test(root) || fs.realpathSync(path.dirname(root)) !== path.dirname(root)) throw Error('INVALID_OUTPUT');
  // Exclusive output: never replace an existing artifact or the installed application.
  fs.mkdirSync(root, { mode: 0o700 }); created = true;
  execFileSync(process.execPath, [path.join(repo, 'node_modules/typescript/bin/tsc'), '--project', path.join(repo, 'tsconfig.json'),
    '--outDir', path.join(root, 'src'), '--declaration', 'false', '--sourceMap', 'false'],
    { cwd: repo, env, stdio: 'pipe', timeout: 120000, maxBuffer: 1048576 });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }), { flag: 'wx' });
  fs.writeFileSync(path.join(root, 'print-completion-entry.mjs'), "import './src/cli/print-completion-entry.js';\n", { flag: 'wx' });
  const dependencyRoot = fs.realpathSync(path.join(repo, 'node_modules'));
  fs.symlinkSync(dependencyRoot, path.join(root, 'node_modules'));
  const files = {}, directories = [];
  function visit(dir) {
    directories.push(dir);
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), s = fs.lstatSync(file);
      if (s.isSymbolicLink() && file === path.join(root, 'node_modules')) continue;
      if (s.isDirectory()) visit(file);
      else {
        if (!s.isFile() || s.nlink !== 1 || s.size > 4194304 || !['.js', '.mjs', '.json'].includes(path.extname(file))) throw Error('UNSAFE_ARTIFACT');
        files[path.relative(root, file)] = sha(fs.readFileSync(file)); fs.chmodSync(file, 0o444);
      }
    }
  }
  visit(root);
  const manifest = { version: 1, purpose: 'FROZEN_PRINT_COMPLETION_RUNTIME', entry: 'print-completion-entry.mjs', files,
    nodeVersion: process.version, nodeExecutable: fs.realpathSync(process.execPath), dependencyRoot };
  const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (raw.length > 262144 || Object.keys(files).length > 2048) throw Error('ARTIFACT_LIMIT');
  fs.writeFileSync(path.join(root, '.print-completion-runtime-v1.json'), raw, { flag: 'wx', mode: 0o444 });
  for (const dir of directories.reverse()) fs.chmodSync(dir, 0o555);
  const probe = JSON.parse(execFileSync(process.execPath, [path.join(root, manifest.entry), 'probe'],
    { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 32768 }));
  if (!probe.ok || probe.report.runtime.digest !== sha(raw)) throw Error('PROBE_FAILED');
  console.log(JSON.stringify({ ok: true, root, runtimeArtifactDigest: sha(raw), implementationDigest: probe.report.implementationDigest,
    nodeExecutable: manifest.nodeExecutable, approvalIssued: false, taskMutated: false, modelInvoked: false,
    dependencyAuthentication: false, residual: 'Existing toolchain and external dependency tree must remain trusted and quiescent.' }));
} catch {
  console.log(JSON.stringify({ ok: false, code: 'PRINT_RUNTIME_BUILD_REJECTED', partialOutputRetained: created, automaticRetry: false }));
  process.exitCode = 1;
}
