// Seed activity through the real authenticated API, so the demo exercises every
// plane. Existing observed users are skipped to keep repeat runs predictable.
const origin = process.env.DEMO_ORIGIN ?? 'http://localhost:8080';
const password = process.env.DEMO_PASSWORD;
if (!password) throw new Error('Set DEMO_PASSWORD in .env or the environment before seeding');
async function token(subject, adminToken) {
  const response = await fetch(`${origin}/auth/${adminToken ? 'demo-token' : 'token'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
    },
    body: JSON.stringify(adminToken ? { subject } : { subject, password }),
  });
  if (!response.ok) throw new Error(`Demo login failed (${response.status})`);
  return (await response.json()).token;
}
const admin = await token('admin');
const snapshotResponse = await fetch(`${origin}/management/users?limit=500`, {
  headers: { authorization: `Bearer ${admin}` },
});
if (!snapshotResponse.ok) throw new Error(`Cannot load users (${snapshotResponse.status})`);
const snapshot = await snapshotResponse.json();
for (const [subject, count] of [
  ['alice', 18],
  ['bob', 94],
  ['charlie', 103],
]) {
  if (snapshot.users.some((user) => user.userId === JSON.stringify(['spikerz-demo', subject]))) {
    console.log(`${subject}: already observed; skipped`);
    continue;
  }
  const bearer = await token(subject, admin);
  let admitted = 0;
  let denied = 0;
  for (let offset = 0; offset < count; offset += 20) {
    const responses = await Promise.all(
      Array.from({ length: Math.min(20, count - offset) }, () =>
        fetch(`${origin}/data/demo`, { headers: { authorization: `Bearer ${bearer}` } }),
      ),
    );
    for (const response of responses) {
      if (response.ok) admitted++;
      else if (response.status === 429) denied++;
      else throw new Error(`Request failed (${response.status})`);
      if (response.headers.get('x-count') === null) throw new Error('Missing x-count header');
    }
  }
  console.log(`${subject}: ${admitted} admitted, ${denied} throttled`);
}
for (const path of [
  '/data/internal/commands',
  '/management/internal/events',
  '/control/internal/events',
]) {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (response.status !== 404) throw new Error(`Internal route exposed at ${path}`);
}
console.log(`Demo ready at ${origin}; internal endpoints are not publicly routed.`);
