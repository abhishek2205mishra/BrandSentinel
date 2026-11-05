// Clearance Certificate: an HMAC signature over (org, item, version, content hash).
// A CMS, agency or AI tool can call /api/gate/verify and refuse to publish anything that does not match.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { sha256 } = require('../util/text');

const sign = (orgId, itemId, versionN, hash) =>
  crypto.createHmac('sha256', config.certSecret).update(`${orgId}:${itemId}:${versionN}:${hash}`).digest('hex');

async function issue(orgId, itemId, versionN, hash, userId) {
  const existing = await db.findOne('certificates', { item_id: itemId, version_n: versionN, revoked: 0 });
  if (existing) return existing;
  const signature = sign(orgId, itemId, versionN, hash);
  const id = await db.insert('certificates', { org_id: orgId, item_id: itemId, version_n: versionN, content_hash: hash, signature, issued_by: userId, issued_at: db.now(), revoked: 0 });
  return db.get('certificates', id);
}

// Verify that `text` is exactly the content that was approved.
async function verify(orgId, { text, hash, itemId }) {
  const h = typeof hash === 'string' && hash ? hash : sha256(text || '');
  const certs = await db.find('certificates', { org_id: orgId, content_hash: h, revoked: 0 }, { sort: { id: -1 } });
  for (const c of certs) {
    if (itemId && c.item_id !== Number(itemId)) continue;
    if (sign(orgId, c.item_id, c.version_n, c.content_hash) === c.signature) {
      return { valid: true, content_hash: h, certificate: { id: c.id, item_id: c.item_id, version: c.version_n, issued_at: c.issued_at } };
    }
  }
  let reason = 'No clearance certificate exists for this exact content.';
  if (itemId && await db.findOne('certificates', { org_id: orgId, item_id: Number(itemId), revoked: 0 })) {
    reason = 'This content differs from the approved version. It was changed after approval and must be reviewed again.';
  }
  return { valid: false, content_hash: h, reason };
}

module.exports = { issue, verify, sign };
