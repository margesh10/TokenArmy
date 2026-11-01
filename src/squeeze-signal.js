'use strict';
// Lines matching SIGNAL are never dropped by any TokenArmy filter.
const SIGNAL = /\b(error|errors|err!|fail(s|ed|ure|ures|ing)?|fatal|panic(ked)?|exception|traceback|warn(ing|ings)?|denied|refused|not found|undefined|cannot|can't|unable|invalid|missing|segfault|timeout|timed out|assert(ion)?|expected|received|conflict|abort(ed)?)\b|^\s*[EF]\d{3,}\b|✗|✘|✕|❌/i;
module.exports = { SIGNAL };
