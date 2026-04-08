// Implement runLengthEncode(s: string): string
//
// Run-length encoding: replace runs of identical adjacent characters with
// <count><char>. Single characters get count=1.
//   - Empty string returns ''.
//   - Counts are decimal, no padding.
//
// Examples:
//   runLengthEncode('')          -> ''
//   runLengthEncode('a')         -> '1a'
//   runLengthEncode('aaabbc')    -> '3a2b1c'
//   runLengthEncode('aabbccdde') -> '2a2b2c2d1e'
//   runLengthEncode('AAaa')      -> '2A2a'  (case-sensitive)

function runLengthEncode(s) {
  throw new Error('TODO');
}

module.exports = { runLengthEncode };
