const crypto = require('crypto');
const Database = require('./database.js');
const { Common } = require('./common.js');

class Data {
 constructor() {
  this.db = new Database();
 }

 async init() {
  await this.db.open();
  await this.db.query('USE ' + Common.settings.database.name);
  Common.addLog('Database "' + Common.settings.database.name + '" is connected ...');
  setInterval(async () => {
   Common.addLog('Deleting old sessions ...');
   await this.db.query('DELETE FROM sessions_users WHERE last < DATE_SUB(NOW(), INTERVAL ' + Common.settings.web.sessions_users + ' SECOND)');
   await this.db.query('DELETE FROM sessions_admins WHERE last < DATE_SUB(NOW(), INTERVAL ' + Common.settings.web.sessions_admins + ' SECOND)'); 
  }, 600000);
 }

 async dbCreate() {
  await this.db.open();
  await this.db.query('CREATE DATABASE IF NOT EXISTS ' + Common.settings.database.name);
  await this.db.query('USE ' + Common.settings.database.name);
  await this.db.query('CREATE TABLE IF NOT EXISTS admins (id INT PRIMARY KEY AUTO_INCREMENT, username VARCHAR(32) NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await this.db.query('CREATE TABLE IF NOT EXISTS admins_log (id INT PRIMARY KEY AUTO_INCREMENT, id_admins INT NOT NULL, message TEXT NOT NULL, ip VARCHAR(45) NOT NULL, session VARCHAR(255) NOT NULL, user_agent TEXT NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_admins) REFERENCES admins(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY AUTO_INCREMENT, username VARCHAR(24) NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, email VARCHAR(128) NOT NULL UNIQUE, first_name VARCHAR(64) NOT NULL, last_name VARCHAR(64) NOT NULL, sex BOOL NOT NULL DEFAULT 1, birthdate date NOT NULL, blocked BOOL NOT NULL DEFAULT 0, confirmation VARCHAR(128) NOT NULL, reg_ip VARCHAR(45) NOT NULL, reg_session VARCHAR(128) NOT NULL, reg_user_agent VARCHAR(255) NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await this.db.query('CREATE TABLE IF NOT EXISTS logins (id INT PRIMARY KEY AUTO_INCREMENT, id_users INT NULL, ip VARCHAR(45) NOT NULL, session VARCHAR(128) NOT NULL, user_agent VARCHAR(255) NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_users) REFERENCES users(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS search (id INT PRIMARY KEY AUTO_INCREMENT, phrase VARCHAR(255) NOT NULL, ip VARCHAR(45) NOT NULL, session VARCHAR(255) NOT NULL, user_agent TEXT NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await this.db.query('CREATE TABLE IF NOT EXISTS uploads (id INT PRIMARY KEY AUTO_INCREMENT, file_name VARCHAR(40) NOT NULL UNIQUE, real_name VARCHAR(255) NOT NULL, size bigINT(20) NOT NULL DEFAULT 0, ip VARCHAR(64) NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FULLTEXT (real_name))');
  await this.db.query('CREATE TABLE IF NOT EXISTS uploads_downloads (id INT PRIMARY KEY AUTO_INCREMENT, id_uploads INT NULL, ip VARCHAR(45) NOT NULL, session VARCHAR(255) NOT NULL, user_agent TEXT NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_uploads) REFERENCES uploads(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS categories (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(64) NOT NULL UNIQUE, link VARCHAR(64) NOT NULL UNIQUE, image VARCHAR(255) NULL UNIQUE, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FULLTEXT (name))');
  await this.db.query('CREATE TABLE IF NOT EXISTS categories_visits (id INT PRIMARY KEY AUTO_INCREMENT, id_categories INT NULL, ip VARCHAR(45) NOT NULL, session VARCHAR(255) NOT NULL, user_agent TEXT NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_categories) REFERENCES categories(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS items (id INT PRIMARY KEY AUTO_INCREMENT, id_categories INT NOT NULL, name VARCHAR(255) NOT NULL, link VARCHAR(255) NOT NULL UNIQUE, image VARCHAR(32) NULL UNIQUE, image_sm VARCHAR(32) NULL UNIQUE, adult BOOL NOT NULL DEFAULT 0, hidden BOOL NOT NULL DEFAULT 0, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_categories) REFERENCES categories(id), FULLTEXT (name))');
  await this.db.query('CREATE TABLE IF NOT EXISTS items_visits (id INT NOT NULL AUTO_INCREMENT, id_items INT NULL, ip VARCHAR(45) NOT NULL, session VARCHAR(255) NOT NULL, user_agent TEXT NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id), FOREIGN KEY (id_items) REFERENCES items(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS files (id INT PRIMARY KEY AUTO_INCREMENT, id_items INT NULL, name VARCHAR(255) NOT NULL UNIQUE, file_name VARCHAR(255) NOT NULL UNIQUE, size bigINT(20) NOT NULL DEFAULT 0, ip VARCHAR(64) NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_items) REFERENCES items(id), FULLTEXT (file_name))');
  await this.db.query('CREATE TABLE IF NOT EXISTS files_downloads (id INT PRIMARY KEY AUTO_INCREMENT, id_files INT NULL, ip VARCHAR(45) NOT NULL, session VARCHAR(255) NOT NULL, user_agent TEXT NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_files) REFERENCES files(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS files_plays (id INT PRIMARY KEY AUTO_INCREMENT, id_files INT NULL, ip VARCHAR(45) NOT NULL, session VARCHAR(255) NOT NULL, user_agent TEXT NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_files) REFERENCES files(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS files_plays_web (id INT PRIMARY KEY AUTO_INCREMENT, id_files INT NULL, ip VARCHAR(45) NOT NULL, session VARCHAR(255) NOT NULL, user_agent TEXT NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_files) REFERENCES files(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS forum_threads (id INT PRIMARY KEY AUTO_INCREMENT, id_users INT NULL, topic VARCHAR(128) NOT NULL, body TEXT NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_users) REFERENCES users(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS forum_posts (id INT PRIMARY KEY AUTO_INCREMENT, id_users INT NULL, id_forum_threads INT NULL, body TEXT NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_users) REFERENCES users(id), FOREIGN KEY (id_forum_threads) REFERENCES forum_threads(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS sessions_users (id INT PRIMARY KEY AUTO_INCREMENT, id_users INT NOT NULL, session VARCHAR(255) NOT NULL, last TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_users) REFERENCES users(id))');
  await this.db.query('CREATE TABLE IF NOT EXISTS sessions_admins (id INT PRIMARY KEY AUTO_INCREMENT, id_admins INT NOT NULL, session VARCHAR(255) NOT NULL, last TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (id_admins) REFERENCES admins(id))');
  await this.db.query('INSERT IGNORE INTO admins (username, password) VALUES ("admin", "d033e22ae348aeb5660fc2140aec35850c4da997")');
  await this.db.close();
 }

 async getCategories(items = null, order = 'created', direction = false, search = null, count = null, offset = null) {
  /* TODO: stats for all categories
   (SELECT SUM((SELECT SUM(size) FROM files WHERE id_items = items.id)) FROM items WHERE id_categories = categories.id) AS size,
   (SELECT COUNT(*) FROM categories_visits WHERE id_categories = categories.id) AS visits,
   (SELECT COUNT(DISTINCT session) FROM categories_visits WHERE id_categories = categories.id) AS visits_by_session,
   (SELECT COUNT(DISTINCT ip) FROM categories_visits WHERE id_categories = categories.id) AS visits_by_ip,
  */
  let query = `
   SELECT
    id,
    name,
    link,
    image,
    (SELECT COUNT(*) FROM items WHERE id_categories = categories.id) AS items_count,
    (SELECT COUNT(*) FROM items WHERE id_categories = categories.id AND hidden = 1) AS items_count_hidden,
    created
   FROM categories
  `;
  const params = [];
  if (search) {
   query += ' WHERE MATCH(name) AGAINST (?)';
   params.push(search);
  }
  if (items === true || items === false) query += ' HAVING items_count - items_count_hidden ' + (items ? '!=' : '=') + ' 0';
  query += ' ORDER BY ' + this.db.escapeId(order);
  query += ' ' + (direction ? 'DESC' : 'ASC');
  query += ', id ' + (direction ? 'DESC' : 'ASC');
  if (count) {
   query += 'LIMIT ?';
   params.push(count);
  }
  if (count && offset) {
   query += ' OFFSET ?';
   params.push(offset);
  }
  return await this.db.query(query, params);
 }

 async getCategoryByID(id) {
  /* TODO: stats for category:
   (SELECT COUNT(*) FROM category_visits WHERE id_category = category.id) AS visits,
   (SELECT COUNT(DISTINCT session) FROM category_visits WHERE id_category = category.id) AS visits_by_session,
   (SELECT COUNT(DISTINCT ip) FROM category_visits WHERE id_category = category.id) AS visits_by_ip
  */
  return await this.db.query(`
   SELECT
    id,
    name,
    link,
    image,
    (SELECT COUNT(*) FROM items WHERE id_categories = categories.id) AS items_count,
    (SELECT COUNT(*) FROM items WHERE id_categories = categories.id AND hidden = 1) AS items_count_hidden,
    created
   FROM categories
   WHERE id = ?`, [id]);
 }

 async getCategoryByLink(link) {
  /* TODO: stats for category:
   (SELECT COUNT(*) FROM category_visits WHERE id_category = category.id) AS visits,
   (SELECT COUNT(DISTINCT session) FROM category_visits WHERE id_category = category.id) AS visits_by_session,
   (SELECT COUNT(DISTINCT ip) FROM category_visits WHERE id_category = category.id) AS visits_by_ip
  */
  return await this.db.query(`
   SELECT
    id,
    name,
    link,
    image,
    (SELECT COUNT(*) FROM items WHERE id_categories = categories.id) AS items_count,
    (SELECT COUNT(*) FROM items WHERE id_categories = categories.id AND hidden = 1) AS items_count_hidden,
    created
   FROM categories
   WHERE link = ?`, [link]);
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

 async getDownloadFiles(id_item, order, direction, search, count, offset) {
  let query = `
   SELECT
    f.id,
    f.name,
    f.file_name,
    i.id AS items_id,
    i.name AS item_name,
    i.link AS item_link,
    f.size,
    f.ip,
    (SELECT COUNT(*) FROM files_downloads WHERE id_files = f.id) AS downloads,
    (SELECT COUNT(DISTINCT session) FROM files_downloads WHERE id_files = f.id) AS downloads_by_session,
    (SELECT COUNT(DISTINCT ip) FROM files_downloads WHERE id_files = f.id) AS downloads_by_ip,
    (SELECT COUNT(*) FROM files_plays WHERE id_files = f.id) AS plays,
    (SELECT COUNT(DISTINCT session) FROM files_plays WHERE id_files = f.id) AS plays_by_session,
    (SELECT COUNT(DISTINCT ip) FROM files_plays WHERE id_files = f.id) AS plays_by_ip,
    f.created
   FROM files f, items i
   WHERE f.id_items = i.id`;
  query += id_item != '' ? ' AND f.id_items = "' + id_item + '"' : '';
  query += search != null && search != '' ? ' AND MATCH(f.file_name) AGAINST ("' + search + '")' : '';
  query += search == '' ? ' ORDER BY ' + (order != null && order != '' ? order : 'f.created') + ' ' + (direction ? 'DESC' : 'ASC') + ', f.id ' + (direction ? 'DESC' : 'ASC') : '';
  query += count != null && count != '' ? ' LIMIT ' + count + (offset != null && offset != '' ? ' OFFSET ' + offset : '') : '';
  return await this.db.query(query);
 }

 async getDownloadFile() {}

 async getFileByID() {}

 async getForumThreads(order = 't.created', direction, count, offset) {
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
  `;
  const params = [];
  query += 'ORDER BY ' + this.db.escapeId(order);
  query += ' ' + (direction ? 'DESC' : 'ASC') + ', id ' + (direction ? 'DESC' : 'ASC');
  if (count) {
   query += ' LIMIT ?';
   params.push(count);
  }
  if (count && offset) {
   query += ' OFFSET ?';
   params.push(offset);
  }
  return await this.db.query(query, params);
 }

 async getForumThread(p = {}) {
  return await this.db.query('SELECT t.id, t.id_users, u.username, u.sex, t.topic, t.body, t.created FROM forum_thread t, users u WHERE u.id = t.id_users AND t.id = ?', [p.id]);
 }

 async getForumPosts(p = {}) {
  return await this.db.query('SELECT p.id, p.id_users, u.username, u.sex, p.body, p.created FROM forum_post p, users u WHERE u.id = p.id_users AND p.id_forum_thread = ? ORDER BY p.created ASC', [p.id]);
 }

 async getLogin() {}

 async getItemByID(id, hidden) {
  return await this.db.query(`
   SELECT
    id,
    id_categories,
    name,
    link,
    image,
    image_sm,
    adult,
    hidden,
    (SELECT COUNT(*) FROM items_visits WHERE id_items = items.id) AS visits,
    (SELECT COUNT(DISTINCT session) FROM items_visits WHERE id_items = items.id) AS visits_by_session,
    (SELECT COUNT(DISTINCT ip) FROM items_visits WHERE id_items = items.id) AS visits_by_ip,
    created
   FROM items
   WHERE id = ?${!hidden ? ' AND hidden = 0' : ''}`, [id]
  );
 }

 async getItemByLink(link, hidden) {
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
    (SELECT COUNT(*) FROM items_visits WHERE id_items = items.id) AS visits,
    (SELECT COUNT(DISTINCT session) FROM items_visits WHERE id_items = items.id) AS visits_by_session,
    (SELECT COUNT(DISTINCT ip) FROM items_visits WHERE id_items = items.id) AS visits_by_ip,
    created
   FROM items
   WHERE link = ?${!hidden ? ' AND hidden = 0' : ''}`, [link]
  );
 }

 async getItemExists(id) {
  const res = await this.db.query('SELECT COUNT(*) AS cnt FROM items WHERE id = ?', [id]);
  return res[0].cnt === 1;
 }

 async getItemsAutoComplete(search) {
  await this.db.query('SELECT id, name, link FROM item WHERE name LIKE "%?%" ORDER BY name ASC LIMIT 20', [search]);
 }

 async getItemsInfo() {

 }

 async getItems(id_category, order, direction, hidden, adult, files, image, search, count, offset) {
  let query = `
   SELECT
    i.id,
    i.name,
    i.link,
    i.image,
    i.image_sm,
    i.id_categories,
    c.name AS category_name,
    c.link AS category_link,
    i.adult,
    i.hidden,
    (SELECT COUNT(*) FROM files WHERE id_items = i.id) AS files,
    i.created
   FROM items i, categories c
   WHERE i.id_categories = c.id
  `;
  const params = [];
  if (hidden == true || hidden == false) query += ' AND i.hidden = ' + (hidden ? 1 : 0);
  if (adult == true || adult == false) query += ' AND i.adult = ' + (adult ? 1 : 0);
  if (image == true || image == false) query += ' AND i.image IS ' + (image ? 'NOT NULL' : 'NULL');
  if (id_category) {
   query += ' AND i.id_categories = ?';
   params.push(id_category);
  }
  if (search) {
   query += ' AND MATCH(i.name) AGAINST (?)';
   params.push(search);
  }
  if (files == true || files == false) query += ' HAVING files ' + (files ? '> 0' : '= 0');
  if (!search) {
   query += ' ORDER BY ? ' + (direction ? 'DESC' : 'ASC') + ', id ' + (direction ? 'DESC' : 'ASC');
   params.push(order || 'created');
  }
  if (count) {
   query += ' LIMIT ?' + (offset ? ' OFFSET ?' : '');
   params.push(count);
   if (offset) params.push(offset);
  }
  return await this.db.query(query, params);
 }

 /*
  (SELECT COUNT(*) FROM items_visits WHERE id_items = i.id) AS visits,
  (SELECT COUNT(DISTINCT session) FROM items_visits WHERE id_items = i.id) AS visits_by_session,
  (SELECT COUNT(DISTINCT ip) FROM items_visits WHERE id_items = i.id) AS visits_by_ip,
 */
 async getUpload() {}

 async getUploadByID() {}

 async getUploads(o, d, count, offset, search) {
  let query = `
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

 async getUploadsInfo() {
  const query = `
   SELECT
    COUNT(*) AS count, SUM(size) AS size,
    (SELECT COUNT(*) FROM upload_downloads) AS downloads,
    (SELECT COUNT(DISTINCT session) FROM upload_downloads) AS downloads_by_session,
    (SELECT COUNT(DISTINCT ip) FROM upload_downloads) AS downloads_by_ip
   FROM upload`;
  return await this.db.query(query);
 }

 async setCategoryVisit() {}

 async setContact() {}

 async setFileDownload() {}

 async setFilePlay() {}

 async setFileWebPlay() {}

 async setForumPostAdd() {}

 async setForumThreadAdd() {}

 async setItemVisit() {}

 async setRegistration(params) {
  if (!/^[A-Za-z0-9]{3,24}$/.test(params.username)) return { error: 2, message: 'User name must be 3 to 24 characters long and can contain only letters and numbers!' };
  if (!validateEmail(params.email)) return { error: 4, message: 'E-mail is in invalid format!' };
  if (!(params.sex === '0' || params.sex === '1')) return { error: 6, message: 'You have to choose the right sex!' };
  if (!params.month || !params.day || !params.year || !checkDate(params.month, params.day, params.year)) return { error: 7, message: 'The date is in invalid format!' };
  if (params.password.length < 3) return { error: 8, message: 'The minimum password length is 3 characters!' };
  if (params.password !== params.password2) return { error: 9, message: 'Passwords does not match!' };
  if (!params.terms) return { error: 10, message: 'You have to agree with registration terms!' };
  if (!params.ip) params.ip = 'not available';
  if (!params.session) params.session = 'not available';
  const usernameExists = await this.db.query('SELECT COUNT(*) AS cnt FROM users WHERE username = ?', [params.username]);
  if (usernameExists[0].cnt > 0) return { error: 3, message: 'User name already exists!' };
  const emailExists = await this.db.query('SELECT COUNT(*) AS cnt FROM users WHERE email = ?', [params.email]);
  if (emailExists[0].cnt > 0) return { error: 5, message: 'Account with the same e-mail already exists!' };
  const hash = crypto.createHash('sha1');
  hash.update(new Date().getTime() + Math.random().toString());
  const confirmation = hash.digest('hex');
  const passwordHash = crypto.createHash('sha1').update(params.password).digest('hex');
  try {
   const result = await this.db.query(`
    INSERT INTO users
    (username, password, email, first_name, last_name, sex, birthdate, confirmation, reg_ip, reg_session, reg_user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [params.username, passwordHash, params.email, params.firstname, params.lastname, params.sex, params.year + '-' + params.month + '-' + params.day, confirmation, params.ip, params.session, params.useragent]
   );
   //if (!sendConfirmationEmail(confirmation, params.email, params.username, params.firstname, params.lastname)) {
   // return { error: 11, message: 'Error while sending confirmation e-mail!' };
   //}
   const userId = result.insertId;
   const res = await this.validateLogin(params);
   if (res.error) return res;
   return { error: 0, data: res.data };
  } catch (error) {
   return { error: 99, message: 'Database error, try later!' };
  }
 }

 async validateLogin(params) {
  const user = await this.db.query('SELECT id, password FROM users WHERE username = ?', [params.username]);
  if (user.length === 0) return { error: '1', message: 'User not found' };
  const storedHashedPassword = user[0].password;
  const inputHashedPassword = crypto.createHash('sha1').update(params.password).digest('hex');
  if (storedHashedPassword !== inputHashedPassword) return { error: '2', message: 'Incorrect password' };
  const userId = user[0].id;
  const TIMESTAMPHex = Date.now().toString(16);
  const sessionGuid = crypto.randomBytes(16).toString('hex') + TIMESTAMPHex;
  await this.db.query('INSERT INTO sessions (user_id, session_guid, last_access) VALUES (?, ?, ?)', [userId, sessionGuid, new Date()]);
  return { data: { username: params.username, sessionguid: sessionGuid } };
 }

 async setSession(sessionGuid) {
  const session = await this.db.query('SELECT COUNT(*) AS cnt FROM sessions WHERE session_guid = ?', [sessionGuid]);
  if (session[0].cnt === 0) return false;
  await this.db.query('UPDATE sessions SET last_access = NOW() WHERE session_guid = ?', [sessionGuid]);
  return true;
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

 async setAdminItemDelete() {}

 async setAdminItemEdit() {}

 async setAdminItemImageDelete() {}

 async setAdminItemAdd() {}

 async setAdminUploadDelete() {}

 async setAdminUploadEdit() {}

 async setAdminUploadMove() {}
}

module.exports = Data;
