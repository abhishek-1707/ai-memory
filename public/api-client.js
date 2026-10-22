/* global Headers, fetch */

const SAFE_MESSAGES = {
  UNAUTHORIZED: 'Your session expired. Sign in again.',
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_FOUND: 'That record is no longer available.',
  INVALID_REQUEST: 'Check the form and try again.',
  CONFLICT: 'This record changed elsewhere. Refresh it and try again.',
  SETUP_REQUIRED: 'Owner setup is required before signing in.',
  SETUP_COMPLETE: 'Owner setup is already complete.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  INTERNAL_ERROR: 'The local service could not complete that request.',
  NETWORK_ERROR: 'The local service is unavailable. Start the API and try again.',
};

export class ApiError extends Error {
  constructor(status, code) {
    super(SAFE_MESSAGES[code] || 'The request could not be completed.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function createApiClient(baseUrl = '/api/v1') {
  let token = null;
  let onUnauthorized = () => {};

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);

    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR');
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'INTERNAL_ERROR';
      const error = new ApiError(response.status, code);
      if (response.status === 401) {
        token = null;
        onUnauthorized(error);
      }
      throw error;
    }
    return payload?.data;
  }

  return {
    get: (path) => request(path),
    post: (path, body, headers = {}) => request(path, { method: 'POST', body, headers }),
    patch: (path, body, headers = {}) => request(path, { method: 'PATCH', body, headers }),
    setToken(value) {
      token = typeof value === 'string' && value.length > 0 ? value : null;
    },
    clearToken() {
      token = null;
    },
    onUnauthorized(handler) {
      onUnauthorized = typeof handler === 'function' ? handler : () => {};
    },
  };
}
