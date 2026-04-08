// Implement base64Encode(s: string): string
//
// Encode a UTF-8 string to standard base64 (RFC 4648, with padding).
//   - Use the alphabet A-Z a-z 0-9 + /
//   - Pad with '=' so output length is a multiple of 4.
//   - Empty string returns ''.
//   - You may use Buffer.from(s, 'utf8').toString('base64') in Node.
//
// Examples:
//   base64Encode('')             -> ''
//   base64Encode('f')            -> 'Zg=='
//   base64Encode('foo')          -> 'Zm9v'
//   base64Encode('Hello, World!')-> 'SGVsbG8sIFdvcmxkIQ=='

function base64Encode(s) {
  throw new Error('TODO');
}

module.exports = { base64Encode };
