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
 async reconnect() {
  try {
   await this.open();
   await this.query('USE ' + Common.settings.database.name);
   Common.addLog('Database reconnected successfully.');
  } catch (err) {
   Common.addLog('Failed to reconnect to the database. Retrying in 5 seconds.', 2);
   setTimeout(() => this.reconnect(), 5000);
  }
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
   const [result] = await this.db.execute(sql, params);
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
}

module.exports = Database;
