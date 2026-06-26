/**
 * @glance/core — team model (a top-tier / "Elite" feature).
 *
 * Roles + permission logic for multi-seat tenants (agencies, teams). Pure and
 * unit-tested; the server persists the member list and enforces the seat limit from
 * the plan. Per-member login (mapping a member to a signed token) is the remaining
 * piece — see docs/INTEGRATIONS.md.
 */
export type TeamRole = 'owner' | 'admin' | 'member';

export interface TeamMember {
  id: string;
  email: string;
  role: TeamRole;
  status: 'active' | 'invited';
  invitedAt: number;
}

const RANK: Record<TeamRole, number> = { member: 1, admin: 2, owner: 3 };

export function roleRank(role: TeamRole): number {
  return RANK[role];
}

export function isTeamRole(value: string): value is TeamRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

/**
 * Can an `actor` manage (invite/remove) a member at `target` role? Admins and owners
 * can manage roles strictly below their own; nobody can manage a peer or a superior.
 */
export function canManage(actor: TeamRole, target: TeamRole): boolean {
  return RANK[actor] >= RANK.admin && RANK[actor] > RANK[target];
}
