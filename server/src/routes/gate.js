// Public gate API for agencies, CMS plugins and other AI tools. Authenticated with the organisation's API key.
//   POST /api/gate/review  -> review content before delivering it
//   POST /api/gate/verify  -> check that content is exactly what was approved
const express = require('express');
const db = require('../db');
const { wrap, httpError, limiter } = require('../middleware/auth');
const items = require('../services/items');
const cert = require('../services/certificate');

const router = express.Router();

const apiAuth = wrap(async (req, res, next) => {
  const key = req.headers['x-api-key'];
  const org = typeof key === 'string' && key ? await db.findOne('orgs', { api_key: key }) : null;
  if (!org) return res.status(401).json({ error: 'Missing or invalid x-api-key.' });
  req.org = { id: org.id, name: org.name };
  next();
});
router.use(limiter(60 * 1000, 60, 'Gate API rate limit reached (60 requests per minute).'), apiAuth);

router.post('/review', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.text || !b.title) throw httpError(400, 'title and text are required.');
  if (String(b.text).length > 200000) throw httpError(400, 'Content is too long (200,000 characters max).');
  const owner = await db.findOne('users', { org_id: req.org.id, role: 'admin' }, { sort: { id: 1 } });
  const item = await items.createItem({
    orgId: req.org.id, user: owner, title: String(b.title).slice(0, 200), channel: b.channel || 'web', kind: ['text', 'markdown', 'html'].includes(b.kind) ? b.kind : 'text',
    intent: String(b.intent || 'Submitted via the gate API'), body: String(b.text), ai_generated: !!b.ai_generated, ai_tool: b.ai_tool || null, source: 'api',
  });
  const rows = await db.find('findings', { item_id: item.id, version_n: 1 }, { sort: { id: 1 } });
  const findings = rows.map((f) => ({ id: f.id, rule: f.rule, category: f.category, severity: f.severity, matched: f.matched, message: f.message, source_code: f.source_code, suggestions: db.json(f.suggestions, []), advisory: !!f.advisory }));
  res.status(201).json({ item_id: item.id, risk: item.risk, status: item.status, findings, next: 'A human reviewer must approve this item before a clearance certificate is issued.' });
}));

router.post('/verify', wrap(async (req, res) => {
  const { text, hash, item_id } = req.body || {};
  if (typeof text !== 'string' && typeof hash !== 'string') throw httpError(400, 'Send the exact text (or its sha256 hash) you intend to publish.');
  res.json(await cert.verify(req.org.id, { text, hash, itemId: item_id }));
}));

module.exports = router;
