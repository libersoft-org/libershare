const crypto = require('crypto');
const Database = require('./database.js');
const { Common, validateEmail, checkDate } = require('./common.js');

class Data {
 constructor() {
  this.db = new Database();
 }

 async dbPrepare() {
  await this.db.open();
  await this.db.query('USE ' + Common.settings.database.name);
  Common.addLog('Database "' + Common.settings.database.name + '" is connected ...');
  this.startConnectionCheck();
 }
 async removeExpiredSessions() {
  // Odstranění sessions, které jsou starší než 1 den
  await this.db.query(`DELETE FROM sessions WHERE last_access < DATE_SUB(NOW(), INTERVAL ${Common.settings.web.session_user_lifetime} SECOND)`);
 }

 async checkConnection() {
  try {
   await this.db.query('SELECT 1');
  } catch (err) {
   Common.addLog('Database connection lost. Trying to reconnect.', 2);
   this.db.reconnect();
  }
 }

 startConnectionCheck() {
  setInterval(() => this.checkConnection(), 60000); // Check every minute
 }

 startSessionCleanup() {
  // Spustí funkci removeExpiredSessions každou hodinu
  setInterval(async () => {
   await this.removeExpiredSessions();
  }, 3600000); // 3600000 ms = 1 hodina
 }

 async dbCreate() {
  await this.db.open();
  await this.db.query('CREATE DATABASE IF NOT EXISTS ' + Common.settings.database.name);
  await this.db.query('USE ' + Common.settings.database.name);
  await this.db.query('CREATE TABLE IF NOT EXISTS admins (id int PRIMARY KEY AUTO_INCREMENT, username varchar(32) NOT NULL UNIQUE, password varchar(255) NOT NULL, created timestamp DEFAULT current_timestamp())');
  await this.db.query('CREATE TABLE IF NOT EXISTS admins_log (id int PRIMARY KEY AUTO_INCREMENT, id_admins int NOT NULL, message text NOT NULL, ip varchar(45) NOT NULL, session varchar(255) NOT NULL, user_agent text NOT NULL, created timestamp DEFAULT current_timestamp(), FOREIGN KEY (id_admins) REFERENCES admins(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS users (id int PRIMARY KEY AUTO_INCREMENT, username varchar(24) NOT NULL UNIQUE, password varchar(255) NOT NULL, email varchar(128) NOT NULL UNIQUE, first_name varchar(64) NOT NULL, last_name varchar(64) NOT NULL, sex bool NOT NULL DEFAULT 1, birthdate date NOT NULL, blocked bool NOT NULL DEFAULT 0, confirmation varchar(128) NOT NULL, reg_ip varchar(45) NOT NULL, reg_session varchar(128) NOT NULL, reg_user_agent varchar(255) NOT NULL, created timestamp DEFAULT current_timestamp())');
  await this.db.query('CREATE TABLE IF NOT EXISTS logins (id int PRIMARY KEY AUTO_INCREMENT, id_users int NULL, ip varchar(45) NOT NULL, session varchar(128) NOT NULL, user_agent varchar(255) NOT NULL, created timestamp DEFAULT current_timestamp(), FOREIGN KEY (id_users) REFERENCES users(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS search (id int PRIMARY KEY AUTO_INCREMENT, phrase varchar(255) NOT NULL, ip varchar(45) NOT NULL, session varchar(255) NOT NULL, user_agent text NOT NULL, created timestamp DEFAULT current_timestamp())');
  await this.db.query('CREATE TABLE IF NOT EXISTS uploads (id int PRIMARY KEY AUTO_INCREMENT, file_name varchar(40) NOT NULL UNIQUE, real_name varchar(255) NOT NULL, size bigint(20) NOT NULL DEFAULT 0, ip varchar(64) NOT NULL, created timestamp DEFAULT current_timestamp(), FULLTEXT (real_name))');
  await this.db.query('CREATE TABLE IF NOT EXISTS uploads_downloads (id int PRIMARY KEY AUTO_INCREMENT, id_uploads int NULL, ip varchar(45) NOT NULL, session varchar(255) NOT NULL, user_agent text NOT NULL, created timestamp DEFAULT current_timestamp(), FOREIGN KEY (id_uploads) REFERENCES uploads(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS categories (id int PRIMARY KEY AUTO_INCREMENT, name varchar(64) NOT NULL UNIQUE, link varchar(64) NOT NULL UNIQUE, image varchar(255) NULL UNIQUE, created timestamp DEFAULT current_timestamp(), FULLTEXT (name))');
  await this.db.query('CREATE TABLE IF NOT EXISTS categories_visits (id int PRIMARY KEY AUTO_INCREMENT, id_categories int NULL, ip varchar(45) NOT NULL, session varchar(255) NOT NULL, user_agent text NOT NULL, created timestamp DEFAULT current_timestamp(), FOREIGN KEY (id_categories) REFERENCES categories(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS products (id int PRIMARY KEY AUTO_INCREMENT, id_categories int NOT NULL, name varchar(255) NOT NULL, link varchar(255) NOT NULL UNIQUE, image varchar(32) NULL UNIQUE, image_sm varchar(32) NULL UNIQUE, adult bool NOT NULL DEFAULT 0, hidden bool NOT NULL DEFAULT 0, created timestamp DEFAULT current_timestamp(), FOREIGN KEY (id_categories) REFERENCES categories(id), FULLTEXT (name))');
  await this.db.query('CREATE TABLE IF NOT EXISTS products_visits (id int NOT NULL AUTO_INCREMENT, id_products int NULL, ip varchar(45) NOT NULL, session varchar(255) NOT NULL, user_agent text NOT NULL, created timestamp DEFAULT current_timestamp(), PRIMARY KEY (id), FOREIGN KEY (id_products) REFERENCES products(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS files (id int PRIMARY KEY AUTO_INCREMENT, id_products int NULL, name varchar(255) NOT NULL UNIQUE, file_name varchar(255) NOT NULL UNIQUE, size bigint(20) NOT NULL DEFAULT 0, ip varchar(64) NULL, created timestamp DEFAULT current_timestamp(), FOREIGN KEY (id_products) REFERENCES products(id), FULLTEXT (file_name))');
  await this.db.query('CREATE TABLE IF NOT EXISTS files_downloads (id int PRIMARY KEY AUTO_INCREMENT, id_files int NULL, ip varchar(45) NOT NULL, session varchar(255) NOT NULL, user_agent text NOT NULL, created timestamp DEFAULT current_timestamp(), FOREIGN KEY (id_files) REFERENCES files(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS files_plays (id int PRIMARY KEY AUTO_INCREMENT, id_files int NULL, ip varchar(45) NOT NULL, session varchar(255) NOT NULL, user_agent text NOT NULL, created timestamp DEFAULT current_timestamp(), FOREIGN KEY (id_files) REFERENCES files(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS files_plays_web (id int PRIMARY KEY AUTO_INCREMENT, id_files int NULL, ip varchar(45) NOT NULL, session varchar(255) NOT NULL, user_agent text NOT NULL, created timestamp DEFAULT current_timestamp(), FOREIGN KEY (id_files) REFERENCES files(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS forum_threads (id int PRIMARY KEY AUTO_INCREMENT, id_users int NULL, topic varchar(128) NOT NULL, body text NOT NULL, created timestamp DEFAULT current_timestamp(), FOREIGN KEY (id_users) REFERENCES users(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS forum_posts (id int PRIMARY KEY AUTO_INCREMENT, id_users int NULL, id_forum_threads int NULL, body text NOT NULL, created timestamp DEFAULT current_timestamp(), FOREIGN KEY (id_users) REFERENCES users(id), FOREIGN KEY (id_forum_threads) REFERENCES forum_threads(id))');
  await this.db.query('INSERT IGNORE INTO admins (username, password) VALUES ("admin", "d033e22ae348aeb5660fc2140aec35850c4da997")');
  await this.db.query('CREATE TABLE IF NOT EXISTS sessions (id int PRIMARY KEY AUTO_INCREMENT, user_id int NOT NULL, session_guid varchar(255) NOT NULL, last_access timestamp DEFAULT current_timestamp(), FOREIGN KEY (user_id) REFERENCES users(id))');
  await this.db.close();
 }

 async getCategories(o = null, d = null, search = null, count = null, offset = null) {
  const query = `
   SELECT
    id,
    name,
    link,
    image,
    (SELECT COUNT(*) FROM products WHERE id_categories = categories.id) AS products_count,
    (SELECT COUNT(*) FROM products WHERE id_categories = categories.id AND hidden = 1) AS products_count_hidden,
    created
   FROM categories
   ${search ? 'WHERE MATCH(name) AGAINST (?) ' : ''}
   ORDER BY ${o ? o : 'created'} ${o && d ? 'DESC' : 'ASC'}, id ${d ? 'DESC' : 'ASC'}
   ${count && offset ? 'LIMIT ? OFFSET ?' : ''}
  `;
  const params = [];
  if (search) params.push(search);
  if (count && offset) params.push(count, offset);
  return await this.db.query(query, params);
 }

 /* TODO: stats for all categories
  (SELECT SUM((SELECT SUM(size) FROM files WHERE id_products = products.id)) FROM products WHERE id_categories = categories.id) AS size,
  (SELECT COUNT(*) FROM categories_visits WHERE id_categories = categories.id) AS visits,
  (SELECT COUNT(DISTINCT session) FROM categories_visits WHERE id_categories = categories.id) AS visits_by_session,
  (SELECT COUNT(DISTINCT ip) FROM categories_visits WHERE id_categories = categories.id) AS visits_by_ip,
 */

 async getCategoryByID(id) {
  return await this.db.query('SELECT id, name, link, image, created FROM categories WHERE id = ?', [id]);
 }

 async getCategoryByLink(link) {
  return await this.db.query('SELECT id, name, link, image, created FROM categories WHERE link = ?', [link]);
 }

 /* TODO: stats for category
    (SELECT COUNT(*) FROM categories_visits WHERE id_categories = categories.id) AS visits,
    (SELECT COUNT(DISTINCT session) FROM categories_visits WHERE id_categories = categories.id) AS visits_by_session,
    (SELECT COUNT(DISTINCT ip) FROM categories_visits WHERE id_categories = categories.id) AS visits_by_ip,
    */

 async getCategoryExists(id) {
  const rows = await this.db.query('SELECT COUNT(*) AS cnt FROM categories WHERE id = ?', [id]);
  return rows[0].cnt == 1;
 }

 async getFiles(id_product, o, d, p, search, count, offset) {
  let query = `
   SELECT
    f.id,
    f.name,
    f.file_name,
    p.id AS products_id,
    p.name AS product_name,
    p.link AS product_link,
    f.size,
    f.ip,
    (SELECT COUNT(*) FROM files_downloads WHERE id_files = f.id) AS downloads,
    (SELECT COUNT(DISTINCT session) FROM files_downloads WHERE id_files = f.id) AS downloads_by_session,
    (SELECT COUNT(DISTINCT ip) FROM files_downloads WHERE id_files = f.id) AS downloads_by_ip,
    (SELECT COUNT(*) FROM files_plays WHERE id_files = f.id) AS plays,
    (SELECT COUNT(DISTINCT session) FROM files_plays WHERE id_files = f.id) AS plays_by_session,
    (SELECT COUNT(DISTINCT ip) FROM files_plays WHERE id_files = f.id) AS plays_by_ip,
    f.created
   FROM files f, products p
   WHERE f.id_products = p.id`;
  query += id_product != '' ? ' AND f.id_products = "' + id_product + '"' : '';
  query += search != null && search != '' ? ' AND MATCH(f.file_name) AGAINST ("' + search + '")' : '';
  query += search == '' ? ' ORDER BY ' + (o != null && o != '' ? o : 'f.created') + ' ' + (d ? 'DESC' : 'ASC') + ', f.id ' + (d ? 'DESC' : 'ASC') : '';
  query += count != null && count != '' ? ' LIMIT ' + count + (offset != null && offset != '' ? ' OFFSET ' + offset : '') : '';
  return await this.db.query(query);
 }

 async getFile() {}

 async getFileByID() {}

 async getForumThreads(o, d, count, offset) {
  let query = `
   SELECT
    t.id,
    t.id_users,
    u.username,
    u.sex,
    t.topic,
    (SELECT COUNT(*) FROM forum_posts WHERE id_forum_threads = t.id) AS posts_count, 
    t.created
   FROM
    forum_threads t, users u
   WHERE u.id = t.id_users
   ORDER BY
    ${o != null && o != '' ? o : 't.created'}
    ${d != null && d != '' ? 'DESC' : 'ASC' + ', id ' + (d ? 'DESC' : 'ASC')}
    ${count != null && count != '' ? 'LIMIT ' + count + (offset != null && offset != '' ? 'OFFSET ' + offset : '') : ''}`;
  return await this.db.query(query);
 }

 async getForumPosts() {}

 async getLogin() {}

 async getProduct(id, hidden) {
  return await this.db.query(
   `
   SELECT
    id,
    id_categories,
    name,
    link,
    image,
    image_sm,
    adult,
    hidden,
    (SELECT COUNT(*) FROM products_visits WHERE id_products = products.id) AS visits,
    (SELECT COUNT(DISTINCT session) FROM products_visits WHERE id_products = products.id) AS visits_by_session,
    (SELECT COUNT(DISTINCT ip) FROM products_visits WHERE id_products = products.id) AS visits_by_ip,
    created
   FROM products
   WHERE id = ? ${!hidden ? 'AND hidden = 0' : ''}`,
   [id]
  );
 }

 async getProductExists(id) {
  const res = await this.db.query('SELECT COUNT(*) AS cnt FROM products WHERE id = ?', [id]);
  return res[0].cnt === 1;
 }

 async getProductsAutoComplete() {}

 async getProductsInfo() {}

 async getProducts(id_category, o, d, h, a, i, search, count, offset) {
  let query = `
        SELECT
            p.id,
            p.name,
            p.link,
            p.image,
            p.image_sm,
            p.id_categories,
            c.name AS category_name,
            c.link AS category_link,
            (SELECT COUNT(*) FROM files WHERE id_products = p.id) AS files,
            p.adult,
            p.hidden,
            p.created
        FROM products p, categories c
        WHERE p.id_categories = c.id
    `;

  let params = [];

  if (h === '1' || h === '2') {
   query += ' AND p.hidden = ?';
   params.push(h === '1' ? '1' : '0');
  }

  if (a === '1' || a === '2') {
   query += ' AND p.adult = ?';
   params.push(a === '1' ? '1' : '0');
  }

  if (i === '1' || i === '2') {
   query += ' AND p.image IS ' + (i === '1' ? 'NOT NULL' : 'NULL');
  }

  if (id_category) {
   query += ' AND p.id_categories = ?';
   params.push(id_category);
  }

  if (search) {
   query += ' AND MATCH(p.name) AGAINST (?)';
   params.push(search);
  }

  if (!search) {
   query += ' ORDER BY ? ' + (d ? 'DESC' : 'ASC') + ', id ' + (d ? 'DESC' : 'ASC');
   params.push(o || 'created');
  }

  if (count) {
   query += ' LIMIT ?' + (offset ? ' OFFSET ?' : '');
   params.push(Number(count));
   if (offset) params.push(Number(offset));
  }

  return await this.db.query(query, params);
 }

 /*
    (SELECT COUNT(*) FROM products_visits WHERE id_products = p.id) AS visits,
    (SELECT COUNT(DISTINCT session) FROM products_visits WHERE id_products = p.id) AS visits_by_session,
    (SELECT COUNT(DISTINCT ip) FROM products_visits WHERE id_products = p.id) AS visits_by_ip,
   */
 async getUpload() {}

 async getUploadByID() {}

 async getUploads(o, d, count, offset, search) {
  var query = `
    SELECT
     id,
     file_name,
     real_name,
     size,
     ip,
     (SELECT COUNT(*) FROM uploads_downloads WHERE id_uploads = uploads.id) AS downloads,
     (SELECT COUNT(DISTINCT session) FROM uploads_downloads WHERE id_uploads = uploads.id) AS downloads_by_session,
     (SELECT COUNT(DISTINCT ip) FROM uploads_downloads WHERE id_uploads = uploads.id) AS downloads_by_ip,
     created
    FROM uploads`;
  query += search != null && search != '' ? ' WHERE MATCH(realname) AGAINST ("' + search + '")' : '';
  query += search == null || search == '' ? ' ORDER BY ' + (o != null && o != '' ? o : 'created') + ' ' + (d ? 'DESC' : 'ASC') + ', id ' + (d ? 'DESC' : 'ASC') : '';
  query += count != null && count != '' ? ' LIMIT ' + count + (offset != null && offset != '' ? ' OFFSET ' + offset : '') : '';
  return await this.db.query(query);
 }

 async getUploadsInfo() {}

 async setCategoryVisit() {}

 async setContact() {}

 async setFileDownload() {}

 async setFilePlay() {}

 async setFileWebPlay() {}

 async setForumPostAdd() {}

 async setForumThreadAdd() {}

 async setProductVisit() {}

 async setRegistration(params) {
  if (!/^[A-Za-z0-9]{3,24}$/.test(params.username)) {
   return { error: 2, message: 'User name must be 3 to 24 characters long and can contain only upper and lower case letters and numbers!' };
  }

  if (!validateEmail(params.email)) {
   return { error: 4, message: 'E-mail is in invalid format!' };
  }

  if (!(params.sex === '0' || params.sex === '1')) {
   return { error: 6, message: 'You have to choose the right sex!' };
  }

  if (!params.month || !params.day || !params.year || !checkDate(params.month, params.day, params.year)) {
   return { error: 7, message: 'The date is in invalid format!' };
  }

  if (params.password.length < 3) {
   return { error: 8, message: 'The minimum password length is 3 characters!' };
  }

  if (params.password !== params.password2) {
   return { error: 9, message: 'Passwords does not match!' };
  }

  if (!params.terms) {
   return { error: 10, message: 'You have to agree with registration terms!' };
  }
  if (!params.ip) params.ip = 'not available';
  if (!params.session) params.session = 'not available';

  // Kontrola podmínek, které vyžadují přístup k databázi
  const usernameExists = await this.db.query('SELECT COUNT(*) AS cnt FROM users WHERE username = ?', [params.username]);
  if (usernameExists[0].cnt > 0) {
   return { error: 3, message: 'User name already exists!' };
  }
  const emailExists = await this.db.query('SELECT COUNT(*) AS cnt FROM users WHERE email = ?', [params.email]);
  if (emailExists[0].cnt > 0) {
   return { error: 5, message: 'Account with the same e-mail already exists!' };
  }

  const hash = crypto.createHash('sha1');
  hash.update(new Date().getTime() + Math.random().toString());
  const confirmation = hash.digest('hex');

  const passwordHash = crypto.createHash('sha1').update(params.password).digest('hex');
  try {
   const result = await this.db.query(
    `
        INSERT INTO users
        (username, password, email, first_name, last_name, sex, birthdate, confirmation, reg_ip, reg_session, reg_user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [params.username, passwordHash, params.email, params.firstname, params.lastname, params.sex, `${params.year}-${params.month}-${params.day}`, confirmation, params.ip, params.session, params.useragent]
   );

   //if (!sendConfirmationEmail(confirmation, params.email, params.username, params.firstname, params.lastname)) {
   //    return { error: 11, message: 'Error while sending confirmation e-mail!' };
   // }
   const userId = result.insertId;
   const res = await this.validateLogin(params);

   if (res.error) return res;
   return { error: 0, data: res.data };
  } catch (error) {
   return { error: 99, message: 'Database error, try later!' };
  }
 }

 async validateLogin(params) {
  // Kontrola existence uživatele a získání jeho hesla z databáze
  const user = await this.db.query('SELECT id, password FROM users WHERE username = ?', [params.username]);
  if (user.length === 0) {
   return { error: '1', message: 'User not found' };
  }

  const storedHashedPassword = user[0].password;
  const inputHashedPassword = crypto.createHash('sha1').update(params.password).digest('hex');

  // Kontrola, zda hash zadaného hesla odpovídá hashi hesla uloženého v databázi
  if (storedHashedPassword !== inputHashedPassword) {
   return { error: '2', message: 'Incorrect password' };
  }

  const userId = user[0].id;
  const timestampHex = Date.now().toString(16);
  const sessionGuid = crypto.randomBytes(16).toString('hex') + timestampHex;

  // Vložení nové session do databáze
  await this.db.query(
   `
        INSERT INTO sessions
        (user_id, session_guid, last_access)
        VALUES (?, ?, ?)`,
   [userId, sessionGuid, new Date()]
  );

  return { data: { username: params.username, sessionguid: sessionGuid } };
 }

 async isValidSession(sessionGuid) {
  // Kontrola existence sessionGuid v databázi
  const session = await this.db.query('SELECT COUNT(*) AS cnt FROM sessions WHERE session_guid = ?', [sessionGuid]);

  if (session[0].cnt === 0) {
   return false; // Session neexistuje
  }
  await this.db.query('UPDATE sessions SET last_access = NOW() WHERE session_guid = ?', [sessionGuid]);

  return true; // Session existuje
 }

 async setRegistrationConfirmation() {}

 async setSearch() {}

 async setUploadDownload() {}

 async setUpload() {}

 async getAdminAdmins() {}

 async getAdminLog() {}

 async getAdminLogins() {}

 async setAdminCategoryDelete() {}

 async setAdminCategoryEdit() {}

 async setAdminCategoryIconDelete() {}

 async setAdminCategoryNew() {}

 async setAdminDiffsDeleteFilesDB() {}

 async setAdminDiffsDeleteFilesFS() {}

 async setAdminDiffsDeleteUploadsDB() {}

 async setAdminDiffsDeleteUploadsFS() {}

 async setAdminFileDelete() {}

 async setAdminFileEdit() {}

 async setAdminLog() {}

 async setAdminProductDelete() {}

 async setAdminProductEdit() {}

 async setAdminProductImageDelete() {}

 async setAdminProductAdd() {}

 async setAdminUploadDelete() {}

 async setAdminUploadEdit() {}

 async setAdminUploadMove() {}
}

module.exports = Data;