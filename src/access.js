'use strict';
// Who may do what. One place, so every route and webhook agrees.
//
//  platform admin  the operator: can open every business, create businesses, move numbers between them
//  owner           runs one business: providers, people, all numbers in it
//  admin           people + number settings in one business
//  member          only the numbers assigned to them (calls, texts, voicemail, own greetings)

function makeAccess(pool) {
  const q = (t, p) => pool.query(t, p);

  // The signed-in user as seen from one business, or null if they have no access to it.
  async function loadUser(userId, tenantId) {
    const u = (await q('SELECT id, email, name, is_platform_admin FROM users WHERE id = $1', [userId])).rows[0];
    if (!u || !tenantId) return null;
    let role = null;
    if (u.is_platform_admin) {
      role = (await q('SELECT 1 FROM tenants WHERE id = $1', [tenantId])).rows[0] ? 'owner' : null;
    } else {
      role = (await q('SELECT role FROM memberships WHERE user_id = $1 AND tenant_id = $2', [userId, tenantId])).rows[0]?.role || null;
    }
    return role ? { ...u, tenant_id: tenantId, role } : null;
  }

  // Businesses this user can switch between.
  async function businessesFor(user) {
    const { rows } = user.is_platform_admin
      ? await q("SELECT id, name, 'owner' AS role FROM tenants ORDER BY created_at")
      : await q(
        `SELECT t.id, t.name, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 ORDER BY m.created_at`, [user.id]);
    return rows;
  }

  const isAdmin = (user) => user && (user.role === 'owner' || user.role === 'admin');

  // null  = every number in the business (owners/admins)
  // [...] = only these number ids (members)
  async function allowedNumberIds(user) {
    if (isAdmin(user)) return null;
    const { rows } = await q(
      `SELECT nm.number_id FROM number_members nm JOIN numbers n ON n.id = nm.number_id
        WHERE nm.user_id = $1 AND n.tenant_id = $2`, [user.id, user.tenant_id]);
    return rows.map((r) => r.number_id);
  }

  // For webhooks: may this user place calls from / manage this number?
  async function canUseNumber(userId, number) {
    const u = await loadUser(userId, number.tenant_id);
    if (!u) return false;
    if (isAdmin(u)) return true;
    return !!(await q('SELECT 1 FROM number_members WHERE number_id = $1 AND user_id = $2', [number.id, userId])).rows[0];
  }

  return { loadUser, businessesFor, isAdmin, allowedNumberIds, canUseNumber };
}

module.exports = { makeAccess };
