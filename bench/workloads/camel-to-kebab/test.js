// DO NOT EDIT — test harness. Run with `node test.js`. Exit 0 = pass.
const { camelToKebab } = require('./camel.js');
const { kebabToCamel } = require('./kebab.js');

const camelCases = [
  ['camelCase', 'camel-case'],
  ['PascalCase', 'pascal-case'],
  ['simple', 'simple'],
  ['HTTPRequest', 'http-request'],
  ['', ''],
];
const kebabCases = [
  ['camel-case', 'camelCase'],
  ['pascal-case', 'pascalCase'],
  ['simple', 'simple'],
  ['http-request', 'httpRequest'],
  ['', ''],
];

let failed = 0;
function check(label, fn, cases) {
  for (const [input, want] of cases) {
    let got;
    try {
      got = fn(input);
    } catch (e) {
      console.error(`${label} THROW ${JSON.stringify(input)}: ${e.message}`);
      failed++;
      continue;
    }
    if (got !== want) {
      console.error(
        `${label} FAIL ${JSON.stringify(input)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
      );
      failed++;
    }
  }
}
check('camelToKebab', camelToKebab, camelCases);
check('kebabToCamel', kebabToCamel, kebabCases);

const total = camelCases.length + kebabCases.length;
if (failed) {
  console.error(`${failed}/${total} failed`);
  process.exit(1);
}
console.log(`OK ${total}/${total}`);
