// DO NOT EDIT — test harness. `node test.js`. Exit 0 = all pass.
// Each function is checked independently. The script reports per-function
// pass/fail and exits 0 only when ALL functions pass. The bench driver also
// uses this output to compute "unique functions completed".
const tasks = [
  {
    fn: 'camelToKebab',
    file: './camel-to-kebab.js',
    cases: [
      ['camelCase', 'camel-case'],
      ['HTTPRequest', 'http-request'],
      ['simple', 'simple'],
    ],
  },
  {
    fn: 'kebabToCamel',
    file: './kebab-to-camel.js',
    cases: [
      ['kebab-case', 'kebabCase'],
      ['http-request', 'httpRequest'],
      ['simple', 'simple'],
    ],
  },
  {
    fn: 'snakeToCamel',
    file: './snake-to-camel.js',
    cases: [
      ['snake_case', 'snakeCase'],
      ['hello_world_now', 'helloWorldNow'],
      ['simple', 'simple'],
    ],
  },
  {
    fn: 'camelToSnake',
    file: './camel-to-snake.js',
    cases: [
      ['camelCase', 'camel_case'],
      ['helloWorld', 'hello_world'],
      ['simple', 'simple'],
    ],
  },
  {
    fn: 'titleCase',
    file: './title-case.js',
    cases: [
      ['hello world', 'Hello World'],
      ['the quick brown fox', 'The Quick Brown Fox'],
      ['a', 'A'],
    ],
  },
  {
    fn: 'reverseString',
    file: './reverse.js',
    cases: [
      ['hello', 'olleh'],
      ['', ''],
      ['a', 'a'],
    ],
  },
];

let totalFailed = 0;
const passedFns = [];
for (const t of tasks) {
  let fnPassed = true;
  let fnRef;
  try {
    fnRef = require(t.file)[t.fn];
    if (typeof fnRef !== 'function') throw new Error('not a function');
  } catch (e) {
    console.error(`${t.fn}: LOAD ERROR ${e.message}`);
    totalFailed++;
    continue;
  }
  for (const [input, want] of t.cases) {
    let got;
    try {
      got = fnRef(input);
    } catch (e) {
      console.error(`${t.fn} THROW ${JSON.stringify(input)}: ${e.message}`);
      totalFailed++;
      fnPassed = false;
      continue;
    }
    if (got !== want) {
      console.error(
        `${t.fn} FAIL ${JSON.stringify(input)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
      );
      totalFailed++;
      fnPassed = false;
    }
  }
  if (fnPassed) passedFns.push(t.fn);
}

// Machine-parseable summary line for the driver.
console.log(`PASSED_FNS=${passedFns.join(',')}`);
console.log(`PASSED=${passedFns.length}/${tasks.length}`);
if (totalFailed) process.exit(1);
