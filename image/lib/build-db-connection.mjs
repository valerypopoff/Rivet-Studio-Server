const env = process.env;

function read(name) {
  const value = env[name]?.trim();
  return value ? value : '';
}

const host = read('RIVET_DATABASE_HOST');
const port = read('RIVET_DATABASE_PORT') || '5432';
const database = read('RIVET_DATABASE_NAME');
const username = read('RIVET_DATABASE_USERNAME');
const password = env.RIVET_DATABASE_PASSWORD ?? '';

const hasAnyParts = Boolean(host || database || username || password);
if (!hasAnyParts) {
  process.exit(0);
}

const missing = [
  !host ? 'RIVET_DATABASE_HOST' : null,
  !database ? 'RIVET_DATABASE_NAME' : null,
  !username ? 'RIVET_DATABASE_USERNAME' : null,
  password === '' ? 'RIVET_DATABASE_PASSWORD' : null,
].filter(Boolean);

if (missing.length > 0) {
  console.error(
    `[rivet-image] Cannot build RIVET_DATABASE_CONNECTION_STRING because required part(s) are missing: ${missing.join(', ')}`,
  );
  process.exit(1);
}

const encodedUsername = encodeURIComponent(username);
const encodedPassword = encodeURIComponent(password);
const encodedDatabase = encodeURIComponent(database);
process.stdout.write(`postgresql://${encodedUsername}:${encodedPassword}@${host}:${port}/${encodedDatabase}`);
