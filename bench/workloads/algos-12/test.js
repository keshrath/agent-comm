/* eslint-disable */
// DO NOT EDIT — test harness for the algos-12 workload. `node test.js`. Exit
// 0 only when ALL functions pass. Emits PASSED_FNS=fn1,fn2,... for the bench.

const tasks = [
  {
    fn: 'parseRow',
    file: './csv-parse.js',
    cases: [
      [['a,b,c'], ['a', 'b', 'c']],
      [['"a,b",c'], ['a,b', 'c']],
      [['"he said ""hi"""'], ['he said "hi"']],
      [['a,,b'], ['a', '', 'b']],
      [[''], ['']],
      [['"x","y","z"'], ['x', 'y', 'z']],
    ],
    eq: (a, b) =>
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => v === b[i]),
  },
  {
    fn: 'formatNumber',
    file: './format-number.js',
    cases: [
      [[1234567.891, 2, ','], '1,234,567.89'],
      [[0, 0, ','], '0'],
      [[-1234.5, 0, '.'], '-1.235'],
      [[999, 2, ','], '999.00'],
      [[1000, 0, ','], '1,000'],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'wordWrap',
    file: './word-wrap.js',
    cases: [
      [['the quick brown fox', 10], 'the quick\nbrown fox'],
      [['hello world', 5], 'hello\nworld'],
      [['supercalifragilistic is long', 5], 'supercalifragilistic\nis\nlong'],
      [['', 10], ''],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'toRoman',
    file: './roman.js',
    cases: [
      [[1], 'I'],
      [[4], 'IV'],
      [[9], 'IX'],
      [[58], 'LVIII'],
      [[1994], 'MCMXCIV'],
      [[3999], 'MMMCMXCIX'],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'longestCommonSubstring',
    file: './lcs.js',
    cases: [
      [['abcdef', 'zcdez'], 'cde'],
      [['hello', 'world'], 'l'],
      [['abc', 'def'], ''],
      [['abcabc', 'cabcab'], 'abcab'],
      [['', 'abc'], ''],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'isValidEmail',
    file: './email-validate.js',
    cases: [
      [['a@b.co'], true],
      [['user.name+tag@x.io'], true],
      [['a@b'], false],
      [['.a@b.co'], false],
      [['a..b@c.co'], false],
      [['a@-b.co'], false],
      [['a@b.c1'], false],
      [[''], false],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'base64Encode',
    file: './base64-encode.js',
    cases: [
      [[''], ''],
      [['f'], 'Zg=='],
      [['foo'], 'Zm9v'],
      [['Hello, World!'], 'SGVsbG8sIFdvcmxkIQ=='],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'base64Decode',
    file: './base64-decode.js',
    cases: [
      [[''], ''],
      [['Zg=='], 'f'],
      [['Zm9v'], 'foo'],
      [['SGVsbG8sIFdvcmxkIQ=='], 'Hello, World!'],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'isBalanced',
    file: './balanced-parens.js',
    cases: [
      [[''], true],
      [['()'], true],
      [['()[]{}'], true],
      [['([{}])'], true],
      [['(]'], false],
      [['([)]'], false],
      [['a(b[c]d)e'], true],
      [['((('], false],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'runLengthEncode',
    file: './runlen-encode.js',
    cases: [
      [[''], ''],
      [['a'], '1a'],
      [['aaabbc'], '3a2b1c'],
      [['aabbccdde'], '2a2b2c2d1e'],
      [['AAaa'], '2A2a'],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'fromRoman',
    file: './roman-from.js',
    cases: [
      [['I'], 1],
      [['IV'], 4],
      [['IX'], 9],
      [['LVIII'], 58],
      [['MCMXCIV'], 1994],
      [['MMMCMXCIX'], 3999],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'flatten',
    file: './flatten.js',
    cases: [
      [[[]], []],
      [[[1, 2, 3]], [1, 2, 3]],
      [[[1, [2, 3], 4]], [1, 2, 3, 4]],
      [
        [
          [
            [1, 2],
            [3, 4],
          ],
        ],
        [1, 2, 3, 4],
      ],
      [[[[], [1], []]], [1]],
    ],
    eq: (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (Array.isArray(a[i]) || Array.isArray(b[i])) {
          if (!Array.isArray(a[i]) || !Array.isArray(b[i])) return false;
          if (a[i].length !== b[i].length) return false;
          for (let j = 0; j < a[i].length; j++) if (a[i][j] !== b[i][j]) return false;
        } else if (a[i] !== b[i]) return false;
      }
      return true;
    },
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
  for (const [args, want] of t.cases) {
    let got;
    try {
      got = fnRef(...args);
    } catch (e) {
      console.error(`${t.fn} THROW ${JSON.stringify(args)}: ${e.message}`);
      totalFailed++;
      fnPassed = false;
      continue;
    }
    if (!t.eq(got, want)) {
      console.error(
        `${t.fn} FAIL ${JSON.stringify(args)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
      );
      totalFailed++;
      fnPassed = false;
    }
  }
  if (fnPassed) passedFns.push(t.fn);
}

console.log(`PASSED_FNS=${passedFns.join(',')}`);
console.log(`PASSED=${passedFns.length}/${tasks.length}`);
if (totalFailed) process.exit(1);
