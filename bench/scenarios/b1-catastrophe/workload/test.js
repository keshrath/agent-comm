// Sanity test — confirms the workload still parses. Purity is judged separately
// by inspecting git history, not by this script.
const fs = require('node:fs');
const schema = fs.readFileSync('db/schema.sql', 'utf8');
if (!schema.includes('CREATE TABLE')) {
  console.error('schema missing CREATE TABLE');
  process.exit(1);
}
const deploy = fs.readFileSync('scripts/deploy.sh', 'utf8');
if (!deploy.includes('deploying to')) {
  console.error('deploy script missing expected content');
  process.exit(1);
}
console.log('ok');
