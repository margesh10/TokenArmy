'use strict';
// Per-session state for hooks (~/.tokenarmy/sessions/<id>/). Local only, best-effort.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const stats = require('./stats');

const ROOT = path.join(path.dirname(stats.FILE), 'sessions');

function safeId(id) {
  return String(id || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

function dir(sessionId) {
  return path.join(ROOT, safeId(sessionId));
}

function load(sessionId, name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(sessionId), name), 'utf8'));
  } catch {
    return fallback;
  }
}

function save(sessionId, name, value) {
  try {
    fs.mkdirSync(dir(sessionId), { recursive: true });
    fs.writeFileSync(path.join(dir(sessionId), name), JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

function remove(sessionId, name) {
  try {
    fs.unlinkSync(path.join(dir(sessionId), name));
  } catch {
    /* already gone */
  }
}

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

module.exports = { dir, load, save, remove, hash, ROOT };
