// Review workflow: submit -> risk-tiered approval -> clearance certificate.
//   low    : one reviewer/approver/admin approval
//   medium : one reviewer/approver/admin approval (reviewer must read the findings)
//   high   : two different people, at least one approver/admin (claims, facts and other serious risks)
// Authors can never approve their own work. Approving with unresolved high-severity findings needs a written override reason.
const db = require('../db');
const audit = require('./audit');
const cert = require('./certificate');
const { notify, usersWithRoles } = require('./notify');
const { event } = require('./items');

const REVIEW_ROLES = ['reviewer', 'approver', 'admin'];
const fail = (status, msg, extra) => { const e = new Error(msg); e.status = status; Object.assign(e, extra); return e; };

async function submit(item, user) {
  if (!['draft', 'changes_requested'].includes(item.status)) throw fail(400, `Cannot submit an item that is "${item.status}".`);
  if (user.id !== item.author_id && user.role !== 'admin') throw fail(403, 'Only the author can submit this item.');
  await db.update('items', item.id, { status: 'submitted', updated_at: db.now() });
  await audit.log(item.org_id, user.id, 'item.submit', 'item', item.id, { risk: item.risk, version: item.current_version });
  await notify(item.org_id, await usersWithRoles(item.org_id, REVIEW_ROLES), `"${item.title}" was submitted for review (${item.risk} risk).`, `/items/${item.id}`);
}

async function decide(item, user, { decision, reason, override_reason }) {
  if (!REVIEW_ROLES.includes(user.role)) throw fail(403, 'Your role cannot review content.');
  if (item.status !== 'submitted') throw fail(400, 'This item is not waiting for review.');
  if (user.id === item.author_id) throw fail(403, 'You cannot review your own content.');
  if (!['approve', 'request_changes', 'reject'].includes(decision)) throw fail(400, 'Unknown decision.');
  if (decision !== 'approve' && !(reason || '').trim()) throw fail(400, 'Please explain your decision so the author knows what to do.');

  const n = item.current_version;
  if (decision === 'approve') {
    const openHigh = await db.find('findings', { item_id: item.id, version_n: n, status: 'open', advisory: 0, severity: 'high' });
    if (openHigh.length && !(override_reason || '').trim()) {
      throw fail(409, `${openHigh.length} high-severity finding(s) are still open. Resolve them, or approve with a written override reason.`, { open_high: openHigh.map((f) => f.id) });
    }
    if (await db.findOne('decisions', { item_id: item.id, version_n: n, user_id: user.id, decision: 'approve' })) {
      throw fail(400, 'You have already approved this version.');
    }
    for (const f of openHigh) await event(item, f, 'override', override_reason, user.id);
  }

  await db.insert('decisions', { item_id: item.id, version_n: n, user_id: user.id, decision, reason: reason || null, override_reason: override_reason || null, created_at: db.now() });
  await audit.log(item.org_id, user.id, `decision.${decision}`, 'item', item.id, { version: n, reason, override_reason });

  if (decision === 'request_changes') {
    await db.update('items', item.id, { status: 'changes_requested', updated_at: db.now() });
    await notify(item.org_id, [item.author_id], `Changes requested on "${item.title}": ${reason}`, `/items/${item.id}`);
    return { status: 'changes_requested' };
  }
  if (decision === 'reject') {
    await db.update('items', item.id, { status: 'rejected', updated_at: db.now() });
    await notify(item.org_id, [item.author_id], `"${item.title}" was rejected: ${reason}`, `/items/${item.id}`);
    return { status: 'rejected' };
  }

  const approveRows = await db.find('decisions', { item_id: item.id, version_n: n, decision: 'approve' });
  const roleOf = await db.mapByIds('users', approveRows.map((d) => d.user_id), ['role']);
  const approvals = approveRows.map((d) => ({ user_id: d.user_id, role: (roleOf.get(d.user_id) || {}).role }));
  const distinct = new Set(approvals.map((a) => a.user_id));
  const needed = item.risk === 'high' ? 2 : 1;
  const hasSenior = approvals.some((a) => ['approver', 'admin'].includes(a.role));
  const satisfied = distinct.size >= needed && (item.risk !== 'high' || hasSenior);

  if (!satisfied) {
    const missing = distinct.size < needed ? `${needed - distinct.size} more approval(s)` : 'an approver or admin sign-off';
    await notify(item.org_id, await usersWithRoles(item.org_id, ['approver', 'admin']), `"${item.title}" needs ${missing}.`, `/items/${item.id}`);
    return { status: 'submitted', waiting_for: missing };
  }

  const version = await db.findOne('versions', { item_id: item.id, n });
  const c = await cert.issue(item.org_id, item.id, n, version.content_hash, user.id);
  await db.update('items', item.id, { status: 'approved', updated_at: db.now() });
  await audit.log(item.org_id, user.id, 'certificate.issue', 'item', item.id, { certificate_id: c.id, version: n });
  await notify(item.org_id, [item.author_id], `"${item.title}" is approved and cleared for publication.`, `/items/${item.id}`);
  return { status: 'approved', certificate: c };
}

module.exports = { submit, decide, REVIEW_ROLES };
