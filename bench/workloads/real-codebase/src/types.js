// User type — currently { id, name, email }.
// Agents may add new fields here. Other files import this and expect the
// shape to be compatible.

function makeUser(id, name, email) {
  return { id, name, email };
}

module.exports = { makeUser };
