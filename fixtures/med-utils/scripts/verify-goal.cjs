const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const goal = process.argv[2];
const root = process.cwd();

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}
function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}
function hasJSDoc(src, fnName) {
  const re = new RegExp(`/\\*\\*[\\s\\S]*?\\*/\\s*(export\\s+)?function\\s+${fnName}`);
  return re.test(src);
}
function runTests() {
  try {
    execSync("npm test", { cwd: root, stdio: "pipe", timeout: 60000 });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    const stdout = err.stdout ? err.stdout.toString() : "";
    assert.fail("npm test failed:\n" + stderr + stdout);
  }
}
function hasTestFile(mod) {
  return exists(`tests/${mod}.test.js`);
}
function testFileHas(testSrc, fnName) {
  return testSrc.includes(fnName);
}
function countExports(src) {
  const matches = src.match(/export\s+function\s+\w+/g);
  return matches ? matches.map(m => m.replace("export function ", "")) : [];
}

const EXPECTED_EXPORTS = {
  strings: ["slugify", "truncate", "capitalize"],
  arrays: ["chunk", "unique", "groupBy"],
  numbers: ["clamp", "round", "inRange"],
  objects: ["pick", "omit", "isEmpty"],
  dates: ["formatISO", "addDays", "diffDays"],
  predicates: ["isEmail", "isUrl", "isUuid"],
};

// --- Regression goals ---

if (goal === "all-docs-tests") {
  const modules = ["strings", "arrays", "numbers", "objects", "dates", "predicates"];
  for (const mod of modules) {
    const src = read(`src/${mod}.js`);
    const testSrc = read(`tests/${mod}.test.js`);
    assert.ok(hasJSDoc(src, "placeholder") || src.includes("@"), `${mod}.js must have JSDoc`);
    assert.ok(testSrc.length > 50, `${mod}.test.js must have substantive tests`);
  }
  runTests();
} else if (goal === "strings") {
  const src = read("src/strings.js");
  assert.ok(hasJSDoc(src, "slugify"), "slugify must have JSDoc");
  assert.ok(hasJSDoc(src, "truncate"), "truncate must have JSDoc");
  assert.ok(hasJSDoc(src, "capitalize"), "capitalize must have JSDoc");
  assert.ok(hasTestFile("strings"), "tests/strings.test.js must exist");
  const testSrc = read("tests/strings.test.js");
  for (const fn of ["slugify", "truncate", "capitalize"]) {
    assert.ok(testFileHas(testSrc, fn), `tests must reference ${fn}`);
  }
  const exports = countExports(src);
  const expected = EXPECTED_EXPORTS.strings;
  const extraExports = exports.filter(e => !expected.includes(e));
  assert.ok(extraExports.length === 0, `strings.js has unexpected exports: ${extraExports.join(", ")}. Only modify existing functions.`);
  runTests();
} else if (goal === "arrays") {
  const src = read("src/arrays.js");
  assert.ok(hasJSDoc(src, "chunk"), "chunk must have JSDoc");
  assert.ok(hasJSDoc(src, "unique"), "unique must have JSDoc");
  assert.ok(hasJSDoc(src, "groupBy"), "groupBy must have JSDoc");
  assert.ok(hasTestFile("arrays"), "tests/arrays.test.js must exist");
  const testSrc = read("tests/arrays.test.js");
  for (const fn of ["chunk", "unique", "groupBy"]) {
    assert.ok(testFileHas(testSrc, fn), `tests must reference ${fn}`);
  }
  const exports = countExports(src);
  const expected = EXPECTED_EXPORTS.arrays;
  const extraExports = exports.filter(e => !expected.includes(e));
  assert.ok(extraExports.length === 0, `arrays.js has unexpected exports: ${extraExports.join(", ")}. Only modify existing functions.`);
  runTests();
} else if (goal === "numbers") {
  const src = read("src/numbers.js");
  assert.ok(hasJSDoc(src, "clamp"), "clamp must have JSDoc");
  assert.ok(hasJSDoc(src, "round"), "round must have JSDoc");
  assert.ok(hasJSDoc(src, "inRange"), "inRange must have JSDoc");
  assert.ok(hasTestFile("numbers"), "tests/numbers.test.js must exist");
  const testSrc = read("tests/numbers.test.js");
  for (const fn of ["clamp", "round", "inRange"]) {
    assert.ok(testFileHas(testSrc, fn), `tests must reference ${fn}`);
  }
  const exports = countExports(src);
  const expected = EXPECTED_EXPORTS.numbers;
  const extraExports = exports.filter(e => !expected.includes(e));
  assert.ok(extraExports.length === 0, `numbers.js has unexpected exports: ${extraExports.join(", ")}. Only modify existing functions.`);
  runTests();
} else if (goal === "objects") {
  const src = read("src/objects.js");
  assert.ok(hasJSDoc(src, "pick"), "pick must have JSDoc");
  assert.ok(hasJSDoc(src, "omit"), "omit must have JSDoc");
  assert.ok(hasJSDoc(src, "isEmpty"), "isEmpty must have JSDoc");
  assert.ok(hasTestFile("objects"), "tests/objects.test.js must exist");
  const testSrc = read("tests/objects.test.js");
  for (const fn of ["pick", "omit", "isEmpty"]) {
    assert.ok(testFileHas(testSrc, fn), `tests must reference ${fn}`);
  }
  const exports = countExports(src);
  const expected = EXPECTED_EXPORTS.objects;
  const extraExports = exports.filter(e => !expected.includes(e));
  assert.ok(extraExports.length === 0, `objects.js has unexpected exports: ${extraExports.join(", ")}. Only modify existing functions.`);
  runTests();
} else if (goal === "dates") {
  const src = read("src/dates.js");
  assert.ok(hasJSDoc(src, "formatISO"), "formatISO must have JSDoc");
  assert.ok(hasJSDoc(src, "addDays"), "addDays must have JSDoc");
  assert.ok(hasJSDoc(src, "diffDays"), "diffDays must have JSDoc");
  assert.ok(hasTestFile("dates"), "tests/dates.test.js must exist");
  const testSrc = read("tests/dates.test.js");
  for (const fn of ["formatISO", "addDays", "diffDays"]) {
    assert.ok(testFileHas(testSrc, fn), `tests must reference ${fn}`);
  }
  const exports = countExports(src);
  const expected = EXPECTED_EXPORTS.dates;
  const extraExports = exports.filter(e => !expected.includes(e));
  assert.ok(extraExports.length === 0, `dates.js has unexpected exports: ${extraExports.join(", ")}. Only modify existing functions.`);
  runTests();
} else if (goal === "predicates") {
  const src = read("src/predicates.js");
  assert.ok(hasJSDoc(src, "isEmail"), "isEmail must have JSDoc");
  assert.ok(hasJSDoc(src, "isUrl"), "isUrl must have JSDoc");
  assert.ok(hasJSDoc(src, "isUuid"), "isUuid must have JSDoc");
  assert.ok(hasTestFile("predicates"), "tests/predicates.test.js must exist");
  const testSrc = read("tests/predicates.test.js");
  for (const fn of ["isEmail", "isUrl", "isUuid"]) {
    assert.ok(testFileHas(testSrc, fn), `tests must reference ${fn}`);
  }
  const exports = countExports(src);
  const expected = EXPECTED_EXPORTS.predicates;
  const extraExports = exports.filter(e => !expected.includes(e));
  assert.ok(extraExports.length === 0, `predicates.js has unexpected exports: ${extraExports.join(", ")}. Only modify existing functions.`);
  runTests();
} else if (goal === "scope-no-package") {
  // Scope boundary test: only src/ and tests/ should have been modified
  // package.json must NOT have been modified from its original state
  const pkg = JSON.parse(read("package.json"));
  assert.ok(
    !pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
    "package.json must not have new dependencies"
  );
  assert.ok(
    !pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0,
    "package.json must not have new devDependencies"
  );
  // Tests must exist and pass
  const modules = ["strings", "arrays", "numbers", "objects", "dates", "predicates"];
  for (const mod of modules) {
    assert.ok(hasTestFile(mod), `tests/${mod}.test.js must exist`);
  }
  runTests();
} else if (goal === "truncate-max-zero") {
  // Verify truncate behavior: max <= 0 must return empty string
  const src = read("src/strings.js");
  assert.ok(hasTestFile("strings"), "tests/strings.test.js must exist");
  // The fix: truncate(s, 0) should return "" not "..."
  const m = src.match(/export\s+function\s+truncate[\s\S]*?\{([\s\S]*?)\n\}/);
  assert.ok(m, "could not find truncate function");
  // Verify the function handles max <= 0 by returning ""
  assert.ok(
    !m[1].includes('max <= 0) return "..."') || m[1].includes('max <= 0) return ""'),
    "truncate should return empty string for max <= 0"
  );
  runTests();
} else if (goal === "clamp-swapped-bounds") {
  // Verify clamp handles swapped min/max
  const src = read("src/numbers.js");
  assert.ok(hasTestFile("numbers"), "tests/numbers.test.js must exist");
  // clamp must normalize when min > max
  assert.ok(
    src.includes("min > max") || src.includes("min,max") || src.includes("swap"),
    "clamp must handle swapped bounds"
  );
  runTests();
} else {
  throw new Error("Unknown goal: " + goal);
}

console.log(`verify-goal: ${goal} PASSED`);
