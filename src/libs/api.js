const { Common, validateEmail, checkDate } = require('./common.js');
const Data = require('./data.js');
const { response } = require('express');

const validCaptchas = {};

function cleanupOldCaptchas() {
 const currentTime = new Date().getTime();
 for (const captchaId in validCaptchas) {
  if (currentTime - validCaptchas[captchaId].timestamp > 10 * 60 * 1000) {
   delete validCaptchas[captchaId];
  }
 }
}

setInterval(cleanupOldCaptchas, 60 * 1000);
class API {
 constructor() {
  this.apiMethods = {
   generate_captcha: this.generateCaptcha,
   validate_login: this.validateLogin,
   validate_session: this.isValidSession,
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
   get_products: this.getProducts,
   get_product: this.getProduct,
   get_products_auto_complete: this.getProductsAutoComplete,
   get_products_info: this.getProductsInfo,
   get_uploads: this.getUploads,
   get_uploads_info: this.getUploadsInfo,
   get_upload: this.getUpload,
   get_upload_by_id: this.getUploadByID,
   set_category_visit: this.setCategoryVisit,
   set_contact: this.setContact,
   set_file_download: this.setFileDownload,
   set_file_play: this.setFilePlay,
   set_file_web_play: this.setFileWebPlay,
   set_forum_thread_add: this.setForumThreadAdd,
   set_forum_post_add: this.setForumPostAdd,
   set_product_visit: this.setProductVisit,
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
   set_admin_product_delete: this.setAdminProductDelete,
   set_admin_product_edit: this.setAdminProductEdit,
   set_admin_product_image_delete: this.setAdminProductImageDelete,
   set_admin_product_add: this.setAdminProductAdd,
   set_admin_upload_delete: this.setAdminUploadDelete,
   set_admin_upload_edit: this.setAdminUploadEdit,
   set_admin_upload_move: this.setAdminUploadMove
  };
 }

 async runAPI() {
  this.data = new Data();
  await this.data.dbPrepare();
  this.data.startSessionCleanup();
 }

 async processAPI(name, params) {
  console.log('API request: ', name);
  console.log('Parameters: ', params);
  const method = this.apiMethods[name];
  if (method) return await method.call(this, params);
  else return { error: 1, message: 'API not found' };
 }

 async generateCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz123456789';
  let captchaText = '';
  for (let i = 0; i < 5; i++) {
   captchaText += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  // Generate random colors for SVG
  const randomColor = () => `rgb(${Math.floor(Math.random() * 160)},${Math.floor(Math.random() * 160)},${Math.floor(Math.random() * 160)})`;
  const randomColorL = () => `rgb(${Math.floor(Math.random() * 128 + 128)},${Math.floor(Math.random() * 128 + 128)},${Math.floor(Math.random() * 128 + 128)})`;

  // Generate background dots
  let backgroundDots = '';
  for (let x = 0; x < 120; x += 6) {
   for (let y = 0; y < 40; y += 6) {
    backgroundDots += `<circle cx="${x}" cy="${y}" r="3" fill="${randomColor()}" />`;
   }
  }

  // Generate each letter of the captcha text with a different color and random rotation
  let xPosition = 10; // Starting position adjusted for wider canvas
  let coloredText = '';
  for (let i = 0; i < captchaText.length; i++) {
   const rotation = Math.floor(Math.random() * 30) - 15; // Random rotation between -15 and 15 degrees
   coloredText += `<text x="${xPosition}" y="30" font-family="Arial" font-size="22" font-weight="bold" fill="${randomColorL()}" transform="rotate(${rotation} ${xPosition},30)">${captchaText[i]}</text>`;
   xPosition += 22; // Adjusted spacing for larger font size
  }

  // Generate SVG
  const svg = `
        <svg width="120" height="40" xmlns="http://www.w3.org/2000/svg" style="background-color: gray;">
            <!-- Background Dots -->
            ${backgroundDots}
            <!-- Captcha Text -->
            ${coloredText}
        </svg>
    `;

  // Convert SVG to base64
  const base64Image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

  const captchaId = new Date().getTime() + Math.random().toString(36).substr(2, 9);
  validCaptchas[captchaId] = captchaText;

  return {
   image: base64Image,
   capid: captchaId
  };
 }

 validateCaptcha(key, value) {
  if (validCaptchas.hasOwnProperty(key) && validCaptchas[key] === value) {
   delete validCaptchas[key];
   return true;
  }
  return false;
 }

 async getCategories(params = null) {
  /*
   require_once('./api_functions.php');
   $o = SQLEscape($_GET['o']);
   $d = SQLEscape($_GET['d']);
   $search = SQLEscape($_GET['search']);
   $count = SQLEscape($_GET['count']);
   $offset = SQLEscape($_GET['offset']);
   $count = (isset($count) && $count != '') ? intval($count) : '18446744073709551615';
   $offset = intval($offset);
   $sql = 'SELECT id, name, link, image, (SELECT SUM((SELECT SUM(size) FROM file WHERE id_product = product.id)) FROM product WHERE id_category = category.id) AS size, (SELECT COUNT(*) FROM product WHERE id_category = category.id) AS products_count, (SELECT COUNT(*) FROM product WHERE id_category = category.id AND hidden = 1) AS products_count_hidden, (SELECT COUNT(*) FROM category_visits WHERE id_category = category.id) AS visits, (SELECT COUNT(DISTINCT session) FROM category_visits WHERE id_category = category.id) AS visits_by_session, (SELECT COUNT(DISTINCT ip) FROM category_visits WHERE id_category = category.id) AS visits_by_ip, created FROM category ' . ($search != '' ? ' WHERE MATCH(name) AGAINST ("' . $search .'")' : '') . ($search == '' ? 'ORDER BY ' . ($o != '' ? $o : 'created') . ' ' . ($d == 'desc' ? 'DESC' : 'ASC') . ', id ' . ($d == 'desc' ? 'DESC' : 'ASC') : '') . ' LIMIT ' . $count . ' OFFSET ' . $offset;
   echo SQL2JSON($sql);
  */
  return {
   error: 0,
   data: await this.data.getCategories(params.o, params.d, params.search, params.count, params.offset)
  };
 }

 async getCategoryByID(params = null) {
  /*
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   if ($id != '') {
    $result = SQLQuery('SELECT id, name, link, image, (SELECT COUNT(*) FROM category_visits WHERE id_category = category.id) AS visits, (SELECT COUNT(DISTINCT session) FROM category_visits WHERE id_category = category.id) AS visits_by_session, (SELECT COUNT(DISTINCT ip) FROM category_visits WHERE id_category = category.id) AS visits_by_ip, created FROM category WHERE id = "' . $id . '"');
    if (SQLNumRows($result) == 1) echo json_encode(SQLArray($result));
    else echo json_encode(array('error' => 2, 'message' => 'Category doesn\'t exist'));
   } else echo json_encode(array('error' => 1, 'message' => 'Category ID is empty'));
  */
  if (params.id == null || params.id == '') return { error: 1, message: 'Category ID is empty' };
  const res = await this.data.getCategoryByID(params.id);
  if (res.length == 0) return { error: 2, message: 'Category does not exist' };
  else return { error: 0, data: res };
 }

 async getCategoryByLink(params = null) {
  /*
   require_once('./api_functions.php');
   $link = SQLEscape($_GET['link']);
   if ($link != '') {
    $result = SQLQuery('SELECT id, name, link, image, (SELECT COUNT(*) FROM category_visits WHERE id_category = category.id) AS visits, (SELECT COUNT(DISTINCT session) FROM category_visits WHERE id_category = category.id) AS visits_by_session, (SELECT COUNT(DISTINCT ip) FROM category_visits WHERE id_category = category.id) AS visits_by_ip, created FROM category WHERE link = "' . $link . '"');
    if (SQLNumRows($result) == 1) echo json_encode(SQLArray($result));
    else echo json_encode(array('error' => 2, 'message' => 'Category doesn\'t exist'));
   } else echo json_encode(array('error' => 1, 'message' => 'Category link is empty'));
  */
  if (params.link == null || params.link == '') return { error: 1, message: 'Category link is empty' };
  const res = await this.data.getCategoryByLink(params.link);
  if (res.length == 0) return { error: 2, message: 'Category does not exist' };
  else return { error: 0, data: res };
 }

 async getFileByID(params = null) {
  /*
   require_once('../settings.php');
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   if ($id != '') {
    $result = SQLQuery('SELECT f.id, f.id_product, p.name AS product_name, p.link AS product_link, f.name, f.filename, f.size, f.playable, f.ip, (SELECT COUNT(*) FROM file_downloads WHERE id_file = f.id) AS downloads, (SELECT COUNT(DISTINCT session) FROM file_downloads WHERE id_file = f.id) AS downloads_by_session, (SELECT COUNT(DISTINCT ip) FROM file_downloads WHERE id_file = f.id) AS downloads_by_ip, (SELECT COUNT(*) FROM file_plays WHERE id_file = f.id) AS plays, (SELECT COUNT(DISTINCT session) FROM file_plays WHERE id_file = f.id) AS plays_by_session, (SELECT COUNT(DISTINCT ip) FROM file_plays WHERE id_file = f.id) AS plays_by_ip, f.created FROM file f, product p WHERE f.id_product = p.id AND f.id = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     $arr = SQLArray($result);
     $arr[0]['type'] = mime_content_type('../' . $GLOBALS['path-files'] . '/' . $arr[0]['name']);
     echo json_encode($arr);
    } else echo json_encode(array('error' => 2, 'message' => 'File doesn\'t exist'));
   } else echo json_encode(array('error' => 1, 'message' => 'File ID is empty'));
  */
  if (params.id == null || params.id == '') return { error: 1, message: 'File ID is empty' };
  const res = await data.getFileByID(params.id);
  if (res.length == 0) return { error: 2, message: 'File does not exist' };
  else return { error: 0, data: res };
 }

 async getFile(params = null) {
  /*
   require_once('../settings.php');
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   if ($id != '') {
    $result = SQLQuery('SELECT id, id_product, name, filename, size, playable, ip, (SELECT COUNT(*) FROM file_downloads WHERE id_file = file.id) AS downloads, (SELECT COUNT(DISTINCT session) FROM file_downloads WHERE id_file = file.id) AS downloads_by_session, (SELECT COUNT(DISTINCT ip) FROM file_downloads WHERE id_file = file.id) AS downloads_by_ip, (SELECT COUNT(*) FROM file_plays WHERE id_file = file.id) AS plays, (SELECT COUNT(DISTINCT session) FROM file_plays WHERE id_file = file.id) AS plays_by_session, (SELECT COUNT(DISTINCT ip) FROM file_plays WHERE id_file = file.id) AS plays_by_ip, created FROM file WHERE name = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     $arr = SQLArray($result);
     $arr[0]['type'] = mime_content_type('../' . $GLOBALS['path-files'] . '/' . $arr[0]['name']);
     echo json_encode($arr);
    } else echo json_encode(array('error' => 2, 'message' => 'File doesn\'t exist'));
   } else echo json_encode(array('error' => 1, 'message' => 'File ID is empty'));
  */
  if (params.id == null || params.id == '') return { error: 1, message: 'File ID is empty' };
  const res = await data.getFile(params.id);
  if (res.length != 1) return { error: 2, message: 'File does not exist' };
  else {
   res[0].type = this.getMimeType(path + '/' + res[0].name);
   return { error: 0, data: res };
  }
 }

 async getFiles(params = null) {
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
    $result = SQLQuery('SELECT id FROM product WHERE id = "' . $id . '"');
    if (SQLNumRows($result) != 1) {
     echo json_encode(array('error' => 1, 'message' => 'Product doesn\'t exist'));
     die;
    }
   }
   $sql = 'SELECT f.id, f.name, f.filename, p.id AS product_id, p.name AS product_name, p.link AS product_link, f.size, f.playable, f.ip, (SELECT COUNT(*) FROM file_downloads WHERE id_file = f.id) AS downloads, (SELECT COUNT(DISTINCT session) FROM file_downloads WHERE id_file = f.id) AS downloads_by_session, (SELECT COUNT(DISTINCT ip) FROM file_downloads WHERE id_file = f.id) AS downloads_by_ip, (SELECT COUNT(*) FROM file_plays WHERE id_file = f.id) AS plays, (SELECT COUNT(DISTINCT session) FROM file_plays WHERE id_file = f.id) AS plays_by_session, (SELECT COUNT(DISTINCT ip) FROM file_plays WHERE id_file = f.id) AS plays_by_ip, f.created FROM file f, product p WHERE f.id_product = p.id' . ($id != '' ? ' AND f.id_product = "' . $id . '"' : '') . ($p == '1' || $p == '2' ? ' AND f.playable = "' . ($p == 1 ? '1' : '0') . '"' : '') . ($search != '' ? ' AND MATCH(f.filename) AGAINST ("' . $search .'")' : '') . ($search == '' ? ' ORDER BY ' . ($o != '' ? $o : 'f.created') . ' ' . ($d == 'asc' ? 'ASC' : 'DESC') . ', f.id ' . ($d == 'asc' ? 'ASC' : 'DESC') : '') . ' LIMIT ' . $count . ' OFFSET ' . $offset;
   echo SQL2JSON($sql);
  */
  if (params.id_product == null || params.id_product == '') return { error: 1, message: 'Product ID is empty' };
  if (!(await this.data.getProductExists(params.id_product))) return { error: 2, message: 'Product does not exist' };
  const res = await this.data.getFiles(params.id_product, params.o, params.d, params.p, params.search, params.count, params.offset);
  return { error: 0, data: res };
 }

 async getForumThreads(params = null) {
  /*
   require_once('./api_functions.php');
   $o = SQLEscape($_GET['o']);
   $d = SQLEscape($_GET['d']);
   $count = SQLEscape($_GET['count']);
   $offset = SQLEscape($_GET['offset']);
   $count = (isset($count) && $count != '') ? intval($count) : '18446744073709551615';
   $offset = intval($offset);
   $sql = 'SELECT t.id, t.id_users, u.username, u.sex, t.topic, (SELECT COUNT(*) FROM forum_post WHERE id_forum_thread = t.id) AS posts_count, DATE_FORMAT(t.created , "%e.%c.%Y %H:%i:%s") AS created FROM forum_thread t, users u WHERE u.id = t.id_users ORDER BY ' . ($o != '' ? $o : 't.created') . ' ' . ($d == 'asc' ? 'ASC' : 'DESC') . ', id ' . ($d == 'asc' ? 'ASC' : 'DESC') . ' LIMIT ' . $count . ' OFFSET ' . $offset;
   echo SQL2JSON($sql);
  */
  const res = await this.data.getForumThreads(params.o, params.d, params.count, params.offset);
  return { error: 0, data: res };
 }

 async getForumThread(params = null) {
  /*
   require_once('./api_functions.php');
   $sql = 'SELECT t.id, t.id_users, u.username, u.sex, t.topic, t.body, DATE_FORMAT(t.created , "%e.%c.%Y %H:%i:%s") AS created FROM forum_thread t, users u WHERE u.id = t.id_users AND t.id = "' . SQLEscape($_GET['id']) . '"';
   echo SQL2JSON($sql);
  */
 }

 async getForumPosts(params = null) {
  /*
   require_once('./api_functions.php');
   $sql = 'SELECT p.id, p.id_users, u.username, u.sex, p.body, DATE_FORMAT(p.created , "%e.%c.%Y %H:%i:%s") AS created FROM forum_post p, users u WHERE u.id = p.id_users AND id_forum_thread = "' . SQLEscape($_GET['id']) . '" ORDER BY p.created ASC';
   echo SQL2JSON($sql);
  */
 }

 async getLogin(params = null) {
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

 async getProducts(params = null) {
  /*
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   $o = SQLEscape($_GET['o']);
   $d = SQLEscape($_GET['d']);
   $h = SQLEscape($_GET['h']);
   $a = SQLEscape($_GET['a']);
   $i = SQLEscape($_GET['i']);
   $v = SQLEscape($_GET['v']);
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
     p.id,
     p.name,
     p.link,
     p.id_file_video,
     p.image,
     p.image_sm,
     p.id_category,
     c.name AS category_name,
     c.link AS category_link,
     (SELECT COUNT(*) FROM file WHERE id_product = p.id) AS files,
     p.adult,
     p.hidden,
     (SELECT COUNT(*) FROM product_visits WHERE id_product = p.id) AS visits,
     (SELECT COUNT(DISTINCT session) FROM product_visits WHERE id_product = p.id) AS visits_by_session,
     (SELECT COUNT(DISTINCT ip) FROM product_visits WHERE id_product = p.id) AS visits_by_ip,
     p.created
    FROM product p, category c
    WHERE
     p.id_category = c.id'
     . ($h == '1' || $h == '2' ? ' AND p.hidden = "' . ($h == 1 ? '1' : '0') . '"' : '')
     . ($a == '1' || $a == '2' ? ' AND p.adult = "' . ($a == 1 ? '1' : '0') . '"' : '')
     . ($i == '1' || $i == '2' ? ' AND p.image IS ' . ($i == 1 ? 'NOT NULL' : 'NULL') : '')
     . ($v == '1' || $v == '2' ? ' AND p.id_file_video IS ' . ($v == 1 ? 'NOT NULL' : 'NULL') : '')
     . ($id != '' && $id != '0' ? ' AND p.id_category = "' . $id .'"' : '')
     . ($search != '' ? ' AND MATCH(p.name) AGAINST ("' . $search .'")' : '')
     . ($search == '' ? ' ORDER BY ' . ($o != '' ? $o : 'created') . ' ' . ($d == 'asc' ? 'ASC' : 'DESC') . ', id ' . ($d == 'asc' ? 'ASC' : 'DESC') : '')
     . ' LIMIT ' . $count . ' OFFSET ' . $offset;
   echo SQL2JSON($sql);
  */
  if (params.id_category != null && params.id_category != '' && params.id_category != 0) {
   if (!(await this.data.getCategoryExists(params.id_category))) return { error: 1, message: 'Category does not exist' };
  }
  const res = await this.data.getProducts(params.id_category, params.o, params.d, params.h, params.a, params.i, params.search, params.count, params.offset);
  return { error: 0, data: res };
 }

 async getProduct(params = null) {
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
     (SELECT COUNT(*) FROM products_visits WHERE id_products = products.id) AS visits,
     (SELECT COUNT(DISTINCT session) FROM products_visits WHERE id_products = products.id) AS visits_by_session,
     (SELECT COUNT(DISTINCT ip) FROM products_visits WHERE id_products = products.id) AS visits_by_ip,
     created
    FROM products
    WHERE id = "' . $id . '"' . ($hidden == '1' ? ' AND hidden = 0' : ''));
    if (SQLNumRows($result) == 1) echo json_encode(SQLArray($result));
    else echo json_encode(array('error' => 2, 'message' => 'Product doesn\'t exist'));
   } else echo json_encode(array('error' => 1, 'message' => 'Product ID is empty'));
  */
  const res = await this.data.getProduct(params.id, params.hidden);
  return { error: 0, data: res };
 }

 async getProductsAutoComplete(params = null) {
  /*
   require_once('./api_functions.php');
   $search = SQLEscape($_GET['search']);
   $sql = '
    SELECT
     id,
     name,
     link
    FROM product'
    . ($search != '' ? ' WHERE name LIKE "%' . $search .'%"' : '')
    . ' ORDER BY name ASC LIMIT 20';
   echo SQL2JSON($sql);
  */
 }

 async getProductsInfo(params = null) {
  /*
   require_once('./api_functions.php');
   echo SQL2JSON('
    SELECT
     COUNT(*) AS count,
     (SELECT COUNT(*) FROM product WHERE hidden = 1) AS count_hidden,
     (SELECT COUNT(*) FROM file) AS files_count,
     (SELECT SUM(size) FROM file) AS files_size,
     (SELECT COUNT(*) FROM product_visits) AS visits,
     (SELECT SUM(total)
    FROM
     (SELECT COUNT(DISTINCT session) AS total FROM product_visits GROUP BY id_product) AS visits_session_table) AS visits_session,
     (SELECT SUM(total) FROM (SELECT COUNT(DISTINCT ip) AS total FROM product_visits GROUP BY id_product) AS visits_ip_table) AS visits_ip,
     (SELECT COUNT(*) FROM file_downloads) AS downloads,
     (SELECT SUM(total) FROM (SELECT COUNT(DISTINCT session) AS total FROM file_downloads GROUP BY id_file) AS downloads_session_table) AS downloads_session,
     (SELECT SUM(total) FROM (SELECT COUNT(DISTINCT ip) AS total FROM file_downloads GROUP BY id_file) AS downloads_ip_table) AS downloads_ip,
     (SELECT COUNT(*) FROM file_plays) AS plays,
     (SELECT SUM(total) FROM (SELECT COUNT(DISTINCT session) AS total FROM file_plays GROUP BY id_file) AS plays_session_table) AS plays_session,
     (SELECT SUM(total) FROM (SELECT COUNT(DISTINCT ip) AS total FROM file_plays GROUP BY id_file) AS plays_ip_table) AS plays_ip FROM product');
  */
 }

 async getUploads(params = null) {
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
  const res = await this.data.getUploads(params.o, params.d, params.count, params.offset, params.search);
  return { error: 0, data: res };
 }

 async getUploadsInfo(params = null) {
  /*
   require_once('./api_functions.php');
   echo SQL2JSON('
    SELECT
     COUNT(*) AS count,
     SUM(size) AS size,
     (SELECT COUNT(*) FROM upload_downloads) AS downloads,
     (SELECT COUNT(DISTINCT session) FROM upload_downloads) AS downloads_by_session,
     (SELECT COUNT(DISTINCT ip) FROM upload_downloads) AS downloads_by_ip
    FROM upload');
  */
 }

 async getUpload(params = null) {
  /*
   require_once('./api_functions.php');
   $id = SQLEscape($_GET['id']);
   if ($id != '') {
    $result = SQLQuery('SELECT id, filename, realname, size, ip, (SELECT COUNT(*) FROM upload_downloads WHERE id_upload = upload.id) AS downloads, (SELECT COUNT(DISTINCT session) FROM upload_downloads WHERE id_upload = upload.id) AS downloads_by_session, (SELECT COUNT(DISTINCT ip) FROM upload_downloads WHERE id_upload = upload.id) AS downloads_by_ip, created FROM upload WHERE filename = "' . $id . '"');
    if (SQLNumRows($result) == 1) echo json_encode(SQLArray($result));
    else echo json_encode(array('error' => 2, 'message' => 'File doesn\'t exist'));
   } else echo json_encode(array('error' => 1, 'message' => 'File ID is empty'));
  */
 }

 async getUploadByID(params = null) {
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

 async setCategoryVisit(params = null) {
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

 async setContact(params = null) {
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
         $name_from = $GLOBALS['product'];
         $subject = 'Nová zpráva z formuláře z webu ' . $GLOBALS['product'] . ' - ' . $subject_input;
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

 async setFileDownload(params = null) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = $f[0]['id'];
   if (SQLNumRows(SQLQuery('SELECT id FROM file WHERE id = "' . $id . '"')) == '1') SQLQuery('INSERT INTO file_downloads (id_file, ip, session, user_agent) VALUES ("' . $id . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async setFilePlay(params = null) {
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

 async setFileWebPlay(params = null) {
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

 async setForumThreadAdd(params = null) {
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

 async setForumPostAdd(params = null) {
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

 async setProductVisit(params = null) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = $product[0]['id'];
   if (SQLNumRows(SQLQuery('SELECT id FROM product WHERE id = "' . $id . '"')) == '1')
    SQLQuery('INSERT INTO product_visits
     (id_product, ip, session, user_agent)
    VALUES
     ("' . $id . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async setRegistration(params = null) {
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
  console.log(params);
  if (!this.validateCaptcha(params.cid, params.captcha)) return { error: 1, message: 'Wrong captcha!' };
  return await this.data.setRegistration(params);
 }

 async validateLogin(params) {
  console.log;
  if (!this.validateCaptcha(params.cid, params.captcha)) return { error: 1, message: 'Wrong captcha!' };
  const res = await this.data.validateLogin(params);
  if (res.error) return res;
  return { error: 0, data: res.data };
 }

 async isValidSession(params) {
  // Kontrola existence sessionGuid v databázi
  const resp = await this.data.isValidSession(params.sessionguid);
  if (!resp) return { error: 1, message: 'Session is not valid' };
  return { error: 0, data: params.sessionguid };
 }

 async setRegistrationConfirmation(params = null) {
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

 async setSearch(params = null) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   SQLQuery('INSERT INTO search (phrase, ip, session, user_agent) VALUES ("' . SQLEscape($phrase) . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async setUpload(params = null) {
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
     } else echo json_encode(array('error' => 2, 'message' => 'Nepodařilo se vytvořit nový soubor.'));
    } else echo json_encode(array('error' => 1, 'message' => 'Tento soubor již existuje.'));
   }
   
   function Add($filename) {
    if (file_exists('../' . $GLOBALS['path-upload-temp'] . '/' . $filename)) {
     $data = fopen($_FILES['files']['tmp_name'], 'r');
     file_put_contents('../' . $GLOBALS['path-upload-temp'] . '/' . $filename, $data, FILE_APPEND);
     echo json_encode(array('error' => 0, 'message' => 'OK'));
    } else echo json_encode(array('error' => 1, 'message' => 'Soubor neexistuje.'));
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
         } else echo json_encode(array('error' => 6, 'message' => 'Tento soubor je již v databázi.'));
        } else echo json_encode(array('error' => 5, 'message' => 'Uploadovaný soubor neexistuje.'));
       } else echo json_encode(array('error' => 4, 'message' => 'Nepodařilo se uložit soubor, protože jiný soubor na serveru se stejným jménem již existuje.'));
      } else echo json_encode(array('error' => 3, 'message' => 'Nepodažilo se přesunout nahraný soubor do cílové složky.'));
     } else echo json_encode(array('error' => 2, 'message' => 'Zadané jméno souboru není soubor, ale adresář.'));
    } else echo json_encode(array('error' => 1, 'message' => 'Soubor neexistuje.'));
   }
  */
 }

 async setUploadDownload(params = null) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = $f[0]['id'];
   if (SQLNumRows(SQLQuery('SELECT id FROM upload WHERE id = "' . $id . '"')) == '1') SQLQuery('INSERT INTO upload_downloads (id_upload, ip, session, user_agent) VALUES ("' . $id . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async getAdminAdmins(params = null) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   if ($_SESSION['admin-login'] == 1) {
    echo SQL2JSON('SELECT id, username, created FROM admins ORDER BY username ASC');
   } else echo json_encode(array('error' => 1, 'message' => 'Admin is not logged in!'));
  */
 }

 async getAdminLog(params = null) {
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

 async getAdminLogin(params = null) {
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

 async getAdminSearchStats(params = null) {
  /*
   require_once('./api_functions.php');
   $o = SQLEscape($_GET['o']);
   $d = SQLEscape($_GET['d']);
   $search = SQLEscape($_GET['search']);
   $count = SQLEscape($_GET['count']);
   $offset = SQLEscape($_GET['offset']);
   $count = (isset($count) && $count != '') ? intval($count) : '18446744073709551615';
   $offset = intval($offset);
   echo SQL2JSON('SELECT phrase, COUNT(phrase) AS count_total, COUNT(DISTINCT session) AS count_session, COUNT(DISTINCT ip) AS count_ip, (SELECT COUNT(*) FROM product WHERE name LIKE CONCAT("%", search.phrase, "%")) AS count_results FROM search ' . ($search != '' ? 'WHERE phrase LIKE "%' . $search .'%" ' : '') . 'GROUP BY phrase ORDER BY ' . ($o != '' ? $o : 'count_total') . ' ' . ($d == 'asc' ? 'ASC' : 'DESC') . ', id ' . ($d == 'asc' ? 'ASC' : 'DESC') . ' LIMIT ' . $count . ' OFFSET ' . $offset);
  */
 }

 async setAdminCategoryDelete(params = null) {
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
      $result = SQLQuery('SELECT id FROM product WHERE id_category = "' . $id . '"');
      if (SQLNumRows($result) == 0) {
       require_once('../settings.php');
       $img = '../' . $GLOBALS['path-image-categories'] . '/' . $image;
       if (file_exists($img) && is_file($img)) unlink($img);
       SQLQuery('DELETE FROM category_visits WHERE id_category = "' . $id . '"');
       SQLQuery('DELETE FROM category WHERE id = "' . $id . '"');
       $answer = array('error' => 0, 'message' => 'OK!');
      } else $answer = array('error' => 4, 'message' => 'Cannot delete this category. It still contains products!');
     } else $answer = array('error' => 3, 'message' => 'Category with this ID does not exist!');
    } else $answer = array('error' => 2, 'message' => 'Category ID is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminCategoryEdit(params = null) {
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

 async setAdminCategoryIconDelete(params = null) {
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

 async setAdminCategoryAdd(params = null) {
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

 async setAdminDiffsDeleteFilesDB(params = null) {
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

 async setAdminDiffsDeleteFilesFS(params = null) {
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

 async setAdminDiffsDeleteUploadsDB(params = null) {
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

 async setAdminDiffsDeleteUploadsFS(params = null) {
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

 async setAdminFileDelete(params = null) {
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

 async setAdminFileEdit(params = null) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_POST['id']));
   $name = trim(SQLEscape($_POST['name']));
   $id_product = trim(SQLEscape($_POST['id_product']));
   $playable = trim(SQLEscape($_POST['playable']));
   if ($_SESSION['admin-login'] == 1) {
    $result = SQLQuery('SELECT id FROM file WHERE id = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     if ($name != '') {
      $result = SQLQuery('SELECT id FROM product WHERE id = "' . $id_product . '"');
      if (SQLNumRows($result) == 1) {
       SQLQuery('UPDATE file SET id_product = "' . $id_product . '", filename = "' . $name . '", playable = "' . ($playable == 'on' ? '1' : '0') . '" WHERE id = "' . $id . '"');
       $answer = array('error' => 0, 'message' => 'OK!');
      } else $answer = array('error' => 4, 'message' => 'Product ID does not exist!');  
     } else $answer = array('error' => 3, 'message' => 'File name is not set!');
    } else $answer = array('error' => 2, 'message' => 'File ID does not exist!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminLog(params = null) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   //if ($_SESSION['admin-login'] == 1) SQLQuery('INSERT INTO admin_log (id_admins, message, ip, session, user_agent) VALUES ("' . $_SESSION['admin-id'] . '", "' . $message_log . '", "' . getIP() . '", "' . session_id() . '", "' . (isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '') . '")');
  */
 }

 async setAdminProductDelete(params = null) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_GET['id']));
   if ($_SESSION['admin-login'] == 1) {
    if ($id != '') {
     $result = SQLQuery('SELECT id, image, image_sm FROM product WHERE id = "' . $id . '"');
     if (SQLNumRows($result) == 1) {
      $rows = SQLArray($result);
      $image = trim(SQLEscape($rows[0]['image']));
      $image_small = trim(SQLEscape($rows[0]['image_sm']));
      $result = SQLQuery('SELECT id FROM file WHERE id_product = "' . $id . '"');
      if (SQLNumRows($result) == 0) {
       require_once('../settings.php');
       $img = '../' . $GLOBALS['path-image-products'] . '/' . $image;
       $img_small = '../' . $GLOBALS['path-image-products'] . '/' . $image_small;
       if (file_exists($img) && is_file($img)) unlink($img);
       if (file_exists($img_small) && is_file($img_small)) unlink($img_small);
       SQLQuery('DELETE FROM product_visits WHERE id_product = "' . $id . '"');
       SQLQuery('DELETE FROM product WHERE id = "' . $id . '"');
       $answer = array('error' => 0, 'message' => 'OK!');
      } else $answer = array('error' => 4, 'message' => 'Cannot delete this product. It still contains files!');
     } else $answer = array('error' => 3, 'message' => 'Product with this ID does not exist!');
    } else $answer = array('error' => 2, 'message' => 'Product ID is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminProductEdit(params = null) {
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
    $result = SQLQuery('SELECT id FROM product WHERE id = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     if ($name != '') {
      if ($link != '') {
       $result = SQLQuery('SELECT id FROM category WHERE id = "' . $id_category . '"');
       if (SQLNumRows($result) == 1) {
        $result = SQLQuery('SELECT link FROM product WHERE link = "' . $link . '" AND id != "' . $id . '"');
        if (SQLNumRows($result) == 0) {
         SQLQuery('UPDATE product SET id_category = "' . $id_category . '", name = "' . $name . '", link = "' . $link . '", id_file_video = ' . ($id_video != '' ? '"' . $id_video . '"' : 'NULL') . ', adult = "' . ($adult == 'on' ? '1' : '0') . '", hidden = "' . ($hidden == 'on' ? '1' : '0') . '" WHERE id = "' . $id . '"');
         if (count($_FILES) == 1) {
          if ($_FILES['image']['error'] == 0) {
           if (isImage($_FILES['image']['type'])) {
            require_once('../settings.php');
            $img_name = $id . '.' . getImageExt($_FILES['image']['type']);
            $img_name_sm = $id . '_sm.jpg';
            move_uploaded_file($_FILES['image']['tmp_name'], '../' . $GLOBALS['path-image-products'] . '/' . $img_name);
            makeThumbnail('../' . $GLOBALS['path-image-products'] . '/' . $img_name, '../' . $GLOBALS['path-image-products'] . '/' . $img_name_sm, $GLOBALS['thumbnail-width'], $GLOBALS['thumbnail-quality']);
            SQLQuery('UPDATE product SET image = "' . $img_name . '", image_sm = "' . $img_name_sm . '" WHERE id = "' . $id . '"');
           }
          }
         }
         $answer = array('error' => 0, 'message' => 'OK!');
        } else $answer = array('error' => 6, 'message' => 'Other product with the same link already exists!');
       } else $answer = array('error' => 5, 'message' => 'Category ID does not exist!');  
      } else $answer = array('error' => 4, 'message' => 'Product link is not set!');  
     } else $answer = array('error' => 3, 'message' => 'Product name is not set!');
    } else $answer = array('error' => 2, 'message' => 'Product ID does not exist!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminProductImageDelete(params = null) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_GET['id']));
   if ($_SESSION['admin-login'] == 1) {
    if ($id != '') {
     $result = SQLQuery('SELECT id, image, image_sm FROM product WHERE id = "' . $id . '"');
     if (SQLNumRows($result) == 1) {
      $rows = SQLArray($result);
      require_once('../settings.php');
      $img = '../' . $GLOBALS['path-image-products'] . '/' . $rows[0]['image'];
      $img_sm = '../' . $GLOBALS['path-image-products'] . '/' . $rows[0]['image_sm'];
      if (file_exists($img) && is_file($img)) unlink($img);
      if (file_exists($img_sm) && is_file($img_sm)) unlink($img_sm);
      SQLQuery('UPDATE product SET image = NULL, image_sm = NULL WHERE id = "' . $rows[0]['id'] . '"');
      $answer = array('error' => 0, 'message' => 'OK!');
     } else $answer = array('error' => 3, 'message' => 'Product with this ID does not exist!');
    } else $answer = array('error' => 2, 'message' => 'Product ID is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminProductAdd(params = null) {
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
       $result = SQLQuery('SELECT link FROM product WHERE link = "' . $link . '"');
       if (SQLNumRows($result) == 0) {
        SQLQuery('INSERT INTO product (id_category, name, link, adult, hidden) VALUES ("' . $id_category . '", "' . $name . '", "' . $link . '", "' . ($adult == 'on' ? '1' : '0') . '", "' . ($hidden == 'on' ? '1' : '0') . '")');
        if (count($_FILES) == 1) {
         if ($_FILES['image']['error'] == 0) {
          if (isProductImage($_FILES['image']['type'])) {
           $rows = SQLArray(SQLQuery('SELECT id FROM product WHERE link = "' . $link . '"'));
           require_once('../settings.php');
           $img_name = $rows[0]['id'] . '.' . getProductImageExt($_FILES['image']['type']);
           $img_name_sm = $rows[0]['id'] . '_sm.jpg';
           move_uploaded_file($_FILES['image']['tmp_name'], '../' . $GLOBALS['path-image-products'] . '/' . $img_name);
           makeThumbnail('../' . $GLOBALS['path-image-products'] . '/' . $img_name, '../' . $GLOBALS['path-image-products'] . '/' . $img_name_sm, $GLOBALS['thumbnail-width'], $GLOBALS['thumbnail-quality']);
           SQLQuery('UPDATE product SET image = "' . $img_name . '", image_sm = "' . $img_name_sm . '" WHERE id = "' . $rows[0]['id'] . '"');
          }
         }
        }
        $answer = array('error' => 0, 'message' => 'OK!');
       } else $answer = array('error' => 5, 'message' => 'Product with the same link already exists!');
      } else $answer = array('error' => 4, 'message' => 'Category ID does not exist!');  
     } else $answer = array('error' => 3, 'message' => 'Product link is not set!');  
    } else $answer = array('error' => 2, 'message' => 'Product name is not set!');
   } else $answer = array('error' => 1, 'message' => 'Admin is not logged in!');
  */
 }

 async setAdminUploadDelete(params = null) {
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

 async setAdminUploadEdit(params = null) {
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

 async setAdminUploadMove(params = null) {
  /*
   if (session_status() == PHP_SESSION_NONE) session_start();
   require_once('api_functions.php');
   $id = trim(SQLEscape($_POST['id']));
   $id_product = trim(SQLEscape($_POST['id_product']));
   $playable = trim(SQLEscape($_POST['playable']));
   if ($_SESSION['admin-login'] == 1) {
    $result = SQLQuery('SELECT id FROM upload WHERE id = "' . $id . '"');
    if (SQLNumRows($result) == 1) {
     $result = SQLQuery('SELECT id FROM product WHERE id = "' . $id_product . '"');
     if (SQLNumRows($result) == 1) {
      require_once('../settings.php');
      $rows = SQLArray(SQLQuery('SELECT id, filename, realname, size, ip, created FROM upload WHERE id = "' . $id . '"'));
      $file = '../' . $GLOBALS['path-upload'] . '/' . $rows[0]['filename'];
      $file_dest = '../' . $GLOBALS['path-files'] . '/' . $rows[0]['filename'];
      if (file_exists($file)) rename($file, $file_dest);
      SQLQuery('INSERT INTO file (id_product, name, filename, size, playable, ip, created) VALUES ("' . $id_product . '", "' . $rows[0]['filename'] . '", "' . $rows[0]['realname'] . '", "' . $rows[0]['size'] . '", "' . ($playable == 'on' ? '1' : '0') . '", "' . $rows[0]['ipa'] . '", "' . $rows[0]['created'] . '")');
      $rows = SQLArray(SQLQuery('SELECT id FROM file WHERE name = "' . $rows[0]['filename'] . '"'));
      $new_id = $rows[0]['id'];
      $rows = SQLArray(SQLQuery('SELECT ip, session, user_agent, created FROM upload_downloads WHERE id_upload = "' . $id . '"'));
      foreach ($rows as $r) {
       SQLQuery('INSERT INTO file_downloads (id_file, ip, session, user_agent, created) VALUES ("' . $new_id . '", "' . $r['ip'] . '", "' . $r['session'] . '", "' . $r['user_agent'] . '", "' . $r['created'] . '")');
      }
      SQLQuery('DELETE FROM upload_downloads WHERE id_upload = "' . $id . '"');
      SQLQuery('DELETE FROM upload WHERE id = "' . $id . '"');
      $answer = array('error' => 0, 'message' => 'OK!');
     } else $answer = array('error' => 3, 'message' => 'Product ID does not exist!');
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
 $GLOBALS['image_mime_product'] = array(
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
