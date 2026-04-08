// Implement flatten(arr: any[]): any[]
//
// Flatten a nested array to a SINGLE level (only one level deep, not fully).
// In other words: any element that is itself an array gets unwrapped one
// level. Arrays nested deeper stay as arrays.
//   - Non-array inputs throw new Error('not an array').
//   - Empty array returns [].
//
// Examples:
//   flatten([])                 -> []
//   flatten([1, 2, 3])          -> [1, 2, 3]
//   flatten([1, [2, 3], 4])     -> [1, 2, 3, 4]
//   flatten([[1, 2], [3, 4]])   -> [1, 2, 3, 4]
//   flatten([1, [2, [3, 4]]])   -> [1, 2, [3, 4]]   // ONE level only
//   flatten([[], [1], []])      -> [1]

function flatten(arr) {
  throw new Error('TODO');
}

module.exports = { flatten };
