const mysql = require('mysql2/promise');
const Common = require('./common.js').Common;

class Database {
 async open() {
  this.db = await mysql.createConnection({
   host: Common.settings.database.host,
   port: Common.settings.database.port,
   user: Common.settings.database.user,
   password: Common.settings.database.password
  });
 }

 close() {
  try {
   this.db.end();
  } catch (ex) {
   Common.addLog(ex, 2);
  }
 }

 async query(sql, params = []) {
  try {
   await this.db.execute('SELECT 1');
  } catch (err) {
   Common.addLog('Database connection lost. Reconnecting ...', 2);
   try {
    await this.open();
    await this.db.execute('USE ' + Common.settings.database.name);
    Common.addLog('Database reconnected successfully.');
   } catch (err) {
    Common.addLog('Failed to reconnect to the database.', 2);
   }
  }
  try {
   const [result] = await this.db.execute(sql, params);
   Common.addLog('Query: ' + sql);
   return result;
  } catch (ex) {
   Common.addLog('Query: ' + sql, 2);
   Common.addLog(ex, 2);
  }
 }

 async tableExists(name) {
  return (await this.query('SHOW TABLES LIKE ?', [name])).length > 0;
 }

 async databaseExists(name) {
  return (await this.query('SHOW DATABASES LIKE ?', [name])).length > 0;
 }

 escapeId(text) {
  return this.db.escapeId(text);
 }

 escape(text) {
  return this.db.escape(text);
 }
}

module.exports = Database;
