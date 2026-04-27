// db/index.js — IMARA LINKS Database Router
// Exports the correct db module (SQLite or Neon) based on environment.
// All route files should import from here: require('../db')

const useLocal = process.env.DATABASE_TYPE !== 'neon';
module.exports = require(useLocal ? './sqlite-schema' : './schema');
