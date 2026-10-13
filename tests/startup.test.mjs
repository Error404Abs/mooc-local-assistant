import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

test('actual service startup binds loopback, generates pairing code, and does not print key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mooc-startup-'));
  const portPicker = http.createServer(); await new Promise(ok => portPicker.listen(0, '127.0.0.1', ok));
  const port = portPicker.address().port; await new Promise(ok => portPicker.close(ok));
  await copyFile(fileURLToPath(new URL('../server.mjs', import.meta.url)), join(dir, 'server.mjs'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ port }));
  const child = spawn(process.execPath, [join(dir, 'server.mjs')], { windowsHide: true,
    env: { ...process.env, MOFLUX_API_KEY: 'startup-fake-key-not-for-production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise(ok => child.once('exit', ok)); }
    await rm(dir, { recursive: true, force: true });
  });
  let output = '';
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('service startup timeout')), 5000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('本机服务已启动')) { clearTimeout(timer); ok(); } });
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.stderr.on('data', chunk => { clearTimeout(timer); fail(new Error(String(chunk))); });
  });
  assert.ok(output.includes(`127.0.0.1:${port}`)); assert.ok(!output.includes('startup-fake-key'));
  const token = (await readFile(join(dir, 'local-data', 'pairing-code.txt'), 'utf8')).trim();
  assert.match(token, /^[a-f0-9]{48}$/);
  const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'X-MOOC-Token': token } });
  assert.equal(response.status, 200); assert.equal((await response.json()).ready, true);
});
