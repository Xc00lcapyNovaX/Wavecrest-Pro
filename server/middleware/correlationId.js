// server/middleware/correlationId.js
const { randomUUID } = require('crypto');

function correlationId(req, res, next) {
  const id = req.headers['x-request-id'] || randomUUID();
  req.correlationId = id;
  res.set('X-Request-ID', id);
  next();
}

module.exports = correlationId;
