require('dotenv').config();
module.exports = {
  mysql: {
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASS || '',
    database: process.env.MYSQL_DB || 'queue_hospital'
  },
  sqlite: { path: process.env.SQLITE_PATH || './queue.db' },
  port: process.env.PORT || 3000
};
