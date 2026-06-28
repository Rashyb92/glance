import { describe, it, expect } from 'vitest';
import { AdminAuth } from '../src/admin/admin-auth';

describe('AdminAuth', () => {
  it('resolves per-operator tokens and rejects unknown/missing ones', () => {
    const a = new AdminAuth({ tokens: 'alice:tokA, bob:tokB', token: '' });
    expect(a.enabled).toBe(true);
    expect(a.resolveOperator('Bearer tokA')).toBe('alice');
    expect(a.resolveOperator('Bearer tokB')).toBe('bob');
    expect(a.resolveOperator('Bearer nope')).toBeNull();
    expect(a.resolveOperator('tokA')).toBeNull(); // not a Bearer header
    expect(a.resolveOperator(undefined)).toBeNull();
    expect(a.resolveOperator('Bearer ')).toBeNull();
  });

  it('supports a single shared token as operator "admin"', () => {
    const a = new AdminAuth({ tokens: '', token: 'shared-secret' });
    expect(a.resolveOperator('Bearer shared-secret')).toBe('admin');
    expect(a.resolveOperator('Bearer other')).toBeNull();
  });

  it('is disabled and fails closed when nothing is configured', () => {
    const a = new AdminAuth({ tokens: '', token: '' });
    expect(a.enabled).toBe(false);
    expect(a.resolveOperator('Bearer anything')).toBeNull();
  });

  it('ignores malformed pairs and rejects a token of a different length', () => {
    const a = new AdminAuth({ tokens: 'noColon,:emptyName,name:,good:tok', token: '' });
    expect(a.enabled).toBe(true);
    expect(a.resolveOperator('Bearer tok')).toBe('good');
    expect(a.resolveOperator('Bearer tokX')).toBeNull(); // length differs → constant-time compare fails
  });
});
