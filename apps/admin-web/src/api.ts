export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => {
    throw new ApiError(`Service unavailable (${response.status})`, response.status);
  });
  if (!response.ok)
    throw new ApiError(
      typeof body.message === 'string' ? body.message : `Request failed (${response.status})`,
      response.status,
    );
  return body;
}
export async function demoToken(subject: string, password: string): Promise<string> {
  return (
    await api<{ token: string }>('/auth/token', '', {
      method: 'POST',
      body: JSON.stringify({ subject, password }),
    })
  ).token;
}

export async function demoUserToken(subject: string, adminToken: string): Promise<string> {
  return (
    await api<{ token: string }>('/auth/demo-token', adminToken, {
      method: 'POST',
      body: JSON.stringify({ subject }),
    })
  ).token;
}
