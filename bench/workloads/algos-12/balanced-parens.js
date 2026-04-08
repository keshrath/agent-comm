// Implement isBalanced(s: string): boolean
//
// Check whether the brackets in `s` are balanced and properly nested.
// Bracket pairs: (), [], {}.
//   - Non-bracket characters are ignored.
//   - Empty string is balanced (returns true).
//   - Every opener must be closed by the matching type, in the right order.
//
// Examples:
//   isBalanced('')              -> true
//   isBalanced('()')            -> true
//   isBalanced('()[]{}')        -> true
//   isBalanced('([{}])')        -> true
//   isBalanced('(]')            -> false
//   isBalanced('([)]')          -> false  (interleaved)
//   isBalanced('a(b[c]d)e')     -> true
//   isBalanced('(((')           -> false

function isBalanced(s) {
  throw new Error('TODO');
}

module.exports = { isBalanced };
