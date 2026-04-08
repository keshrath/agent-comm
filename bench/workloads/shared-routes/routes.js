// Shared route registry. Multiple agents will edit this file in parallel.
// Each agent must add ONE route handler below the AGENTS_ADD_ROUTES_HERE
// marker. Existing routes (and other agents' contributions) MUST be preserved.

const routes = [];

function addRoute(method, path, handler) {
  routes.push({ method, path, handler });
}

// AGENTS_ADD_ROUTES_HERE
// (add your route below this line; do not remove other agents' routes)

module.exports = { routes, addRoute };
