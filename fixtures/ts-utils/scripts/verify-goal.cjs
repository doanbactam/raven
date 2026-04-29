const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const goal = process.argv[2];
const root = process.cwd();

function exists(rel) { return fs.existsSync(path.join(root, rel)); }
function read(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }

function typecheck() {
  try { execSync("npx tsc --noEmit", { cwd: root, stdio: "pipe" }); }
  catch (err) { assert.fail("tsc --noEmit failed:\n" + err.stderr?.toString()); }
}

function runTests() {
  try { execSync("npm run build && npm test", { cwd: root, stdio: "pipe" }); }
  catch (err) { assert.fail("npm test failed:\n" + err.stderr?.toString()); }
}

if (goal === "objects-jsdoc-tests") {
  assert.ok(exists("src/objects.ts"), "src/objects.ts must exist");
  const body = read("src/objects.ts");
  for (const fn of ["deepClone", "merge", "deepEqual"]) {
    assert.match(body, new RegExp(`/\\*\\*[\\s\\S]*?export function ${fn}`), `${fn} must have JSDoc`);
  }
  typecheck();
  runTests();
} else if (goal === "strings-tests") {
  typecheck();
  runTests();
} else if (goal === "arrays-generics") {
  const body = read("src/arrays.ts");
  assert.match(body, /function chunk</, "chunk must be generic");
  assert.match(body, /function unique</, "unique must be generic");
  typecheck();
  runTests();
} else {
  throw new Error("Unknown goal: " + goal);
}
