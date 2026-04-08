// Tiny in-memory user store. Imported by user.js.
// saveUser stores by id. findUser returns the stored user or null.

const users = new Map();

function saveUser(user) {
  if (!user || !user.id) throw new Error('user requires id');
  users.set(user.id, user);
  return user;
}

function findUser(id) {
  return users.get(id) ?? null;
}

function _reset() {
  users.clear();
}

module.exports = { saveUser, findUser, _reset };
