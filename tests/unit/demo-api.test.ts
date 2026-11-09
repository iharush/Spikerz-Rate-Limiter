import { jest } from '@jest/globals';
import { demoUserToken } from '../../apps/admin-web/src/api.js';

it('requests a demo user token using the admin bearer token and only the subject in the body', async () => {
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ token: 'demo-user-token', expiresIn: 300 })));
  try {
    await expect(demoUserToken('alice', 'admin-session-token')).resolves.toBe('demo-user-token');
    expect(fetch).toHaveBeenCalledWith('/auth/demo-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer admin-session-token',
      },
      body: JSON.stringify({ subject: 'alice' }),
    });
  } finally {
    fetch.mockRestore();
  }
});
