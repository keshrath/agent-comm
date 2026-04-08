// User service — exposed createUser/getUser. Imports types.js and db.js.
// Agents may add validation and other behavior here.

const { makeUser } = require('./types.js');
const { saveUser, findUser } = require('./db.js');

function createUser(id, name, email) {
  const user = makeUser(id, name, email);
  return saveUser(user);
}

function getUser(id) {
  return findUser(id);
}

module.exports = { createUser, getUser };
