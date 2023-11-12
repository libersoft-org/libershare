const os = require('os');
const fs = require('fs');
const path = require('path');
const Data = require('./data.js');
const { Common } = require('./common.js');

// TODO: This shouldn't be here, move to some class
const validCaptchas = {};
function cleanupOldCaptchas() {
 Common.addLog('Cleaning old captchas ...');
 const currentTime = new Date().getTime();
 for (const captchaId in validCaptchas) {
  if (currentTime - validCaptchas[captchaId].timestamp > 600000) delete validCaptchas[captchaId];
 }
}
setInterval(cleanupOldCaptchas, 60000);

class API {
 constructor() {
  this.apiMethods = {
   get_html: this.getHTML,
   get_css: this.getCSS,
   get_images_basic: this.getImagesBasic,
   get_images_categories: this.getImagesCategories,
   get_images_items: this.getImagesItems,
   get_images_item: this.getImagesItem,
   get_captcha: this.getCaptcha,
   get_categories: this.getCategories,
   get_category_by_id: this.getCategoryByID,
   get_category_by_link: this.getCategoryByLink,
   get_file_by_id: this.getFileByID,
   get_file: this.getFile,
   get_files: this.getFiles,
   get_forum_threads: this.getForumThreads,
   get_forum_thread: this.getForumThread,
   get_forum_posts: this.getForumPosts,
   get_login: this.getLogin,
   get_items: this.getItems,
   get_item_by_id: this.getItemByID,
   get_item_by_link: this.getItemByLink,
   get_items_auto_complete: this.getItemsAutoComplete,
   get_items_info: this.getItemsInfo,
   get_uploads: this.getUploads,
   get_uploads_info: this.getUploadsInfo,
   get_upload: this.getUpload,
   get_upload_by_id: this.getUploadByID,
   set_login: this.setLogin,
   set_session: this.setSession,
   set_category_visit: this.setCategoryVisit,
   set_contact: this.setContact,
   set_file_download: this.setFileDownload,
   set_file_play: this.setFilePlay,
   set_file_web_play: this.setFileWebPlay,
   set_forum_thread_add: this.setForumThreadAdd,
   set_forum_post_add: this.setForumPostAdd,
   set_item_visit: this.setItemVisit,
   set_registration: this.setRegistration,
   set_registration_confirmation: this.setRegistrationConfirmation,
   set_search: this.setSearch,
   set_upload: this.setUpload,
   set_upload_download: this.setUploadDownload,
   get_admin_admins: this.getAdminAdmins,
   get_admin_log: this.getAdminLog,
   get_admin_login: this.getAdminLogin,
   get_admin_search_stats: this.getAdminSearchStats,
   set_admin_category_delete: this.setAdminCategoryDelete,
   set_admin_category_edit: this.setAdminCategoryEdit,
   set_admin_category_icon_delete: this.setAdminCategoryIconDelete,
   set_admin_category_add: this.setAdminCategoryAdd,
   set_admin_diffs_delete_files_db: this.setAdminDiffsDeleteFilesDB,
   set_admin_diffs_delete_files_fs: this.setAdminDiffsDeleteFilesFS,
   set_admin_diffs_delete_uploads_db: this.setAdminDiffsDeleteUploadsDB,
   set_admin_diffs_delete_uploads_fs: this.setAdminDiffsDeleteUploadsFS,
   set_admin_file_delete: this.setAdminFileDelete,
   set_admin_file_edit: this.setAdminFileEdit,
   set_admin_log: this.setAdminLog,
   set_admin_item_delete: this.setAdminItemDelete,
   set_admin_item_edit: this.setAdminItemEdit,
   set_admin_item_image_delete: this.setAdminItemImageDelete,
   set_admin_item_add: this.setAdminItemAdd,
   set_admin_upload_delete: this.setAdminUploadDelete,
   set_admin_upload_edit: this.setAdminUploadEdit,
   set_admin_upload_move: this.setAdminUploadMove
  };
 }

 async runAPI() {
  this.data = new Data();
  await this.data.init();
 }

 async processAPI(name, params) {
  console.log('API request: ', name);
  console.log('Parameters: ', params);
  const method = this.apiMethods[name];
  if (method) return await method.call(this, params);
  else return { error: 1, message: 'API not found' };
 }

 getHTML() {
  const dir = path.join(__dirname, '../web/html/user/');
  const files = fs.readdirSync(dir).filter(file => file.endsWith('.html'));
  let html = {};
  for (const file of files) html[file.replace(/\.html$/, '')] = fs.readFileSync(path.join(dir, file), 'utf8');
  return { error: 0, data: html };
 }

 getCSS(p = {}) {
  let css = '';
  // TODO: FIX THE POTENTIAL FS INJECTION (p.group) !!!!!!!!!!!!!!!!:
  for (const group of p.groups) {
   const dir = path.join(__dirname, '../web/css/', group);
   const files = fs.readdirSync(dir).filter(file => file.endsWith('.css'));
   for (const file of files) css += fs.readFileSync(path.join(dir, file), 'utf8') + os.EOL;
  }
  return { error: 0, data: css };
 }
 
 async getImagesBasic(p = {}) {
  const f = {};
  const ext = ['.svg', '.jpg', '.jpeg', '.gif', '.png', '.webp', '.avif', '.heif'];
  for (const group of p.groups) {
   const dir = path.join(__dirname, '../web/img/', group + '/');
   const files = fs.readdirSync(dir).filter(file => ext.some(ext => file.endsWith(ext)));
   for (const file of files) f[file] = await this.getBinaryFileToBase64(path.join(dir, file));
  }
  return { error: 0, data: f };
 }

 async getImagesCategories(p = {}) {
  const f = {};
  for (const file of p.files) f[file] = await this.getBinaryFileToBase64(path.join(Common.settings.storage.images, 'categories', file));
  return { error: 0, data: f };
 }

 async getImagesItems(p = {}) {
  const f = {};
  for (const file of p.files) f[file] = await this.getBinaryFileToBase64(path.join(Common.settings.storage.images, 'items', file));
  return { error: 0, data: f };
 }

 async getImagesItem(p = {}) {
  return { error: 0, data: await this.getBinaryFileToBase64(path.join(Common.settings.storage.images, 'items', p.file)) };
 }

 async getBinaryFileToBase64(file) {
  try {
   const data = Bun.file(file);
   return 'data:' + data.type + ';base64,' + Buffer.from(await data.arrayBuffer()).toString('base64');
  } catch {
   return null;
  }
 }

 async getCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz123456789';
  let captchaText = '';
  for (let i = 0; i < 5; i++) captchaText += chars.charAt(Math.floor(Math.random() * chars.length));
  const randomColor = () => 'rgb(' + Math.floor(Math.random() * 160) + ',' + Math.floor(Math.random() * 160) + ',' + Math.floor(Math.random() * 160) + ')';
  const randomColorL = () => 'rgb(' + Math.floor(Math.random() * 128 + 128) + ',' + Math.floor(Math.random() * 128 + 128) + ',' + Math.floor(Math.random() * 128 + 128) + ')';
  let backgroundDots = '';
  for (let x = 0; x < 120; x += 6) {
   for (let y = 0; y < 40; y += 6) backgroundDots += '<circle cx="' + x + '" cy="' + y + '" r="3" fill="' + randomColor() + '" />';
  }
  let xPosition = 10;
  let coloredText = '';
  for (let i = 0; i < captchaText.length; i++) {
   const rotation = Math.floor(Math.random() * 30) - 15;
   coloredText += '<text x="' + xPosition + '" y="30" font-family="Arial" font-size="22" font-weight="bold" fill="' + randomColorL() + '" transform="rotate(' + rotation + ' ' + xPosition + ',30)">' + captchaText[i] + '</text>';
   xPosition += 22;
  }
  const svg = `
   <svg width="120" height="40" xmlns="http://www.w3.org/2000/svg" style="background-color: gray;">
    ${backgroundDots}
    ${coloredText}
   </svg>
  `;
  const base64Image = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const captchaId = new Date().getTime() + Math.random().toString(36).substring(2, 9);
  validCaptchas[captchaId] = captchaText;
  return { image: base64Image, capid: captchaId };
 }

 validateCaptcha(key, value) {
  if (!validCaptchas.hasOwnProperty(key) || !validCaptchas[key] === value) return false;
  delete validCaptchas[key];
  return true;
 }

 async getCategories(p = {}) {
  return { error: 0, data: await this.data.getCategories(p.items, p.order, p.direction, p.search, p.count, p.offset) };
 }

 async getCategoryByID(p = {}) {
  if (!p || !p.id) return { error: 1, message: 'Category ID not specified' };
  const res = await this.data.getCategoryByID(p.id);
  if (res.length != 1) return { error: 2, message: 'Category does not exist' };
  return { error: 0, data: res[0] };
 }

 async getCategoryByLink(p = {}) {
  if (!p || !p.link) return { error: 1, message: 'Category link not specified' }
  const res = await this.data.getCategoryByLink(p.link);
  if (res && res.length != 1) return { error: 2, message: 'Category does not exist' };
  return { error: 0, data: res[0] };
 }

 async getFileByID(p = {}) {
  /*
   require_once('../settings.php');
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   if ($id != '') {
    $result = SQLQuery('
     SELECT
      f.id,
      f.id_item,
      p.name AS item_name,
      p.link AS item_link,
      f.name, f.filename,
      f.size,
      f.playable,
      f.ip,
      (SELECT COUNT(*) FROM file_downloads WHERE id_file = f.id) AS downloads,
      (SELECT COUNT(DISTINCT session) FROM file_downloads WHERE id_file = f.id) AS downloads_by_session,
      (SELECT COUNT(DISTINCT ip) FROM file_downloads WHERE id_file = f.id) AS downloads_by_ip,
      (SELECT COUNT(*) FROM file_plays WHERE id_file = f.id) AS plays,
      (SELECT COUNT(DISTINCT session) FROM file_plays WHERE id_file = f.id) AS plays_by_session,
      (SELECT COUNT(DISTINCT ip) FROM file_plays WHERE id_file = f.id) AS plays_by_ip,
      f.created
     FROM file f, item p
     WHERE f.id_item = p.id AND f.id = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     $arr = SQLArray($result);
     $arr[0]['type'] = mime_content_type('../' . $GLOBALS['path-files'] . '/' . $arr[0]['name']);
     echo json_encode($arr);
    } else echo json_encode(array('error' => 2, 'message' => 'File doesn\'t exist'));
   } else echo json_encode(array('error' => 1, 'message' => 'File ID is empty'));
  */
  if (p.id == null || p.id == '') return { error: 1, message: 'File ID is empty' };
  const res = await this.data.getFileByID(p.id);
  if (res.length == 0) return { error: 2, message: 'File does not exist' };
  else return { error: 0, data: res };
 }

 async getFile(p = {}) {
  /*
   require_once('../settings.php');
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   if ($id != '') {
    $result = SQLQuery('SELECT id, id_item, name, filename, size, playable, ip, (SELECT COUNT(*) FROM file_downloads WHERE id_file = file.id) AS downloads, (SELECT COUNT(DISTINCT session) FROM file_downloads WHERE id_file = file.id) AS downloads_by_session, (SELECT COUNT(DISTINCT ip) FROM file_downloads WHERE id_file = file.id) AS downloads_by_ip, (SELECT COUNT(*) FROM file_plays WHERE id_file = file.id) AS plays, (SELECT COUNT(DISTINCT session) FROM file_plays WHERE id_file = file.id) AS plays_by_session, (SELECT COUNT(DISTINCT ip) FROM file_plays WHERE id_file = file.id) AS plays_by_ip, created FROM file WHERE name = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     $arr = SQLArray($result);
     $arr[0]['type'] = mime_content_type('../' . $GLOBALS['path-files'] . '/' . $arr[0]['name']);
     echo json_encode($arr);
    } else echo json_encode(array('error' => 2, 'message' => 'File doesn\'t exist'));
   } else echo json_encode(array('error' => 1, 'message' => 'File ID is empty'));
  */
  if (p.id == null || p.id == '') return { error: 1, message: 'File ID is empty' };
  const res = await data.getFile(p.id);
  if (res.length != 1) return { error: 2, message: 'File does not exist' };
  res[0].type = this.getMimeType(path + '/' + res[0].name);
  return { error: 0, data: res };
 }

 async getFiles(p = {}) {
  /*
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   $o = SQLEscape($_GET['o']);
   $d = SQLEscape($_GET['d']);
   $p = SQLEscape($_GET['p']);
   $search = SQLEscape($_GET['search']);
   $count = SQLEscape($_GET['count']);
   $offset = SQLEscape($_GET['offset']);
   $count = (isset($count) && $count != '') ? intval($count) : '18446744073709551615';
   $offset = intval($offset);
   if ($id != '') {
    $result = SQLQuery('SELECT id FROM item WHERE id = "' . $id . '"');
    if (SQLNumRows($result) != 1) {
     echo json_encode(array('error' => 1, 'message' => 'Item doesn\'t exist'));
     die;
    }
   }
   $sql = 'SELECT f.id, f.name, f.filename, p.id AS item_id, p.name AS item_name, p.link AS item_link, f.size, f.playable, f.ip, (SELECT COUNT(*) FROM file_downloads WHERE id_file = f.id) AS downloads, (SELECT COUNT(DISTINCT session) FROM file_downloads WHERE id_file = f.id) AS downloads_by_session, (SELECT COUNT(DISTINCT ip) FROM file_downloads WHERE id_file = f.id) AS downloads_by_ip, (SELECT COUNT(*) FROM file_plays WHERE id_file = f.id) AS plays, (SELECT COUNT(DISTINCT session) FROM file_plays WHERE id_file = f.id) AS plays_by_session, (SELECT COUNT(DISTINCT ip) FROM file_plays WHERE id_file = f.id) AS plays_by_ip, f.created FROM file f, item p WHERE f.id_item = p.id' . ($id != '' ? ' AND f.id_item = "' . $id . '"' : '') . ($p == '1' || $p == '2' ? ' AND f.playable = "' . ($p == 1 ? '1' : '0') . '"' : '') . ($search != '' ? ' AND MATCH(f.filename) AGAINST ("' . $search .'")' : '') . ($search == '' ? ' ORDER BY ' . ($o != '' ? $o : 'f.created') . ' ' . ($d == 'asc' ? 'ASC' : 'DESC') . ', f.id ' . ($d == 'asc' ? 'ASC' : 'DESC') : '') . ' LIMIT ' . $count . ' OFFSET ' . $offset;
   echo SQL2JSON($sql);
  */
  if (!p.id_item) return { error: 1, message: 'Item ID is empty' };
  if (!(await this.data.getItemExists(p.id_item))) return { error: 2, message: 'Item does not exist' };
  const res = await this.data.getDownloadFiles(p.id_item, p.order, p.direction, p.search, p.count, p.offset);
  return { error: 0, data: res };
 }

 async getForumThreads(p = {}) {
  /*
   require_once('./api_functions.php');
   $o = SQLEscape($_GET['o']);
   $d = SQLEscape($_GET['d']);
   $count = SQLEscape($_GET['count']);
   $offset = SQLEscape($_GET['offset']);
   $count = (isset($count) && $count != '') ? intval($count) : '18446744073709551615';
   $offset = intval($offset);
   $sql = '
   SELECT
    t.id,
    t.id_users,
    u.username,
    u.sex,
    t.topic,
    (SELECT COUNT(*) FROM forum_post WHERE id_forum_thread = t.id) AS posts_count,
    t.created
   FROM forum_thread t, users u
   WHERE u.id = t.id_users
   ORDER BY ' . ($o != '' ? $o : 't.created') . ' ' . ($d == 'asc' ? 'ASC' : 'DESC') . ', id ' . ($d == 'asc' ? 'ASC' : 'DESC')
   . ' LIMIT ' . $count . ' OFFSET ' . $offset;
   echo SQL2JSON($sql);
  */
  const res = await this.data.getForumThreads(p.order, p.direction, p.count, p.offset);
  return { error: 0, data: res };
 }

 async getForumThread(p = {}) {
  if (!p.id) return { error: 1, message: 'Forum thread ID is empty' };
  const res = await this.data.getForumThread(p.id, p.order, p.direction, p.count, p.offset);
  if (res.length != 1) return { error: 2, message: 'Forum thread does not exist' };
  return { error: 0, data: res[0] };
 }

 async getForumPosts(p = {}) {
  if (!p.id) return { error: 1, message: 'Thread ID is empty' };
  const res = await this.data.getForumPosts(p.id);
  return { error: 0, data: res };
 }

 async getLogin(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   require_once('../functions.php');
   $secretKey = '';
   $responseKey = $_GET['g-recaptcha-response'];
   $response = json_decode(file_get_contents('https://www.google.com/recaptcha/api/siteverify?secret=' . $secretKey . '&response=' . $responseKey . '&remoteip=' . $_SERVER['REMOTE_ADDR']));
   if ($response->success) {
    $user = '';
    $pass = '';
    if (!empty($_GET['user'])) $user = SQLEscape(trim($_GET['user']));
    if (!empty($_GET['pass'])) $pass = SQLEscape($_GET['pass']);
    $type = (strpos($user, '@')) ? 'email' : 'username';
    $result = SQLQuery('SELECT id, username FROM users WHERE ' . $type . '="' . $user . '"');
    if (SQLNumRows($result) == 1) {
     $rows = SQLArray($result)[0];
     $id = $rows['id'];
     $name = $rows['username'];
     $result = SQLQuery('SELECT username, password, confirmation, email, blocked, firstname, lastname FROM users WHERE ' . $type . '="' . $user . '"');
     $row = mysqli_fetch_assoc($result);
     if ($row['password'] == sha1($pass)) {
      if ($row['confirmation'] == null) {
       if ($row['blocked'] == 0) {
        $_SESSION['login-id'] = $id;
        $_SESSION['login-user'] = $row['username'];
        SQLQuery('INSERT INTO logins (id_user, ip, session, user_agent) VALUES ("' . $id . '", "' . SQLEscape(getClientIP()) . '", "' . SQLEscape(session_id()) . '", "' . SQLEscape($_SERVER['HTTP_USER_AGENT']) . '")');
        echo json_encode(array('error' => 0, 'message' => 'Login OK.'));
       } else echo json_encode(array('error' => 5, 'message' => 'User is banned!'));
      } else {
       sendConfirmationEmail($row['confirmation'], $row['email'], $row['username'], $row['firstname'], $row['lastname']);
       echo json_encode(array('error' => 4, 'message' => 'User is not activated!'));
      }
     } else echo json_encode(array('error' => 3, 'message' => 'Wrong password!'));
    } else echo json_encode(array('error' => 2, 'message' => 'Wrong user name or e-mail!'));
   } else echo json_encode(array('error' => 1, 'message' => 'Wrong captcha'));
  */
 }

 async getItems(p = {}) {
  /*
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   $order = SQLEscape($_GET['o']);
   $direction = SQLEscape($_GET['d']);
   $hidden = SQLEscape($_GET['h']);
   $adult = SQLEscape($_GET['a']);
   $image = SQLEscape($_GET['i']);
   $video = SQLEscape($_GET['v']);
   $search = SQLEscape($_GET['search']);
   $count = SQLEscape($_GET['count']);
   $offset = SQLEscape($_GET['offset']);
   $count = (isset($count) && $count != '') ? intval($count) : '18446744073709551615';
   $offset = intval($offset);
   if ($id != '' && $id != '0') {
    $result = SQLQuery('SELECT id FROM category WHERE id = "' . $id . '"');
    if (SQLNumRows($result) != 1) {
     echo json_encode(array('error' => 1, 'message' => 'Category doesn\'t exist'));
     die;
    }
   }
   $sql = '
    SELECT
     i.id,
     i.name,
     i.link,
     i.id_file_video,
     i.image,
     i.image_sm,
     i.id_category,
     c.name AS category_name,
     c.link AS category_link,
     (SELECT COUNT(*) FROM file WHERE id_item = i.id) AS files,
     i.adult,
     i.hidden,
     (SELECT COUNT(*) FROM item_visits WHERE id_item = i.id) AS visits,
     (SELECT COUNT(DISTINCT session) FROM item_visits WHERE id_item = i.id) AS visits_by_session,
     (SELECT COUNT(DISTINCT ip) FROM item_visits WHERE id_item = i.id) AS visits_by_ip,
     i.created
    FROM item i, category c
    WHERE
     i.id_category = c.id'
     . ($hidden == '1' || $hidden == '2' ? ' AND i.hidden = "' . ($hidden == 1 ? '1' : '0') . '"' : '')
     . ($adult == '1' || $adult == '2' ? ' AND i.adult = "' . ($adult == 1 ? '1' : '0') . '"' : '')
     . ($image == '1' || $image == '2' ? ' AND i.image IS ' . ($image == 1 ? 'NOT NULL' : 'NULL') : '')
     . ($video == '1' || $video == '2' ? ' AND i.id_file_video IS ' . ($video == 1 ? 'NOT NULL' : 'NULL') : '')
     . ($id != '' && $id != '0' ? ' AND i.id_category = "' . $id .'"' : '')
     . ($search != '' ? ' AND MATCH(i.name) AGAINST ("' . $search .'")' : '')
     . ($search == '' ? ' ORDER BY ' . ($order != '' ? $order : 'created') . ' ' . ($direction == 'asc' ? 'ASC' : 'DESC') . ', id ' . ($direction == 'asc' ? 'ASC' : 'DESC') : '')
     . ' LIMIT ' . $count . ' OFFSET ' . $offset;
   echo SQL2JSON($sql);
  */
  if (p.id_category) {
   if (!(await this.data.getCategoryExists(p.id_category))) return { error: 1, message: 'Category does not exist' };
  }
  const res = await this.data.getItems(p.id_category, p.order, p.direction, p.hidden, p.adult, p.files, p.image, p.search, p.count, p.offset);
  return { error: 0, data: res };
 }

 async getItemByID(p = {}) {
  /*
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   $hidden = SQLEscape($_GET['hidden']);
   if ($id != '') {
    $result = SQLQuery('
    SELECT
     id,
     id_category,
     name,
     link,
     id_file_video,
     image,
     image_sm,
     adult,
     hidden,
     (SELECT COUNT(*) FROM items_visits WHERE id_items = items.id) AS visits,
     (SELECT COUNT(DISTINCT session) FROM items_visits WHERE id_items = items.id) AS visits_by_session,
     (SELECT COUNT(DISTINCT ip) FROM items_visits WHERE id_items = items.id) AS visits_by_ip,
     created
    FROM items
    WHERE id = "' . $id . '"' . ($hidden == '1' ? ' AND hidden = 0' : ''));
    if (SQLNumRows($result) == 1) echo json_encode(SQLArray($result));
    else echo json_encode(array('error' => 2, 'message' => 'Item doesn\'t exist'));
   } else echo json_encode(array('error' => 1, 'message' => 'Item ID is empty'));
  */
  if (!p.id) return { error: 1, message: 'Item ID is empty' }
  const res = await this.data.getItemByID(p.id, p.hidden);
  if (res.length != 1) return { error: 2, message: 'Item does not exist' }
  return { error: 0, data: res[0] };
 }

 async getItemByLink(p = {}) {
  if (!p.link) return { error: 1, message: 'Item link is empty' }
  const res = await this.data.getItemByLink(p.link, p.hidden);
  if (res.length != 1) return { error: 2, message: 'Item does not exist' }
  return { error: 0, data: res[0] };
 }

 async getItemsAutoComplete(p = {}) {
  if (!p.search) return { error: 1, message: 'Search phrase is empty' }
  const res = await this.data.getItemsAutoComplete(p.search);
  return { error: 0, data: res };
 }

 async getItemsInfo(p = {}) {
  /*
   require_once('./api_functions.php');
   echo SQL2JSON('
    SELECT
     COUNT(*) AS count,
     (SELECT COUNT(*) FROM item WHERE hidden = 1) AS count_hidden,
     (SELECT COUNT(*) FROM file) AS files_count,
     (SELECT SUM(size) FROM file) AS files_size,
     (SELECT COUNT(*) FROM item_visits) AS visits,
     (SELECT SUM(total)
    FROM
     (SELECT COUNT(DISTINCT session) AS total FROM item_visits GROUP BY id_item) AS visits_session_table) AS visits_session,
     (SELECT SUM(total) FROM (SELECT COUNT(DISTINCT ip) AS total FROM item_visits GROUP BY id_item) AS visits_ip_table) AS visits_ip,
     (SELECT COUNT(*) FROM file_downloads) AS downloads,
     (SELECT SUM(total) FROM (SELECT COUNT(DISTINCT session) AS total FROM file_downloads GROUP BY id_file) AS downloads_session_table) AS downloads_session,
     (SELECT SUM(total) FROM (SELECT COUNT(DISTINCT ip) AS total FROM file_downloads GROUP BY id_file) AS downloads_ip_table) AS downloads_ip,
     (SELECT COUNT(*) FROM file_plays) AS plays,
     (SELECT SUM(total) FROM (SELECT COUNT(DISTINCT session) AS total FROM file_plays GROUP BY id_file) AS plays_session_table) AS plays_session,
     (SELECT SUM(total) FROM (SELECT COUNT(DISTINCT ip) AS total FROM file_plays GROUP BY id_file) AS plays_ip_table) AS plays_ip FROM item');
  */
 }

 async getUploads(p = {}) {
  /*
   require_once('./api_functions.php');
   $o = SQLEscape($_GET['o']);
   $d = SQLEscape($_GET['d']);
   $count = SQLEscape($_GET['count']);
   $offset = SQLEscape($_GET['offset']);
   $count = (isset($count) && $count != '') ? intval($count) : '18446744073709551615';
   $offset = intval($offset);
   $search = SQLEscape($_GET['search']);
   $sql = '
    SELECT
     id,
     filename,
     realname,
     size,
     ip,
     (SELECT COUNT(*) FROM upload_downloads WHERE id_upload = upload.id) AS downloads,
     (SELECT COUNT(DISTINCT session) FROM upload_downloads WHERE id_upload = upload.id) AS downloads_by_session,
     (SELECT COUNT(DISTINCT ip) FROM upload_downloads WHERE id_upload = upload.id) AS downloads_by_ip,
     created
    FROM upload'
    . ($search != '' ? ' WHERE MATCH(realname) AGAINST ("' . $search .'")' : '')
    . ($search == '' ? ' ORDER BY ' . ($o != '' ? $o : 'created') . ' ' . ($d == 'asc' ? 'ASC' : 'DESC') . ', id ' . ($d == 'asc' ? 'ASC' : 'DESC') : '')
    . ' LIMIT ' . $count . ' OFFSET ' . $offset;
   echo SQL2JSON($sql);
  */
  const res = await this.data.getUploads(p.order, p.direction, p.count, p.offset, p.search);
  return { error: 0, data: res };
 }

 async getUploadsInfo(p = {}) {
  const res = await this.data.getUploadsInfo(p = {});
  return { error: 0, data: res };
 }

 async getUpload(p = {}) {
  /*
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   if ($id != '') {
    $result = SQLQuery('
    SELECT
     id,
     filename,
     realname,
     size,
     ip,
     (SELECT COUNT(*) FROM upload_downloads WHERE id_upload = upload.id) AS downloads,
     (SELECT COUNT(DISTINCT session) FROM upload_downloads WHERE id_upload = upload.id) AS downloads_by_session,
     (SELECT COUNT(DISTINCT ip) FROM upload_downloads WHERE id_upload = upload.id) AS downloads_by_ip,
     created
    FROM upload
    WHERE filename = "' . $id . '"');
    if (SQLNumRows($result) == 1) echo json_encode(SQLArray($result));
    else echo json_encode(array('error' => 2, 'message' => 'File doesn\'t exist'));
   } else echo json_encode(array('error' => 1, 'message' => 'File ID is empty'));
  */
 }

 async getUploadByID(p = {}) {
  /*
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   if ($id != '') {
    $result = SQLQuery('
     SELECT
      id,
      filename,
      realname,
      size,
      ip,
      (SELECT COUNT(*) FROM upload_downloads WHERE id_upload = upload.id) AS downloads,
      (SELECT COUNT(DISTINCT session) FROM upload_downloads WHERE id_upload = upload.id) AS downloads_by_session,
      (SELECT COUNT(DISTINCT ip) FROM upload_downloads WHERE id_upload = upload.id) AS downloads_by_ip,
      created
     FROM upload
     WHERE id = "' . $id . '"');
    if (SQLNumRows($result) == 1) echo json_encode(SQLArray($result));
    else echo json_encode(array('error' => 2, 'message' => 'File doesn\'t exist'));
   } else echo json_encode(array('error' => 1, 'message' => 'File ID is empty'));
  */
 }

 async setCategoryVisit(p = {}) {
  /*
  if (session_status() == PHP_SESSION_NONE) session_start();
  require_once('api_functions.php');
  $id = $category[0]['id'];
  if (SQLNumRows(SQLQuery('
   SELECT id FROM category
   WHERE id = "' . $id . '"')) == '1')
   SQLQuery('
    INSERT INTO category_visits
     (id_category, ip, session, user_agent)
    VALUES
     ("' . $id . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async setContact(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   require_once('../functions.php');
   $secretKey = '';
   $responseKey = $_GET['g-recaptcha-response'];
   $response = json_decode(file_get_contents('https://www.google.com/recaptcha/api/siteverify?secret=' . $secretKey . '&response=' . $responseKey . '&remoteip=' . $_SERVER['REMOTE_ADDR']));
   $email_to = htmlspecialchars($_GET['email']);
   $name_to = htmlspecialchars($_GET['name']);
   $subject_input = htmlspecialchars($_GET['subject']);
   $body = nl2br(htmlspecialchars($_GET['body']));
   if ($response->success) {
    if (strlen($name_to) > 0) {
     if (filter_var($email_to, FILTER_VALIDATE_EMAIL)) {
      if (strlen($subject_input) > 0) {
       if (strlen($body) > 0) {
        require_once('../settings.php');
        require_once('../PHPMailerAutoload.php');
        $aPHPMail = new PHPMailer(true);
        try {
         $email_from = $GLOBALS['mail-from'];
         $name_from = $GLOBALS['item'];
         $subject = 'New message from web form ' . $GLOBALS['item'] . ' - ' . $subject_input;
         $message_array = array(
          '[[name-to]]'       => $name_to,
          '[[email-to]]'      => $email_to,
          '[[subject-input]]' => $subject_input,
          '[[ip]]'            => $_SERVER['REMOTE_ADDR'],
          '[[body]]'          => $body
         );
         $message = html_replace($message_array, file_get_contents('../' . $GLOBALS['template-path'] . '/contact-email.html'));
         $aPHPMail->CharSet = 'UTF-8';
         $aPHPMail->IsHTML(true);
         $aPHPMail->IsSMTP();
         $aPHPMail->Host       = $GLOBALS['mail-host'];
         $aPHPMail->SMTPAuth   = $GLOBALS['mail-smtpauth'];
         $aPHPMail->SMTPSecure = $GLOBALS['mail-smtpsecure'];
         $aPHPMail->AuthType   = $GLOBALS['mail-authtype'];
         $aPHPMail->Username   = $GLOBALS['mail-username'];
         $aPHPMail->Password   = $GLOBALS['mail-password'];
         $aPHPMail->SMTPOptions = $GLOBALS['mail-smtpoptions'];
         $aPHPMail->SetFrom($email_to, $name_to);
         $aPHPMail->Subject = $subject;
         $aPHPMail->Body = $message;
         $aPHPMail->AddAddress($email_from, $name_from);
         if ($aPHPMail->Send()) echo json_encode(array('error' => 0, 'message' => 'Sent OK.'));
         else echo json_encode(array('error' => 6, 'message' => 'Error while sending e-mail!'));
        } catch (phpmailerException $e) {
         echo json_encode(array('error' => 6, 'message' => 'Error while sending e-mail!'));
        } catch (Exception $e) {
         echo json_encode(array('error' => 6, 'message' => 'Error while sending e-mail!'));
        }
       } else echo json_encode(array('error' => 5, 'message' => 'Message text cannot be empty!'));
      } else echo json_encode(array('error' => 4, 'message' => 'Subject cannot be empty!'));
     } else echo json_encode(array('error' => 3, 'message' => 'Wrong e-mail address!'));
    } else echo json_encode(array('error' => 2, 'message' => 'Your name cannot be empty!'));
   } else echo json_encode(array('error' => 1, 'message' => 'Wrong recaptcha!'));
  */
 }

 async setFileDownload(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = $f[0]['id'];
   if (SQLNumRows(SQLQuery('SELECT id FROM file WHERE id = "' . $id . '"')) == '1') SQLQuery('INSERT INTO file_downloads (id_file, ip, session, user_agent) VALUES ("' . $id . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async setFilePlay(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = $f[0]['id'];
   if (SQLNumRows(SQLQuery('SELECT id FROM file WHERE id = "' . $id . '"')) == '1')
    SQLQuery('
    INSERT INTO file_plays
     (id_file, ip, session, user_agent)
    VALUES
     ("' . $id . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async setFileWebPlay(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = $f[0]['id'];
   if (SQLNumRows(SQLQuery('SELECT id FROM file WHERE id = "' . $id . '"')) == '1')
    SQLQuery('
     INSERT INTO file_plays_web
      (id_file, ip, session, user_agent)
     VALUES
      ("' . $id . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async setForumThreadAdd(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $subject = '';
   $body = '';
   if (!empty($_POST['subject'])) $subject = SQLEscape(trim($_POST['subject']));
   if (!empty($_POST['body'])) $body = SQLEscape($_POST['body']);
   if (isset($_SESSION['login-id'])) {
    if ($subject != '') {
     if ($body != '') {
      if (isset($_SESSION['captcha']) && strtolower($_SESSION['captcha']) == strtolower($_POST['captcha'])) {
       SQLQuery('
        INSERT INTO forum_thread
         (id_users, topic, body)
        VALUES
         ("' . SQLEscape($_SESSION['login-id']) . '", "' . $subject . '", "' . $body . '")');
       echo json_encode(array('error' => 0, 'message' => 'Forum thread created OK!'));
      } else echo json_encode(array('error' => 4, 'message' => 'Wrong captcha code!'));
     } else echo json_encode(array('error' => 3, 'message' => 'Thread body is empty!'));
    } else echo json_encode(array('error' => 2, 'message' => 'Thread subject is empty!'));
   } else echo json_encode(array('error' => 1, 'message' => 'User is not logged in!'));
  */
 }

 async setForumPostAdd(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $thread_id = '';
   $body = '';
   if (!empty($_POST['thread_id'])) $thread_id = SQLEscape(trim($_POST['thread_id']));
   if (!empty($_POST['body'])) $body = SQLEscape($_POST['body']);
   if (isset($_SESSION['login-id'])) {
    $num = SQLNumRows(SQLQuery('SELECT id FROM forum_thread WHERE id = "' . $thread_id . '"'));
    if ($num == 1) {
     if ($body != '') {
      if (isset($_SESSION['captcha']) && strtolower($_SESSION['captcha']) == strtolower($_POST['captcha'])) {
       SQLQuery('
       INSERT INTO forum_post
        (id_users, id_forum_thread, body)
       VALUES
        ("' . SQLEscape($_SESSION['login-id']) . '", "' . $thread_id . '", "' . $body . '")');
       echo json_encode(array('error' => 0, 'message' => 'Forum thread created OK!'));
      } else echo json_encode(array('error' => 4, 'message' => 'Wrong captcha code!'));
     } else echo json_encode(array('error' => 3, 'message' => 'Post body is empty!'));
    } else echo json_encode(array('error' => 2, 'message' => 'Thread ID does not exist!'));
   } else echo json_encode(array('error' => 1, 'message' => 'User is not logged in!'));
  */
 }

 async setItemVisit(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = $item[0]['id'];
   if (SQLNumRows(SQLQuery('SELECT id FROM item WHERE id = "' . $id . '"')) == '1')
    SQLQuery('INSERT INTO item_visits
     (id_item, ip, session, user_agent)
    VALUES
     ("' . $id . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async setRegistration(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   require_once('../functions.php');
   $secretKey = '';
   $responseKey = $_GET['g-recaptcha-response'];
   $response = json_decode(file_get_contents('https://www.google.com/recaptcha/api/siteverify?secret=' . $secretKey . '&response=' . $responseKey . '&remoteip=' . $_SERVER['REMOTE_ADDR']));
   if ($response->success) {
    if (preg_match("/^[A-Za-z0-9]{3,24}$/", $_GET['username'])) {
     if (SQLNumRows(SQLQuery('SELECT id FROM users WHERE username="' . SQLEscape($_GET['username']) . '"')) == 0) {
      if (filter_var($_GET['email'], FILTER_VALIDATE_EMAIL)) {
       if (SQLNumRows(SQLQuery('SELECT email FROM users WHERE email="' . SQLEscape($_GET['email']) . '"')) == 0) {
        if ($_GET['sex'] == 0 || $_GET['sex'] == 1) {
         if (!empty($_GET['month']) and !empty($_GET['day']) and !empty($_GET['year']) and checkdate($_GET['month'], $_GET['day'], $_GET['year'])) { // checkdate ocekava integer a dostal prazdnej string
          if (strlen($_GET['password']) >= 3) {
           if ($_GET['password'] == $_GET['password2']) {
            if ($_GET['terms']) {
             $confirmation = sha1(microtime(true) . rand(0, 4294967296));
             SQLQuery('
              INSERT INTO users
               (username, password, email, firstname, lastname, sex, birthdate, confirmation, regip, regsession, reguseragent)
              VALUES
               ("' . SQLEscape($_GET['username']) . '", "' . sha1($_GET['password']) . '", "' . SQLEscape($_GET['email']) . '", "' . SQLEscape($_GET['firstname']) . '", "' . SQLEscape($_GET['lastname']) . '", "' . SQLEscape($_GET['sex']) . '", "' . SQLEscape($_GET['year']) . '-' . SQLEscape($_GET['month']) . '-' . SQLEscape($_GET['day']) . '", "' . $confirmation . '", "' . SQLEscape(getClientIP()) . '", "' . SQLEscape(session_id()) . '", "' . $_SERVER['HTTP_USER_AGENT'] . '")');
             if (sendConfirmationEmail($confirmation, $_GET['email'], $_GET['username'], $_GET['firstname'], $_GET['lastname'])){
              echo json_encode(array('error' => 0, 'message' => 'Registration OK.'));
             } else echo json_encode(array('error' => 11, 'message' => 'Error while sending confirmation e-mail!'));
            } else echo json_encode(array('error' => 10, 'message' => 'You have to agree with registration terms!'));
           } else echo json_encode(array('error' => 9, 'message' => 'Passwords does not match!'));
          } else echo json_encode(array('error' => 8, 'message' => 'The minimum password length is 3 characters!'));
         } else echo json_encode(array('error' => 7, 'message' => 'The date is in invalid format!'));
        } else echo json_encode(array('error' => 6, 'message' => 'You have to choose the right sex!'));
       } else echo json_encode(array('error' => 5, 'message' => 'Account with the same e-mail already exists!'));
      } else echo json_encode(array('error' => 4, 'message' => 'E-mail is in invalid format!'));
     } else echo json_encode(array('error' => 3, 'message' => 'User name already exists!'));
    } else echo json_encode(array('error' => 2, 'message' => 'User name must be 3 to 24 characters long and can contain only upper and lower case letters and numbers!'));
   } else echo json_encode(array('error' => 1, 'message' => 'Wrong recaptcha!'));
  */
  if (!this.validateCaptcha(p.cid, p.captcha)) return { error: 1, message: 'Wrong captcha!' };
  return await this.data.setRegistration(p);
 }

 async setLogin(p = {}) {
  if (!this.validateCaptcha(p.cid, p.captcha)) return { error: 1, message: 'Wrong captcha!' };
  const res = await this.data.validateLogin(p);
  if (res.error) return res;
  return { error: 0, data: res.data };
 }

 async setSession(p = {}) {
  const resp = await this.data.setSession(p.sessionguid);
  if (!resp) return { error: 1, message: 'Session is not valid' };
  return { error: 0, data: p.sessionguid };
 }

 async setRegistrationConfirmation(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   require_once('../functions.php');
   $id = SQLEscape($_GET['id']);
   if (SQLNumRows(SQLQuery('SELECT id FROM users WHERE confirmation="' . $id . '"')) == 1) {
    SQLQuery('UPDATE users SET confirmation = NULL WHERE confirmation = "' . $id . '"');
    echo json_encode(array('error' => 0, 'message' => 'E-mail confirmation OK!'));
   } else echo json_encode(array('error' => 1, 'message' => 'Wrong e-mail confirmation ID!'));
  */
 }

 async setSearch(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   SQLQuery('INSERT INTO search (phrase, ip, session, user_agent) VALUES ("' . SQLEscape($phrase) . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async setUpload(p = {}) {
  /*
   require_once('api_functions.php');
   require_once('../settings.php');
   require_once('../functions.php');
   switch ($_POST['action']) {
    case 'new':
     echo NewFile();
     break;
    case 'add':
     echo Add($_POST['filename']);
     break;
    case 'done':
     echo Done($_POST['original'], $_POST['new']);
     break;
   }
   
   function NewFile() {
    $name = sha1(microtime(true) . rand(0, 4294967296));
    $file = '../' . $GLOBALS['path-upload-temp'] . '/' . $name;
    if (!file_exists($file)) {
     if (is_writable('../' . $GLOBALS['path-upload-temp'])) {
      touch($file);
      echo json_encode(array('error' => 0, 'message' => $name));
     } else echo json_encode(array('error' => 2, 'message' => 'Creating a new file unsuccessful.'));
    } else echo json_encode(array('error' => 1, 'message' => 'This file already exists.'));
   }
   
   function Add($filename) {
    if (file_exists('../' . $GLOBALS['path-upload-temp'] . '/' . $filename)) {
     $data = fopen($_FILES['files']['tmp_name'], 'r');
     file_put_contents('../' . $GLOBALS['path-upload-temp'] . '/' . $filename, $data, FILE_APPEND);
     echo json_encode(array('error' => 0, 'message' => 'OK'));
    } else echo json_encode(array('error' => 1, 'message' => 'File does not exist.'));
   }
   
   function Done($original, $new) {
    if (file_exists('../' . $GLOBALS['path-upload-temp'] . '/' . $original)) {
     if (is_file('../' . $GLOBALS['path-upload-temp'] . '/' . $original)) {
      if (is_writable('../' . $GLOBALS['path-upload'])) {
       if (!file_exists('../' . $GLOBALS['path-upload'] . '/' . $new)) {
        rename('../' . $GLOBALS['path-upload-temp'] . '/' . $original, '../' . $GLOBALS['path-upload'] . '/' . $original);
        $filename = SQLEscape($original);
        $realname = SQLEscape($new);
        $ip = SQLEscape(getClientIP());
        if (file_exists('../' . $GLOBALS['path-upload'] . '/' . $filename)) {
         if (SQLNumRows(SQLQuery('SELECT id FROM upload WHERE filename = "' . $filename . '"')) == 0) {
          SQLQuery('INSERT INTO upload (filename, realname, size, ip) VALUES ("' . $filename . '", "' . $realname . '", "' . filesize('../' . $GLOBALS['path-upload'] . '/' . $filename) . '", "' . $ip . '")');
          echo json_encode(array('error' => 0, 'message' => 'OK'));
         } else echo json_encode(array('error' => 6, 'message' => 'This file is already in database.'));
        } else echo json_encode(array('error' => 5, 'message' => 'Uploaded file does not exist.'));
       } else echo json_encode(array('error' => 4, 'message' => 'Saving file unsuccessful, because other file with the same name already exists on server.'));
      } else echo json_encode(array('error' => 3, 'message' => 'Moving file to destination folder unsuccessful.'));
     } else echo json_encode(array('error' => 2, 'message' => 'Provided file name is not a file, but a directory.'));
    } else echo json_encode(array('error' => 1, 'message' => 'File does not exist.'));
   }
  */
 }

 async setUploadDownload(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = $f[0]['id'];
   if (SQLNumRows(SQLQuery('SELECT id FROM upload WHERE id = "' . $id . '"')) == '1') SQLQuery('INSERT INTO upload_downloads (id_upload, ip, session, user_agent) VALUES ("' . $id . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async getAdminAdmins(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   if ($_SESSION['admin-login'] == 1) {
    echo SQL2JSON('SELECT id, username, created FROM admins ORDER BY username ASC');
   } else echo json_encode(array('error' => 1, 'message' => 'Admin is not logged in!'));
  */
 }

 async getAdminLog(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   if ($_SESSION['admin-login'] == 1) {
    $o = SQLEscape($_GET['o']);
    $d = SQLEscape($_GET['d']);
    $id = SQLEscape($_GET['id']);
    $count = SQLEscape($_GET['count']);
    $offset = SQLEscape($_GET['offset']);
    $count = (isset($count) && $count != '') ? intval($count) : '18446744073709551615';
    $offset = intval($offset);
    echo SQL2JSON('SELECT l.id, a.username, l.message, l.ip, l.session, l.user_agent, l.created FROM admin_log l, admins a WHERE l.id_admins = a.id' . ($id != '' && $id != '0' ? ' AND a.id = "' . $id . '"' : '') .' ORDER BY ' . ($o != '' ? $o : 'l.created') . ' ' . ($d == 'asc' ? 'ASC' : 'DESC') . ', l.id ' . ($d == 'asc' ? 'ASC' : 'DESC') . ' LIMIT ' . $count . ' OFFSET ' . $offset);
   } else echo json_encode(array('error' => 1, 'message' => 'Admin is not logged in!'));
  */
 }

 async getAdminLogin(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $user = '';
   $pass = '';
   if (!empty($_GET['user'])) $user = SQLEscape(trim($_GET['user']));
   if (!empty($_GET['pass'])) $pass = SQLEscape($_GET['pass']);
   $result = SQLQuery('SELECT id, username FROM admins WHERE username="' . $user . '"');
   if (SQLNumRows($result) == 1) {
    $rows = SQLArray($result)[0];
    $id = $rows['id'];
    $name = $rows['username'];
    $result = SQLQuery('SELECT password FROM admins WHERE username="' . $user . '"');
    $row = mysqli_fetch_assoc($result);
    if ($row['password'] == sha1($pass)) {
     $_SESSION['admin-login'] = true;
     $_SESSION['admin-id'] = $id;
     $_SESSION['admin-name'] = $name;
     echo json_encode(array('error' => 0, 'message' => 'Login OK.'));
    } else echo json_encode(array('error' => 2, 'message' => 'Wrong password!'));
   } else echo json_encode(array('error' => 1, 'message' => 'Wrong user name!'));
  */
 }

 async getAdminSearchStats(p = {}) {
  /*
   require_once('./api_functions.php');
   $o = SQLEscape($_GET['o']);
   $d = SQLEscape($_GET['d']);
   $search = SQLEscape($_GET['search']);
   $count = SQLEscape($_GET['count']);
   $offset = SQLEscape($_GET['offset']);
   $count = (isset($count) && $count != '') ? intval($count) : '18446744073709551615';
   $offset = intval($offset);
   echo SQL2JSON('SELECT phrase, COUNT(phrase) AS count_total, COUNT(DISTINCT session) AS count_session, COUNT(DISTINCT ip) AS count_ip, (SELECT COUNT(*) FROM item WHERE name LIKE CONCAT("%", search.phrase, "%")) AS count_results FROM search ' . ($search != '' ? 'WHERE phrase LIKE "%' . $search .'%" ' : '') . 'GROUP BY phrase ORDER BY ' . ($o != '' ? $o : 'count_total') . ' ' . ($d == 'asc' ? 'ASC' : 'DESC') . ', id ' . ($d == 'asc' ? 'ASC' : 'DESC') . ' LIMIT ' . $count . ' OFFSET ' . $offset);
  */
 }

 async setAdminCategoryDelete(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_GET['id']));
   if ($_SESSION['admin-login'] == 1) {
    if ($id != '') {
     $result = SQLQuery('SELECT id, image FROM category WHERE id = "' . $id . '"');
     if (SQLNumRows($result) == 1) {
      $rows = SQLArray($result);
      $image = trim(SQLEscape($rows[0]['image']));
      $result = SQLQuery('SELECT id FROM item WHERE id_category = "' . $id . '"');
      if (SQLNumRows($result) == 0) {
       require_once('../settings.php');
       $img = '../' . $GLOBALS['path-image-categories'] . '/' . $image;
       if (file_exists($img) && is_file($img)) unlink($img);
       SQLQuery('DELETE FROM category_visits WHERE id_category = "' . $id . '"');
       SQLQuery('DELETE FROM category WHERE id = "' . $id . '"');
       $answer = array('error' => 0, 'message' => 'OK!');
      } else $answer = array('error' => 4, 'message' => 'Cannot delete this category. It still contains items!');
     } else $answer = array('error' => 3, 'message' => 'Category with this ID does not exist!');
    } else $answer = array('error' => 2, 'message' => 'Category ID is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminCategoryEdit(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_POST['id']));
   $name = trim(SQLEscape($_POST['name']));
   $link = trim(SQLEscape($_POST['link']));
   if ($_SESSION['admin-login'] == 1) {
    $result = SQLQuery('SELECT id FROM category WHERE id = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     if ($name != '') {
      if ($link != '') {
       $result = SQLQuery('SELECT name FROM category WHERE name = "' . $name . '" AND id != "' . $id . '"');
       if (SQLNumRows($result) == 0) {
        $result = SQLQuery('SELECT link FROM category WHERE link = "' . $link . '" AND id != "' . $id . '"');
        if (SQLNumRows($result) == 0) {
         SQLQuery('UPDATE category SET name = "' . $name . '", link = "' . $link . '" WHERE id = "' . $id . '"');
         if (count($_FILES) == 1) {
          if ($_FILES['icon']['error'] == 0) {
           if (isImage($_FILES['icon']['type'])) {
            require_once('../settings.php');
            $img_name = $id . '.' . getImageExt($_FILES['icon']['type']);
            move_uploaded_file($_FILES['icon']['tmp_name'], '../' . $GLOBALS['path-image-categories'] . '/' . $img_name);
            SQLQuery('UPDATE category SET image = "' . $img_name . '" WHERE id = "' . $id . '"');
           }
          }
         }
         $answer = array('error' => 0, 'message' => 'OK!');
        } else $answer = array('error' => 6, 'message' => 'Other category with the same link already exists!');
       } else $answer = array('error' => 5, 'message' => 'Other category with the same name already exists!');
      } else $answer = array('error' => 4, 'message' => 'Category link is not set!');  
     } else $answer = array('error' => 3, 'message' => 'Category name is not set!');
    } else $answer = array('error' => 2, 'message' => 'Category ID does not exist!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminCategoryIconDelete(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_GET['id']));
   if ($_SESSION['admin-login'] == 1) {
    if ($id != '') {
     $result = SQLQuery('SELECT id, image FROM category WHERE id = "' . $id . '"');
     if (SQLNumRows($result) == 1) {
      $rows = SQLArray($result);
      require_once('../settings.php');
      $img = '../' . $GLOBALS['path-image-categories'] . '/' . $rows[0]['image'];
      if (file_exists($img) && is_file($img)) unlink($img);
      SQLQuery('UPDATE category SET image = NULL WHERE id = "' . $rows[0]['id'] . '"');
      $answer = array('error' => 0, 'message' => 'OK!');
     } else $answer = array('error' => 3, 'message' => 'Category with this ID does not exist!');
    } else $answer = array('error' => 2, 'message' => 'Category ID is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminCategoryAdd(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $name = trim(SQLEscape($_POST['name']));
   $link = trim(SQLEscape($_POST['link']));
   if ($_SESSION['admin-login'] == 1) {
    if ($name != '') {
     if ($link != '') {
      $result = SQLQuery('SELECT name FROM category WHERE name = "' . $name . '"');
      if (SQLNumRows($result) == 0) {
       $result = SQLQuery('SELECT link FROM category WHERE link = "' . $link . '"');
       if (SQLNumRows($result) == 0) {
        SQLQuery('INSERT INTO category (name, link) VALUES ("' . $name . '", "' . $link . '")');
        if (count($_FILES) == 1) {
         if ($_FILES['icon']['error'] == 0) {
          if (isImage($_FILES['icon']['type'])) {
           $rows = SQLArray(SQLQuery('SELECT id FROM category WHERE link = "' . $link . '"'));
           require_once('../settings.php');
           $img_name = $rows[0]['id'] . '.' . getImageExt($_FILES['icon']['type']);
           move_uploaded_file($_FILES['icon']['tmp_name'], '../' . $GLOBALS['path-image-categories'] . '/' . $img_name);
           SQLQuery('UPDATE category SET image = "' . $img_name . '" WHERE id = "' . $rows[0]['id'] . '"');
          }
         }
        }
        $answer = array('error' => 0, 'message' => 'OK!');
       } else $answer = array('error' => 5, 'message' => 'Category with the same link already exists!');
      } else $answer = array('error' => 4, 'message' => 'Category with the same name already exists!');
     } else $answer = array('error' => 3, 'message' => 'Category link is not set!');  
    } else $answer = array('error' => 2, 'message' => 'Category name is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminDiffsDeleteFilesDB(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   if ($_SESSION['admin-login'] == 1) {
    require_once('../settings.php');
    $filedir = scandir('../' . $GLOBALS['path-files']);
    foreach ($filedir as $f) {
     if (!is_dir('../' . $GLOBALS['path-files'] . '/' . $f)) {
      $rows = SQLQuery('SELECT id FROM file WHERE name = "' . $f . '"');
      if (SQLNumRows($rows) == 0) unlink('../' . $GLOBALS['path-files'] . '/' . $f);
     }
    }
    $answer = array('error' => 0, 'message' => 'OK!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminDiffsDeleteFilesFS(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   if ($_SESSION['admin-login'] == 1) {
    $rows = SQLArray(SQLQuery('SELECT name FROM file'));
    require_once('../settings.php');
    foreach ($rows as $r) {
     $path = '../' . $GLOBALS['path-files'] . '/' . $r['name'];
     if (!file_exists($path)) {
      $rows = SQLArray(SQLQuery('SELECT id FROM file WHERE name = "' . $r['name'] . '"'));
      $id = $rows[0]['id'];
      SQLQuery('DELETE FROM file_downloads WHERE id_file = "' . $id . '"');
      SQLQuery('DELETE FROM file_plays WHERE id_file = "' . $id . '"');
      SQLQuery('DELETE FROM file WHERE id = "' . $id . '"');
     }
    }
    $answer = array('error' => 0, 'message' => 'OK!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminDiffsDeleteUploadsDB(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   if ($_SESSION['admin-login'] == 1) {
    require_once('../settings.php');
    $uploaddir = scandir('../' . $GLOBALS['path-upload']);
    foreach ($uploaddir as $u) {
     if (!is_dir('../' . $GLOBALS['path-upload'] . '/' . $u)) {
      $rows = SQLQuery('SELECT id FROM upload WHERE filename = "' . $u . '"');
      if (SQLNumRows($rows) == 0) unlink('../' . $GLOBALS['path-upload'] . '/' . $u);
     }
    }
    $answer = array('error' => 0, 'message' => 'OK!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminDiffsDeleteUploadsFS(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   if ($_SESSION['admin-login'] == 1) {
    $rows = SQLArray(SQLQuery('SELECT filename FROM upload'));
    require_once('../settings.php');
    foreach ($rows as $r) {
     $path = '../' . $GLOBALS['path-upload'] . '/' . $r['filename'];
     if (!file_exists($path)) {
      $rows = SQLArray(SQLQuery('SELECT id FROM upload WHERE filename = "' . $r['filename'] . '"'));
      $id = $rows[0]['id'];
      SQLQuery('DELETE FROM upload_downloads WHERE id_upload = "' . $id . '"');
      SQLQuery('DELETE FROM upload WHERE id = "' . $id . '"');
     }
    }
    $answer = array('error' => 0, 'message' => 'OK!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminFileDelete(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_GET['id']));
   if ($_SESSION['admin-login'] == 1) {
    if ($id != '') {
     $result = SQLQuery('SELECT id FROM file WHERE id = "' . $id . '"');
     if (SQLNumRows($result) == 1) {
      $result = SQLArray(SQLQuery('SELECT name FROM file WHERE id = "' . $id . '"'));
      require_once('../settings.php');
      $file = '../' . $GLOBALS['path-files'] . '/' . $result[0]['name'];
      if (file_exists($file)) unlink($file);
      SQLQuery('DELETE FROM file_downloads WHERE id_file = "' . $id . '"');
      SQLQuery('DELETE FROM file_plays WHERE id_file = "' . $id . '"');
      SQLQuery('DELETE FROM file_plays_web WHERE id_file = "' . $id . '"');
      SQLQuery('DELETE FROM file WHERE id = "' . $id . '"');
      $answer = array('error' => 0, 'message' => 'OK!');
     } else $answer = array('error' => 3, 'message' => 'File with this ID does not exist!');
    } else $answer = array('error' => 2, 'message' => 'File ID is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminFileEdit(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_POST['id']));
   $name = trim(SQLEscape($_POST['name']));
   $id_item = trim(SQLEscape($_POST['id_item']));
   $playable = trim(SQLEscape($_POST['playable']));
   if ($_SESSION['admin-login'] == 1) {
    $result = SQLQuery('SELECT id FROM file WHERE id = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     if ($name != '') {
      $result = SQLQuery('SELECT id FROM item WHERE id = "' . $id_item . '"');
      if (SQLNumRows($result) == 1) {
       SQLQuery('UPDATE file SET id_item = "' . $id_item . '", filename = "' . $name . '", playable = "' . ($playable == 'on' ? '1' : '0') . '" WHERE id = "' . $id . '"');
       $answer = array('error' => 0, 'message' => 'OK!');
      } else $answer = array('error' => 4, 'message' => 'Item ID does not exist!');  
     } else $answer = array('error' => 3, 'message' => 'File name is not set!');
    } else $answer = array('error' => 2, 'message' => 'File ID does not exist!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminLog(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   //if ($_SESSION['admin-login'] == 1) SQLQuery('INSERT INTO admin_log (id_admins, message, ip, session, user_agent) VALUES ("' . $_SESSION['admin-id'] . '", "' . $message_log . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async setAdminItemDelete(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_GET['id']));
   if ($_SESSION['admin-login'] == 1) {
    if ($id != '') {
     $result = SQLQuery('SELECT id, image, image_sm FROM item WHERE id = "' . $id . '"');
     if (SQLNumRows($result) == 1) {
      $rows = SQLArray($result);
      $image = trim(SQLEscape($rows[0]['image']));
      $image_small = trim(SQLEscape($rows[0]['image_sm']));
      $result = SQLQuery('SELECT id FROM file WHERE id_item = "' . $id . '"');
      if (SQLNumRows($result) == 0) {
       require_once('../settings.php');
       $img = '../' . $GLOBALS['path-image-items'] . '/' . $image;
       $img_small = '../' . $GLOBALS['path-image-items'] . '/' . $image_small;
       if (file_exists($img) && is_file($img)) unlink($img);
       if (file_exists($img_small) && is_file($img_small)) unlink($img_small);
       SQLQuery('DELETE FROM item_visits WHERE id_item = "' . $id . '"');
       SQLQuery('DELETE FROM item WHERE id = "' . $id . '"');
       $answer = array('error' => 0, 'message' => 'OK!');
      } else $answer = array('error' => 4, 'message' => 'Cannot delete this item. It still contains files!');
     } else $answer = array('error' => 3, 'message' => 'Item with this ID does not exist!');
    } else $answer = array('error' => 2, 'message' => 'Item ID is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminItemEdit(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_POST['id']));
   $name = trim(SQLEscape($_POST['name']));
   $link = trim(SQLEscape($_POST['link']));
   $id_category = trim(SQLEscape($_POST['id_category']));
   $id_video = trim(SQLEscape($_POST['id_video']));
   $adult = trim(SQLEscape($_POST['adult']));
   $hidden = trim(SQLEscape($_POST['hidden']));
   if ($_SESSION['admin-login'] == 1) {
    $result = SQLQuery('SELECT id FROM item WHERE id = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     if ($name != '') {
      if ($link != '') {
       $result = SQLQuery('SELECT id FROM category WHERE id = "' . $id_category . '"');
       if (SQLNumRows($result) == 1) {
        $result = SQLQuery('SELECT link FROM item WHERE link = "' . $link . '" AND id != "' . $id . '"');
        if (SQLNumRows($result) == 0) {
         SQLQuery('UPDATE item SET id_category = "' . $id_category . '", name = "' . $name . '", link = "' . $link . '", id_file_video = ' . ($id_video != '' ? '"' . $id_video . '"' : 'NULL') . ', adult = "' . ($adult == 'on' ? '1' : '0') . '", hidden = "' . ($hidden == 'on' ? '1' : '0') . '" WHERE id = "' . $id . '"');
         if (count($_FILES) == 1) {
          if ($_FILES['image']['error'] == 0) {
           if (isImage($_FILES['image']['type'])) {
            require_once('../settings.php');
            $img_name = $id . '.' . getImageExt($_FILES['image']['type']);
            $img_name_sm = $id . '_sm.jpg';
            move_uploaded_file($_FILES['image']['tmp_name'], '../' . $GLOBALS['path-image-items'] . '/' . $img_name);
            makeThumbnail('../' . $GLOBALS['path-image-items'] . '/' . $img_name, '../' . $GLOBALS['path-image-items'] . '/' . $img_name_sm, $GLOBALS['thumbnail-width'], $GLOBALS['thumbnail-quality']);
            SQLQuery('UPDATE item SET image = "' . $img_name . '", image_sm = "' . $img_name_sm . '" WHERE id = "' . $id . '"');
           }
          }
         }
         $answer = array('error' => 0, 'message' => 'OK!');
        } else $answer = array('error' => 6, 'message' => 'Other item with the same link already exists!');
       } else $answer = array('error' => 5, 'message' => 'Category ID does not exist!');  
      } else $answer = array('error' => 4, 'message' => 'Item link is not set!');  
     } else $answer = array('error' => 3, 'message' => 'Item name is not set!');
    } else $answer = array('error' => 2, 'message' => 'Item ID does not exist!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminItemImageDelete(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_GET['id']));
   if ($_SESSION['admin-login'] == 1) {
    if ($id != '') {
     $result = SQLQuery('SELECT id, image, image_sm FROM item WHERE id = "' . $id . '"');
     if (SQLNumRows($result) == 1) {
      $rows = SQLArray($result);
      require_once('../settings.php');
      $img = '../' . $GLOBALS['path-image-items'] . '/' . $rows[0]['image'];
      $img_sm = '../' . $GLOBALS['path-image-items'] . '/' . $rows[0]['image_sm'];
      if (file_exists($img) && is_file($img)) unlink($img);
      if (file_exists($img_sm) && is_file($img_sm)) unlink($img_sm);
      SQLQuery('UPDATE item SET image = NULL, image_sm = NULL WHERE id = "' . $rows[0]['id'] . '"');
      $answer = array('error' => 0, 'message' => 'OK!');
     } else $answer = array('error' => 3, 'message' => 'Item with this ID does not exist!');
    } else $answer = array('error' => 2, 'message' => 'Item ID is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminItemAdd(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $name = trim(SQLEscape($_POST['name']));
   $link = trim(SQLEscape($_POST['link']));
   $id_category = trim(SQLEscape($_POST['id_category']));
   $adult = trim(SQLEscape($_POST['adult']));
   $hidden = trim(SQLEscape($_POST['hidden']));
   if ($_SESSION['admin-login'] == 1) {
    if ($name != '') {
     if ($link != '') {
      $result = SQLQuery('SELECT id FROM category WHERE id = "' . $id_category . '"');
      if (SQLNumRows($result) == 1) {
       $result = SQLQuery('SELECT link FROM item WHERE link = "' . $link . '"');
       if (SQLNumRows($result) == 0) {
        SQLQuery('INSERT INTO item (id_category, name, link, adult, hidden) VALUES ("' . $id_category . '", "' . $name . '", "' . $link . '", "' . ($adult == 'on' ? '1' : '0') . '", "' . ($hidden == 'on' ? '1' : '0') . '")');
        if (count($_FILES) == 1) {
         if ($_FILES['image']['error'] == 0) {
          if (isItemImage($_FILES['image']['type'])) {
           $rows = SQLArray(SQLQuery('SELECT id FROM item WHERE link = "' . $link . '"'));
           require_once('../settings.php');
           $img_name = $rows[0]['id'] . '.' . getItemImageExt($_FILES['image']['type']);
           $img_name_sm = $rows[0]['id'] . '_sm.jpg';
           move_uploaded_file($_FILES['image']['tmp_name'], '../' . $GLOBALS['path-image-items'] . '/' . $img_name);
           makeThumbnail('../' . $GLOBALS['path-image-items'] . '/' . $img_name, '../' . $GLOBALS['path-image-items'] . '/' . $img_name_sm, $GLOBALS['thumbnail-width'], $GLOBALS['thumbnail-quality']);
           SQLQuery('UPDATE item SET image = "' . $img_name . '", image_sm = "' . $img_name_sm . '" WHERE id = "' . $rows[0]['id'] . '"');
          }
         }
        }
        $answer = array('error' => 0, 'message' => 'OK!');
       } else $answer = array('error' => 5, 'message' => 'Item with the same link already exists!');
      } else $answer = array('error' => 4, 'message' => 'Category ID does not exist!');  
     } else $answer = array('error' => 3, 'message' => 'Item link is not set!');  
    } else $answer = array('error' => 2, 'message' => 'Item name is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminUploadDelete(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_GET['id']));
   if ($_SESSION['admin-login'] == 1) {
    if ($id != '') {
     $result = SQLQuery('SELECT id FROM upload WHERE id = "' . $id . '"');
     if (SQLNumRows($result) == 1) {
      $result = SQLArray(SQLQuery('SELECT filename FROM upload WHERE id = "' . $id . '"'));
      require_once('../settings.php');
      $file = '../' . $GLOBALS['path-upload'] . '/' . $result[0]['filename'];
      if (file_exists($file)) unlink($file);
      SQLQuery('DELETE FROM upload_downloads WHERE id_upload = "' . $id . '"');
      SQLQuery('DELETE FROM upload WHERE id = "' . $id . '"');
      $answer = array('error' => 0, 'message' => 'OK!');
     } else $answer = array('error' => 3, 'message' => 'Upload with this ID does not exist!');
    } else $answer = array('error' => 2, 'message' => 'Upload ID is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminUploadEdit(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_POST['id']));
   $name = trim(SQLEscape($_POST['name']));
   if ($_SESSION['admin-login'] == 1) {
    $result = SQLQuery('SELECT id FROM upload WHERE id = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     if ($name != '') {
      SQLQuery('UPDATE upload SET realname = "' . $name . '" WHERE id = "' . $id . '"');
      $answer = array('error' => 0, 'message' => 'OK!');
     } else $answer = array('error' => 3, 'message' => 'Uploaded file name is not set!');
    } else $answer = array('error' => 2, 'message' => 'Uploaded file ID does not exist!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminUploadMove(p = {}) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_POST['id']));
   $id_item = trim(SQLEscape($_POST['id_item']));
   $playable = trim(SQLEscape($_POST['playable']));
   if ($_SESSION['admin-login'] == 1) {
    $result = SQLQuery('SELECT id FROM upload WHERE id = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     $result = SQLQuery('SELECT id FROM item WHERE id = "' . $id_item . '"');
     if (SQLNumRows($result) == 1) {
      require_once('../settings.php');
      $rows = SQLArray(SQLQuery('SELECT id, filename, realname, size, ip, created FROM upload WHERE id = "' . $id . '"'));
      $file = '../' . $GLOBALS['path-upload'] . '/' . $rows[0]['filename'];
      $file_dest = '../' . $GLOBALS['path-files'] . '/' . $rows[0]['filename'];
      if (file_exists($file)) rename($file, $file_dest);
      SQLQuery('INSERT INTO file (id_item, name, filename, size, playable, ip, created) VALUES ("' . $id_item . '", "' . $rows[0]['filename'] . '", "' . $rows[0]['realname'] . '", "' . $rows[0]['size'] . '", "' . ($playable == 'on' ? '1' : '0') . '", "' . $rows[0]['ipa'] . '", "' . $rows[0]['created'] . '")');
      $rows = SQLArray(SQLQuery('SELECT id FROM file WHERE name = "' . $rows[0]['filename'] . '"'));
      $new_id = $rows[0]['id'];
      $rows = SQLArray(SQLQuery('SELECT ip, session, user_agent, created FROM upload_downloads WHERE id_upload = "' . $id . '"'));
      foreach ($rows as $r) {
       SQLQuery('INSERT INTO file_downloads (id_file, ip, session, user_agent, created) VALUES ("' . $new_id . '", "' . $r['ip'] . '", "' . $r['session'] . '", "' . $r['user_agent'] . '", "' . $r['created'] . '")');
      }
      SQLQuery('DELETE FROM upload_downloads WHERE id_upload = "' . $id . '"');
      SQLQuery('DELETE FROM upload WHERE id = "' . $id . '"');
      $answer = array('error' => 0, 'message' => 'OK!');
     } else $answer = array('error' => 3, 'message' => 'Item ID does not exist!');
    } else $answer = array('error' => 2, 'message' => 'Uploaded file ID does not exist!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 /* API FUNCTIONS:
 require_once ('db_settings.php');
 $GLOBALS['conn'] = mysqli_connect($GLOBALS['db_server'], $GLOBALS['db_user'], $GLOBALS['db_pass'], $GLOBALS['db_name']) or die (mysqli_error($GLOBALS['conn']));
 mysqli_set_charset($GLOBALS['conn'], 'utf8');
 $GLOBALS['image_mime'] = array(
  'image/jpeg'    => 'jpg',
  'image/png'     => 'png',
  'image/gif'     => 'gif',
  'image/svg+xml' => 'svg'
 );
 $GLOBALS['image_mime_item'] = array(
  'image/jpeg'    => 'jpg',
  'image/png'     => 'png',
 );

 function getIP() {
  $ip = '';
  if (!empty($_SERVER['HTTP_CLIENT_IP'])) $ip = $_SERVER['HTTP_CLIENT_IP'];
  elseif (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) $ip = $_SERVER['HTTP_X_FORWARDED_FOR'];
  else $ip = $_SERVER['REMOTE_ADDR'];
  return $ip;
 }
  
 function getURIFormat($str) {
  $from = array('À', 'Á', 'Â', 'Ã', 'Ä', 'Å', 'Æ', 'Ç', 'È', 'É', 'Ê', 'Ë', 'Ì', 'Í', 'Î', 'Ï', 'Ð', 'Ñ', 'Ò', 'Ó', 'Ô', 'Õ', 'Ö', 'Ø', 'Ù', 'Ú', 'Û', 'Ü', 'Ý', 'ß', 'à', 'á', 'â', 'ã', 'ä', 'å', 'æ', 'ç', 'è', 'é', 'ê', 'ë', 'ì', 'í', 'î', 'ï', 'ñ', 'ò', 'ó', 'ô', 'õ', 'ö', 'ø', 'ù', 'ú', 'û', 'ü', 'ý', 'ÿ', 'Ā', 'ā', 'Ă', 'ă', 'Ą', 'ą', 'Ć', 'ć', 'Ĉ', 'ĉ', 'Ċ', 'ċ', 'Č', 'č', 'Ď', 'ď', 'Đ', 'đ', 'Ē', 'ē', 'Ĕ', 'ĕ', 'Ė', 'ė', 'Ę', 'ę', 'Ě', 'ě', 'Ĝ', 'ĝ', 'Ğ', 'ğ', 'Ġ', 'ġ', 'Ģ', 'ģ', 'Ĥ', 'ĥ', 'Ħ', 'ħ', 'Ĩ', 'ĩ', 'Ī', 'ī', 'Ĭ', 'ĭ', 'Į', 'į', 'İ', 'ı', 'Ĳ', 'ĳ', 'Ĵ', 'ĵ', 'Ķ', 'ķ', 'Ĺ', 'ĺ', 'Ļ', 'ļ', 'Ľ', 'ľ', 'Ŀ', 'ŀ', 'Ł', 'ł', 'Ń', 'ń', 'Ņ', 'ņ', 'Ň', 'ň', 'ŉ', 'Ō', 'ō', 'Ŏ', 'ŏ', 'Ő', 'ő', 'Œ', 'œ', 'Ŕ', 'ŕ', 'Ŗ', 'ŗ', 'Ř', 'ř', 'Ś', 'ś', 'Ŝ', 'ŝ', 'Ş', 'ş', 'Š', 'š', 'Ţ', 'ţ', 'Ť', 'ť', 'Ŧ', 'ŧ', 'Ũ', 'ũ', 'Ū', 'ū', 'Ŭ', 'ŭ', 'Ů', 'ů', 'Ű', 'ű', 'Ų', 'ų', 'Ŵ', 'ŵ', 'Ŷ', 'ŷ', 'Ÿ', 'Ź', 'ź', 'Ż', 'ż', 'Ž', 'ž', 'ſ', 'ƒ', 'Ơ', 'ơ', 'Ư', 'ư', 'Ǎ', 'ǎ', 'Ǐ', 'ǐ', 'Ǒ', 'ǒ', 'Ǔ', 'ǔ', 'Ǖ', 'ǖ', 'Ǘ', 'ǘ', 'Ǚ', 'ǚ', 'Ǜ', 'ǜ', 'Ǻ', 'ǻ', 'Ǽ', 'ǽ', 'Ǿ', 'ǿ', 'Ά', 'ά', 'Έ', 'έ', 'Ό', 'ό', 'Ώ', 'ώ', 'Ί', 'ί', 'ϊ', 'ΐ', 'Ύ', 'ύ', 'ϋ', 'ΰ', 'Ή', 'ή');
  $to = array('A', 'A', 'A', 'A', 'A', 'A', 'AE', 'C', 'E', 'E', 'E', 'E', 'I', 'I', 'I', 'I', 'D', 'N', 'O', 'O', 'O', 'O', 'O', 'O', 'U', 'U', 'U', 'U', 'Y', 's', 'a', 'a', 'a', 'a', 'a', 'a', 'ae', 'c', 'e', 'e', 'e', 'e', 'i', 'i', 'i', 'i', 'n', 'o', 'o', 'o', 'o', 'o', 'o', 'u', 'u', 'u', 'u', 'y', 'y', 'A', 'a', 'A', 'a', 'A', 'a', 'C', 'c', 'C', 'c', 'C', 'c', 'C', 'c', 'D', 'd', 'D', 'd', 'E', 'e', 'E', 'e', 'E', 'e', 'E', 'e', 'E', 'e', 'G', 'g', 'G', 'g', 'G', 'g', 'G', 'g', 'H', 'h', 'H', 'h', 'I', 'i', 'I', 'i', 'I', 'i', 'I', 'i', 'I', 'i', 'IJ', 'ij', 'J', 'j', 'K', 'k', 'L', 'l', 'L', 'l', 'L', 'l', 'L', 'l', 'l', 'l', 'N', 'n', 'N', 'n', 'N', 'n', 'n', 'O', 'o', 'O', 'o', 'O', 'o', 'OE', 'oe', 'R', 'r', 'R', 'r', 'R', 'r', 'S', 's', 'S', 's', 'S', 's', 'S', 's', 'T', 't', 'T', 't', 'T', 't', 'U', 'u', 'U', 'u', 'U', 'u', 'U', 'u', 'U', 'u', 'U', 'u', 'W', 'w', 'Y', 'y', 'Y', 'Z', 'z', 'Z', 'z', 'Z', 'z', 's', 'f', 'O', 'o', 'U', 'u', 'A', 'a', 'I', 'i', 'O', 'o', 'U', 'u', 'U', 'u', 'U', 'u', 'U', 'u', 'U', 'u', 'A', 'a', 'AE', 'ae', 'O', 'o', 'Α', 'α', 'Ε', 'ε', 'Ο', 'ο', 'Ω', 'ω', 'Ι', 'ι', 'ι', 'ι', 'Υ', 'υ', 'υ', 'υ', 'Η', 'η');
  return trim(preg_replace('/[^\\pL0-9_]+/', '-', strtolower(str_replace($from, $to, $str))), '-');
 }
 
 function makeThumbnail($src, $dest, $desired_width, $quality) { // JEN PRO JPEG, UDELAT I PRO PNG
	$png = mime_content_type($src) == 'image/png' ? true : false;
	$source_image = $png ? imagecreatefrompng($src) : imagecreatefromjpeg($src);
	$width = imagesx($source_image);
	$height = imagesy($source_image);
	$desired_height = floor($height * ($desired_width / $width));
	$virtual_image = imagecreatetruecolor($desired_width, $desired_height);
	imagecopyresampled($virtual_image, $source_image, 0, 0, 0, 0, $desired_width, $desired_height, $width, $height);
	imagejpeg($virtual_image, $dest, $quality);
 }
*/
}

module.exports = API;
