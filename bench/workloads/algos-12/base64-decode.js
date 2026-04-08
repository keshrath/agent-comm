// Implement base64Decode(s: string): string
//
// Decode a standard base64 string back to UTF-8. Inverse of base64Encode.
//   - Accept padded input ('Zg==').
//   - Empty string returns ''.
//   - You may use Buffer.from(s, 'base64').toString('utf8') in Node.
//
// Examples:
//   base64Decode('')                       -> ''
//   base64Decode('Zg==')                   -> 'f'
//   base64Decode('Zm9v')                   -> 'foo'
//   base64Decode('SGVsbG8sIFdvcmxkIQ==')   -> 'Hello, World!'

function base64Decode(s) {
  throw new Error('TODO');
}

module.exports = { base64Decode };
