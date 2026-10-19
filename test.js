import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { readJson, readJsonSync, writeFileAtomic, writeFileAtomicSync, writeJsonAtomic } from "./src/index.js";

const dir = mkdtempSync(join(tmpdir(), "atomic-file-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("writes a new file and replaces an existing one", async () => {
  const file = join(dir, "a.txt");
  await writeFileAtomic(file, "one");
  assert.equal(readFileSync(file, "utf8"), "one");
  await writeFileAtomic(file, new TextEncoder().encode("twee ✓"));
  assert.equal(readFileSync(file, "utf8"), "twee ✓");
});

test("leaves no temporary files behind", async () => {
  const sub = join(dir, "clean");
  mkdirSync(sub);
  await writeFileAtomic(join(sub, "x"), "1");
  writeFileAtomicSync(join(sub, "x"), "2");
  assert.deepEqual(readdirSync(sub), ["x"]);
});

test("a failing write leaves the old file untouched and cleans up", async () => {
  const sub = join(dir, "fail");
  mkdirSync(sub);
  const file = join(sub, "keep.txt");
  await writeFileAtomic(file, "old");
  await assert.rejects(writeFileAtomic(file, 12345));
  await assert.rejects(writeFileAtomic(join(sub, "no-such-dir", "x"), "data"));
  assert.equal(readFileSync(file, "utf8"), "old");
  assert.deepEqual(readdirSync(sub), ["keep.txt"]);
});

test("the old file is replaced in one step: readers never see half a file", async () => {
  const file = join(dir, "big.txt");
  const a = "A".repeat(200_000);
  const b = "B".repeat(200_000);
  await writeFileAtomic(file, a);
  let torn = 0;
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      const text = readFileSync(file, "utf8");
      if (text !== a && text !== b) torn++;
      await new Promise((r) => setImmediate(r));
    }
  })();
  for (let i = 0; i < 30; i++) await writeFileAtomic(file, i % 2 ? a : b, { fsync: false });
  stop = true;
  await reader;
  assert.equal(torn, 0);
});

test("permissions of the existing file are kept, and mode can be set", { skip: process.platform === "win32" }, async () => {
  const file = join(dir, "secret.txt");
  writeFileSync(file, "x");
  chmodSync(file, 0o600);
  await writeFileAtomic(file, "y");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await writeFileAtomic(file, "z", { mode: 0o640 });
  assert.equal(statSync(file).mode & 0o777, 0o640);
});

test("json: written with a newline, read back, and corrupt files are not mistaken for missing ones", async () => {
  const file = join(dir, "state.json");
  await writeJsonAtomic(file, { a: 1, b: [1, 2] });
  assert.equal(readFileSync(file, "utf8"), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n');
  assert.deepEqual(await readJson(file), { a: 1, b: [1, 2] });
  assert.deepEqual(readJsonSync(file), { a: 1, b: [1, 2] });
  await writeJsonAtomic(file, { a: 1 }, { space: 0 });
  assert.equal(readFileSync(file, "utf8"), '{"a":1}\n');
  assert.deepEqual(await readJson(join(dir, "missing.json"), { fallback: { empty: true } }), { empty: true });
  assert.deepEqual(readJsonSync(join(dir, "missing.json"), { fallback: null }), null);
  await assert.rejects(readJson(join(dir, "missing.json")), { code: "ENOENT" });
  writeFileSync(file, "{broken");
  await assert.rejects(readJson(file, { fallback: {} }), (e) => e instanceof SyntaxError && e.message.includes(file));
  assert.throws(() => readJsonSync(file, { fallback: {} }), SyntaxError);
  await assert.rejects(writeJsonAtomic(file, undefined), TypeError);
});

test("the synchronous version works too", () => {
  const file = join(dir, "sync.txt");
  writeFileAtomicSync(file, "sync");
  assert.equal(readFileSync(file, "utf8"), "sync");
  assert.throws(() => writeFileAtomicSync(file, 5), TypeError);
  assert.equal(existsSync(file), true);
});

const posix = process.platform === "win32" ? { skip: "POSIX permissions and symlinks" } : {};

test("kept and requested permissions are exact, whatever the umask", posix, async () => {
  const before = process.umask(0o022);
  try {
    const file = join(dir, "mode.txt");
    writeFileSync(file, "x");
    chmodSync(file, 0o664);
    await writeFileAtomic(file, "y");
    assert.equal(statSync(file).mode & 0o7777, 0o664);
    writeFileAtomicSync(file, "z");
    assert.equal(statSync(file).mode & 0o7777, 0o664);
    const fresh = join(dir, "mode-new.txt");
    await writeFileAtomic(fresh, "y", { mode: 0o666 });
    assert.equal(statSync(fresh).mode & 0o7777, 0o666);
    const fresh2 = join(dir, "mode-new2.txt");
    writeFileAtomicSync(fresh2, "y", { mode: 0o660 });
    assert.equal(statSync(fresh2).mode & 0o7777, 0o660);
  } finally {
    process.umask(before);
  }
});

test("a symbolic link stays a link: the file it points to is replaced", posix, async () => {
  const real = join(dir, "real.txt");
  const link = join(dir, "link.txt");
  writeFileSync(real, "old");
  symlinkSync("real.txt", link);
  await writeFileAtomic(link, "new");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(real, "utf8"), "new");
  writeFileAtomicSync(link, "newer");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(real, "utf8"), "newer");
});

test("a very long file name still works (the temporary name is shortened)", async () => {
  const file = join(dir, "n".repeat(240));
  await writeFileAtomic(file, "long");
  writeFileAtomicSync(file, "longer");
  assert.equal(readFileSync(file, "utf8"), "longer");
});

test("readJson ignores a byte order mark", async () => {
  const file = join(dir, "bom.json");
  writeFileSync(file, "﻿{\"a\":1}");
  assert.deepEqual(await readJson(file), { a: 1 });
  assert.deepEqual(readJsonSync(file), { a: 1 });
});

test("a process killed in the middle of writing never leaves a mixed file", async () => {
  const file = join(dir, "crash.bin");
  const SIZE = 4 * 1024 * 1024;
  writeFileSync(file, Buffer.alloc(SIZE, 0));
  const child = `
    import { writeFileAtomicSync } from ${JSON.stringify(new URL("./src/index.js", import.meta.url).href)};
    for (let i = 1; ; i++) writeFileAtomicSync(process.argv[1], Buffer.alloc(${SIZE}, i % 250 + 1), { fsync: false });`;
  for (let round = 0; round < 6; round++) {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", child, file], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 60 + round * 25));
    proc.kill("SIGKILL");
    await new Promise((r) => proc.on("close", r));
    const bytes = readFileSync(file);
    assert.equal(bytes.length, SIZE, "the file is complete");
    assert.ok(bytes.every((b) => b === bytes[0]), "the file holds one version, not a mix");
  }
  for (const name of readdirSync(dir)) if (name.startsWith(".crash.bin.")) rmSync(join(dir, name));
});
