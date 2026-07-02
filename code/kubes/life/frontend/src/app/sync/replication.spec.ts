import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';

import { guardAuth } from './replication';

/** Minimal Response stand-in — guardAuth only reads status/redirected/headers. */
function res(over: { status?: number; contentType?: string | null; redirected?: boolean }): Response {
  return {
    status: over.status ?? 200,
    redirected: over.redirected ?? false,
    headers: new Headers(over.contentType === null ? {} : { 'content-type': over.contentType ?? 'application/json' }),
  } as Response;
}

describe('guardAuth — expired-session detection on sync fetches', () => {
  it('lets a healthy JSON response through and leaves the error signal alone', () => {
    const err = signal<string | null>(null);
    expect(() => guardAuth(res({}), err)).not.toThrow();
    expect(err()).toBeNull();
  });

  it('flags 401 and 403 as login-required', () => {
    for (const status of [401, 403]) {
      const err = signal<string | null>(null);
      expect(() => guardAuth(res({ status }), err)).toThrow('auth-required');
      expect(err()).toContain('login required');
    }
  });

  it('flags a followed redirect — the stale-cookie 302→login-page→200 case', () => {
    const err = signal<string | null>(null);
    expect(() => guardAuth(res({ redirected: true, contentType: 'text/html' }), err)).toThrow('auth-required');
    expect(err()).toContain('login required');
  });

  it('flags a non-JSON body even on 200 — HTML where JSON was expected', () => {
    const err = signal<string | null>(null);
    expect(() => guardAuth(res({ contentType: 'text/html' }), err)).toThrow('auth-required');
  });

  it('flags a missing content-type', () => {
    const err = signal<string | null>(null);
    expect(() => guardAuth(res({ contentType: null }), err)).toThrow('auth-required');
  });

  it('does NOT flag a JSON error status like 500 — that is a plain retry, not auth', () => {
    const err = signal<string | null>(null);
    expect(() => guardAuth(res({ status: 500 }), err)).not.toThrow();
    expect(err()).toBeNull();
  });
});
