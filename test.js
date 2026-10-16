import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
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
