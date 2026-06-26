import { describe, it, expect } from 'vitest';
import { canManage, isTeamRole, roleRank } from '../src/team';

describe('team roles', () => {
  it('ranks roles owner > admin > member', () => {
    expect(roleRank('owner')).toBeGreaterThan(roleRank('admin'));
    expect(roleRank('admin')).toBeGreaterThan(roleRank('member'));
  });

  it('validates role strings', () => {
    expect(isTeamRole('admin')).toBe(true);
    expect(isTeamRole('root')).toBe(false);
  });

  it('lets admins and owners manage strictly-lower roles only', () => {
    expect(canManage('owner', 'admin')).toBe(true);
    expect(canManage('owner', 'member')).toBe(true);
    expect(canManage('admin', 'member')).toBe(true);
    expect(canManage('admin', 'admin')).toBe(false); // no peer management
    expect(canManage('admin', 'owner')).toBe(false);
    expect(canManage('member', 'member')).toBe(false); // members can't manage
  });
});
