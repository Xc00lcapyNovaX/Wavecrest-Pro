// Vercel serverless entry point — re-exports the Express app
const app = require('../server/index.js');
module.exports = app;
