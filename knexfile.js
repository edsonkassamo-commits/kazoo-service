require('dotenv').config();

module.exports = {
  development: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    migrations: { directory: './migrations' },
    seeds:      { directory: './seeds' },
  },
  production: {
    client: 'pg',
    connection: { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } },
    migrations: { directory: './migrations' },
    seeds:      { directory: './seeds' },
    pool: { min: 2, max: 10 },
  },
};
