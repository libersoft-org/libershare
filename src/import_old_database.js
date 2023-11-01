const mysql = require('mysql2/promise');

const db = new Database();
await db.open();
let items = '';

// TODO - ISO (UTC) TIME
items = await db.query('SELECT * FROM category');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO categories (id, name, link, image, created) VALUES (${i.id}, "${i.name}", "${i.link}", "${i.image}", "${created}");`);
}

items = await db.query('SELECT * FROM category_visits');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO categories_visits (id, id_categories, ip, session, user_agent, created) VALUES (${i.id}, ${i.id_category}, "${i.ip}", "${i.session}", "${i.user_agent}", "${created}");`);
}

items = await db.query('SELECT * FROM product');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO items (id, id_categories, name, link, image, image_sm, adult, hidden, created) VALUES (${i.id}, ${i.id_category}, "${i.name}", "${i.link}", "${i.image}", "${i.image_sm}", ${i.adult}, ${i.hidden}, "${created}");`);
}

items = await db.query('SELECT * FROM file');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO files (id, id_items, name, file_name, size, playable, ip, created) VALUES (${i.id}, ${i.id_product}, "${i.name}", "${i.filename}", "${i.size}", ${i.playable}, "${i.ip}", "${created}");`);
}

items = await db.query('SELECT * FROM file_downloads');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO files_downloads (id, id_files, ip, session, user_agent, created) VALUES (${i.id}, ${i.id_file}, "${i.ip}", "${i.session}", "${i.user_agent}", "${created}");`);
}

items = await db.query('SELECT * FROM file_plays');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO files_plays (id, id_files, ip, session, user_agent, created) VALUES (${i.id}, ${i.id_file}, "${i.ip}", "${i.session}", "${i.user_agent}", "${created}");`);
}

items = await db.query('SELECT * FROM file_plays_web');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO files_plays_web (id, id_files, ip, session, user_agent, created) VALUES (${i.id}, ${i.id_file}, "${i.ip}", "${i.session}", "${i.user_agent}", "${created}");`);
}

items = await db.query('SELECT * FROM product_visits');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO items_visits (id, id_items, ip, session, user_agent, created) VALUES (${i.id}, ${i.id_product}, "${i.ip}", "${i.session}", "${i.user_agent}", "${created}");`);
}

items = await db.query('SELECT * FROM search');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO search (id, phrase, ip, session, user_agent, created) VALUES (${i.id}, ${db.escape(i.phrase)}, "${i.ip}", "${i.session}", "${i.user_agent}", "${created}");`);
}

items = await db.query('SELECT * FROM upload');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO uploads (id, file_name, real_name, size, ip, created) VALUES (${i.id}, "${i.filename}", "${i.realname}", "${i.size}", "${i.ip}", "${created}");`);
}

items = await db.query('SELECT * FROM upload_downloads');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO uploads_downloads (id, id_uploads, ip, session, user_agent, created) VALUES (${i.id}, ${i.id_upload}, "${i.ip}", "${i.session}", "${i.user_agent}", "${created}");`);
}

items = await db.query('SELECT * FROM users');
for (let i of items) {
 const birthdate = i.birthdate.toISOString().split('T')[0];
 const created = i.created.toISOString();
 console.log(`INSERT INTO users (id, username, password, email, first_name, last_name, sex, birthdate, blocked, confirmation, reg_ip, reg_session, reg_user_agent, created) VALUES (${i.id}, "${i.username}", "${i.password}", "${i.email}", "${i.firstname}", "${i.lastname}", "${i.sex}", "${birthdate}", ${i.blocked}, "${i.confirmation}", "${i.regip}", "${i.regsession}", "${i.reguseragent}", "${created}");`);
}

items = await db.query('SELECT * FROM logins');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO logins (id, id_users, ip, session, user_agent, created) VALUES (${i.id}, ${i.id_user}, "${i.ip}", "${i.session}", "${i.user_agent}", "${created}");`);
}

items = await db.query('SELECT * FROM forum_thread');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO forum_threads (id, id_users, topic, body, created) VALUES (${i.id}, ${i.id_users}, ${db.escape(i.topic)}, ${db.escape(i.body)}, "${created}");`);
}

items = await db.query('SELECT * FROM forum_post');
for (let i of items) {
 const created = i.created.toISOString();
 console.log(`INSERT INTO forum_posts (id, id_users, id_forum_threads, body, created) VALUES (${i.id}, ${i.id_users}, ${i.id_forum_thread}, ${db.escape(i.body)}, "${created}");`);
}

process.exit(0);

class Database {
 async open() {
  this.db = await mysql.createConnection({
   host: '127.0.0.1',
   port: 3306,
   database: 'old_database',
   user: 'root',
   password: ''
  });
 }

 async query(sql, params = []) {
  try {
   const [result] = await this.db.execute(sql, params);
   return result;
  } catch (ex) {
   console.log('Query: ' + sql, 2);
   console.log(ex, 2);
  }
 }

 escape(sql) {
  return this.db.escape(sql);
 }
}
