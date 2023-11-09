<?php
 if (session_status() == PHP_SESSION_NONE) session_start();
 require_once('../settings.php');
 require_once('../functions.php');
 getPage();

 function getPage() {
  if (!$_SESSION['admin-login']) {
   $GLOBALS['body'] = file_get_contents('template/login.html');
   $body_array = array(
    '[[template-path]]' => $GLOBALS['template-path'],
    '[[product]]'       => $GLOBALS['product'],
    '[[admin-area]]'    => $GLOBALS['admin-area'],
    '[[year-from]]'     => $GLOBALS['year-from'],
    '[[year-to]]'       => date('Y'),
   );
  } else {
   $GLOBALS['body'] = file_get_contents('template/index.html');
   if (strpos($_GET['page'], '-') !== false) {
    $p = $_GET['page'];
    if     (starts_with($p, 'category-new'))  getCategoryNew();
    elseif (starts_with($p, 'category-edit')) getCategoryEdit();
    elseif (starts_with($p, 'product-new'))   getProductNew();
    elseif (starts_with($p, 'product-edit'))  getProductEdit();
    elseif (starts_with($p, 'file-edit'))     getFileEdit();
    elseif (starts_with($p, 'upload-edit'))   getUploadEdit();
    elseif (starts_with($p, 'upload-move'))   getUploadMove();
    else getStatus();
   } else {
    switch($_GET['page']) {
     case 'categories':
      getCategories();
      break;
     case 'products':
      getProducts();
      break;
     case 'files':
      getFiles();
      break;
     case 'uploads':
      getUploads();
      break;
     case 'diffs':
      getDiffs();
      break;
     case 'search':
      getSearchStats();
      break;
     case 'log':
      getLog();
      break;
     default:
      getStatus();
      break;
    }
   }
   $body_array = array(
    '[[template-path]]'   => $GLOBALS['template-path'],
    '[[product]]'         => $GLOBALS['product'],
    '[[admin-area]]'      => $GLOBALS['admin-area'],
    '[[year-from]]'       => $GLOBALS['year-from'],
    '[[year-to]]'         => date('Y'),
    '[[active-status]]'   => !isset($_GET['page']) ? ' active' : '',
    '[[active-content]]'  => $_GET['page'] == 'categories' || $_GET['page'] == 'products' || $_GET['page'] == 'files' || $_GET['page'] == 'uploads' ? ' active' : '',
    '[[active-diffs]]'    => $_GET['page'] == 'diffs' ? ' active' : '',
    '[[active-search]]'   => $_GET['page'] == 'search' ? ' active' : '',
    '[[active-log]]'      => $_GET['page'] == 'log' ? ' active' : ''
   );
  }
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
  echo $GLOBALS['body'];
 }

 function getStatus() {
  $ram = getRAMUsage();
  $storage = getStorageUsage();
  $storage_template = file_get_contents('template/status-storage.html');
  $storage_html = '';
  $products = getAPI('api/get_products_info');
  $uploads = getAPI('api/get_uploads_info');
  foreach ($storage as $s) {
   $storage_array = array(
    '[[path]]'         => $s['path'],
    '[[used]]'         => getHumanSize($s['used']),
    '[[free]]'         => getHumanSize($s['free']),
    '[[total]]'        => getHumanSize($s['total']),
    '[[used-percent]]' => $s['used-percent'],
   );
   $storage_html .= html_replace($storage_array, $storage_template) . "\r\n";
  }
  $body_array = array(
   '[[title]]'                               => 'Stav serveru',
   '[[content]]'                             => file_get_contents('template/status.html'),
   '[[version-linux]]'                       => php_uname(),
   '[[version-php]]'                         => phpversion(),
   '[[version-mysql]]'                       => getAPI('api/get_mysql_version')['mysql_version'],
   '[[cpu-usage]]'                           => sys_getloadavg()[0] . '%',
   '[[ram-used]]'                            => getHumanSize($ram['used']),
   '[[ram-free]]'                            => getHumanSize($ram['free']),
   '[[ram-total]]'                           => getHumanSize($ram['total']),
   '[[ram-used-percent]]'                    => $ram['used-percent'],
   '[[storage]]'                             => $storage_html,
   '[[products]]'                            => $products[0]['count'],
   '[[products-visible]]'                    => $products[0]['count'] - $products[0]['count_hidden'],
   '[[products-hidden]]'                     => $products[0]['count_hidden'],
   '[[products-files]]'                      => $products[0]['files_count'],
   '[[products-files-size]]'                 => getHumanSize($products[0]['files_size']),
   '[[products-visits]]'                     => $products[0]['visits'],
   '[[products-visits-by-session]]'          => $products[0]['visits_session'],
   '[[products-visits-by-ip]]'               => $products[0]['visits_ip'],
   '[[products-files-downloads]]'            => $products[0]['downloads'],
   '[[products-files-downloads-by-session]]' => $products[0]['downloads_session'],
   '[[products-files-downloads-by-ip]]'      => $products[0]['downloads_ip'],
   '[[products-files-plays]]'                => $products[0]['plays'],
   '[[products-files-plays-by-session]]'     => $products[0]['plays_session'],
   '[[products-files-plays-by-ip]]'          => $products[0]['plays_ip'],
   '[[uploads-count]]'                       => $uploads[0]['count'],
   '[[uploads-size]]'                        => getHumanSize($uploads[0]['size']),
   '[[uploads-downloads]]'                   => $uploads[0]['downloads'],
   '[[uploads-downloads-by-session]]'        => $uploads[0]['downloads_by_session'],
   '[[uploads-downloads-by-ip]]'             => $uploads[0]['downloads_by_ip']
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getCategories() {
  $hidden_template = file_get_contents('template/categories-search.html');
  $hidden_html = '';
  foreach ($_GET as $k => $v) {
   if ($k != 'search') {
    $hidden_array = array(
     '[[name]]'  => $k,
     '[[value]]' => $v
    );
    $hidden_html .= html_replace($hidden_array, $hidden_template) . "\r\n";
   }
  }
  $body_array = array(
   '[[title]]'               => 'Kategorie',
   '[[content]]'             => file_get_contents('template/categories.html'),
   '[[order-name-asc]]'      => getAddress(array('o' => 'name', 'd' => 'asc')),
   '[[order-name-desc]]'     => getAddress(array('o' => 'name', 'd' => 'desc')),
   '[[order-products-asc]]'  => getAddress(array('o' => 'products_count', 'd' => 'asc')),
   '[[order-products-desc]]' => getAddress(array('o' => 'products_count', 'd' => 'desc')),
   '[[order-size-asc]]'      => getAddress(array('o' => 'size', 'd' => 'asc')),
   '[[order-size-desc]]'     => getAddress(array('o' => 'size', 'd' => 'desc')),
   '[[order-visits-asc]]'    => getAddress(array('o' => 'visits', 'd' => 'asc')),
   '[[order-visits-desc]]'   => getAddress(array('o' => 'visits', 'd' => 'desc')),
   '[[order-created-asc]]'   => getAddress(array('o' => 'created', 'd' => 'asc')),
   '[[order-created-desc]]'  => getAddress(array('o' => 'created', 'd' => 'desc')),
   '[[search-values]]'       => $hidden_html,
   '[[phrase]]'              => $_GET['search'],
   '[[params]]'              => 'o: \'' . $_GET['o'] . '\', d: \'' . $_GET['d'] . '\', search: \'' . $_GET['search'] . '\'',
   '[[error]]'               => isset($_GET['error']) ? file_get_contents('template/categories-error.html') : '',
   '[[error_message]]'       => isset($_GET['error']) ? $_GET['error'] : '',
   '[[categories]]'          => file_get_contents('template/table-items-more.html')
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }
 
 function getCategoryNew() {
  $body_array = array(
   '[[title]]'         => 'Nová kategorie',
   '[[content]]'       => file_get_contents('template/category-new.html'),
   '[[error]]'         => isset($_GET['error']) ? file_get_contents('template/category-new-edit-error.html') : '',
   '[[error_message]]' => isset($_GET['error']) ? $_GET['error'] : ''
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getCategoryEdit() {
  $category = getAPI('api/get_category_by_id?id=' . $_GET['id']);
  if (isset($category[0])) {
   $icon = '../' . $GLOBALS['path-image-categories'] . '/' . $category[0]['image'];
   $body_array = array(
    '[[title]]'         => 'Úprava kategorie',
    '[[content]]'       => file_get_contents('template/category-edit.html'),
    '[[icon-edit]]'     => file_exists($icon) && is_file($icon) ? file_get_contents('template/category-edit-icon-show.html') : file_get_contents('template/category-edit-icon-browse.html'),
    '[[id]]'            => $category[0]['id'],
    '[[name]]'          => $category[0]['name'],
    '[[link]]'          => $category[0]['link'],
    '[[error]]'         => isset($_GET['error']) ? file_get_contents('template/category-new-edit-error.html') : '',
    '[[error_message]]' => isset($_GET['error']) ? $_GET['error'] : ''
   );
   if (file_exists($icon) && is_file($icon)) {
    $body_array['[[image]]'] = $icon;
   }
  } else {
   $body_array = array(
    '[[title]]'   => 'Úprava kategorie',
    '[[content]]' => file_get_contents('template/category-error.html'),
   );
  }
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getProducts() {
  $image_name = array('0' => 'Vše', '1' => 'Ano', '2' => 'Ne');
  $video_name = array('0' => 'Vše', '1' => 'Ano', '2' => 'Ne');
  $adult_name = array('0' => 'Vše', '1' => 'Ano', '2' => 'Ne');
  $hidden_name = array('0' => 'Vše', '1' => 'Ano', '2' => 'Ne');
  $categories_template = file_get_contents('template/products-category.html');
  $categories = getAPI('api/get_categories');
  $cat_name = array('0' => 'Vše');
  foreach ($categories as $c) array_push($cat_name, $c['name']);
  $categories_html = '';
  foreach ($categories as $c) {
   $categories_array = array(
    '[[link]]' => getAddress(array('cat' => $c['id'])),
    '[[name]]' => $c['name']
   );
   $categories_html .= html_replace($categories_array, $categories_template) . "\r\n";
  }
  $hidden_template = file_get_contents('template/products-search.html');
  $hidden_html = '';
  foreach ($_GET as $k => $v) {
   if ($k != 'search') {
    $hidden_array = array(
     '[[name]]'  => $k,
     '[[value]]' => $v
    );
    $hidden_html .= html_replace($hidden_array, $hidden_template) . "\r\n";
   }
  }
  $body_array = array(
   '[[title]]'               => 'Produkty',
   '[[content]]'             => file_get_contents('template/products.html'),
   '[[order-name-asc]]'      => getAddress(array('o' => 'name', 'd' => 'asc')),
   '[[order-name-desc]]'     => getAddress(array('o' => 'name', 'd' => 'desc')),
   '[[order-category-asc]]'  => getAddress(array('o' => 'category_name', 'd' => 'asc')),
   '[[order-category-desc]]' => getAddress(array('o' => 'category_name', 'd' => 'desc')),
   '[[order-files-asc]]'     => getAddress(array('o' => 'files', 'd' => 'asc')),
   '[[order-files-desc]]'    => getAddress(array('o' => 'files', 'd' => 'desc')),
   '[[order-image-asc]]'     => getAddress(array('o' => 'image', 'd' => 'asc')),
   '[[order-image-desc]]'    => getAddress(array('o' => 'image', 'd' => 'desc')),
   '[[order-adult-asc]]'     => getAddress(array('o' => 'adult', 'd' => 'asc')),
   '[[order-adult-desc]]'    => getAddress(array('o' => 'adult', 'd' => 'desc')),
   '[[order-hidden-asc]]'    => getAddress(array('o' => 'hidden', 'd' => 'asc')),
   '[[order-hidden-desc]]'   => getAddress(array('o' => 'hidden', 'd' => 'desc')),
   '[[order-visits-asc]]'    => getAddress(array('o' => 'visits', 'd' => 'asc')),
   '[[order-visits-desc]]'   => getAddress(array('o' => 'visits', 'd' => 'desc')),
   '[[order-created-asc]]'   => getAddress(array('o' => 'created', 'd' => 'asc')),
   '[[order-created-desc]]'  => getAddress(array('o' => 'created', 'd' => 'desc')),
   '[[cat-link-all]]'        => getAddress(array('cat' => '0')),
   '[[cat-selected]]'        => ($_GET['cat'] != '' && in_array($_GET['cat'], array_keys($cat_name)) ? $cat_name[$_GET['cat']] : $cat_name['0']),
   '[[adult-link-all]]'      => getAddress(array('adult' => '0')),
   '[[adult-link-yes]]'      => getAddress(array('adult' => '1')),
   '[[adult-link-no]]'       => getAddress(array('adult' => '2')),
   '[[adult-selected]]'      => ($_GET['adult'] != '' && in_array($_GET['adult'], array_keys($adult_name)) ? $adult_name[$_GET['adult']] : $adult_name['0']),
   '[[image-link-all]]'      => getAddress(array('image' => '0')),
   '[[image-link-yes]]'      => getAddress(array('image' => '1')),
   '[[image-link-no]]'       => getAddress(array('image' => '2')),
   '[[image-selected]]'      => ($_GET['image'] != '' && in_array($_GET['image'], array_keys($image_name)) ? $image_name[$_GET['image']] : $image_name['0']),
   '[[video-link-all]]'      => getAddress(array('video' => '0')),
   '[[video-link-yes]]'      => getAddress(array('video' => '1')),
   '[[video-link-no]]'       => getAddress(array('video' => '2')),
   '[[video-selected]]'      => ($_GET['video'] != '' && in_array($_GET['video'], array_keys($video_name)) ? $video_name[$_GET['video']] : $video_name['0']),
   '[[hidden-link-all]]'     => getAddress(array('hidden' => '0')),
   '[[hidden-link-yes]]'     => getAddress(array('hidden' => '1')),
   '[[hidden-link-no]]'      => getAddress(array('hidden' => '2')),
   '[[hidden-selected]]'     => ($_GET['hidden'] != '' && in_array($_GET['hidden'], array_keys($hidden_name)) ? $hidden_name[$_GET['hidden']] : $hidden_name['0']),
   '[[search-values]]'       => $hidden_html,
   '[[phrase]]'              => $_GET['search'],
   '[[params]]'              => 'o: \'' . $_GET['o'] . '\', d: \'' . $_GET['d'] . '\', i: \'' . $_GET['image'] . '\', v: \'' . $_GET['video'] . '\', a: \'' . $_GET['adult'] . '\', h: \'' . $_GET['hidden'] . '\', id: \'' . $_GET['cat'] . '\', search: \'' . $_GET['search'] . '\'',
   '[[error]]'               => isset($_GET['error']) ? file_get_contents('template/products-error.html') : '',
   '[[error_message]]'       => isset($_GET['error']) ? $_GET['error'] : '',
   '[[categories]]'          => $categories_html,
   '[[products]]'            => file_get_contents('template/table-items-more.html')
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getProductNew() {
  $categories_template = file_get_contents('template/product-new-category.html');
  $categories = getAPI('api/get_categories');
  $categories_html = '';
  foreach ($categories as $c) {
   $categories_array = array(
    '[[id]]'   => $c['id'],
    '[[name]]' => $c['name']
   );
   $categories_html .= html_replace($categories_array, $categories_template) . "\r\n";
  }
  $body_array = array(
   '[[title]]'         => 'Nový produkt',
   '[[content]]'       => file_get_contents('template/product-new.html'),
   '[[categories]]'    => $categories_html,
   '[[error]]'         => isset($_GET['error']) ? file_get_contents('template/product-new-edit-error.html') : '',
   '[[error_message]]' => isset($_GET['error']) ? $_GET['error'] : ''
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getProductEdit() {
  $product = getAPI('api/get_product?id=' . $_GET['id']);
  $categories_template = file_get_contents('template/product-edit-category.html');
  $categories = getAPI('api/get_categories');
  $categories_html = '';
  if (isset($product[0])) {
   $files_template = file_get_contents('template/product-edit-files-item.html');
   $videos_template = file_get_contents('template/product-edit-video-item.html');
   $files = getAPI('api/get_files?id=' . $_GET['id']);
   $files_html = '';
   $videos_html = '';
   foreach ($files as $f) {
    $files_array = array(
     '[[id]]'                   => $f['id'],
     '[[name]]'                 => $f['filename'],
     '[[id_product]]'           => $f['product_id'],
     '[[playable]]'             => $f['playable'] == '1' ? 'yes' : 'no',
     '[[playable-alt]]'         => $f['playable'] == '1' ? 'Ano' : 'Ne',
     '[[size]]'                 => getHumanSize($f['size']),
     '[[ip]]'                   => $f['ip'],
     '[[downloads]]'            => $f['downloads'],
     '[[downloads-by-session]]' => $f['downloads_by_session'],
     '[[downloads-by-ip]]'      => $f['downloads_by_ip'],
     '[[plays]]'                => $f['plays'],
     '[[plays-by-session]]'     => $f['plays_by_session'],
     '[[plays-by-ip]]'          => $f['plays_by_ip'],
     '[[created]]'              => date("j.n.Y H:i:s", strtotime($f['created']))
    );
    $files_html .= html_replace($files_array, $files_template) . "\r\n";
    $videos_array = array(
     '[[id]]'       => $f['id'],
     '[[selected]]' => $product[0]['id_file_video'] == $f['id'] ? ' selected' : '',
     '[[name]]'     => $f['filename']
    );
    $videos_html .= html_replace($videos_array, $videos_template) . "\r\n";
   }
   foreach ($categories as $c) {
    $categories_array = array(
     '[[id]]'       => $c['id'],
     '[[name]]'     => $c['name'],
     '[[selected]]' => $product[0]['id_category'] == $c['id'] ? ' selected' : ''
    );
    $categories_html .= html_replace($categories_array, $categories_template) . "\r\n";
   }
   $image = '../' . $GLOBALS['path-image-products'] . '/' . $product[0]['image'];
   $body_array = array(
    '[[title]]'          => 'Úprava produktu',
    '[[content]]'        => file_get_contents('template/product-edit.html'),
    '[[image-edit]]'     => file_exists($image) && is_file($image) ? file_get_contents('template/product-edit-image-show.html') : file_get_contents('template/product-edit-image-browse.html'),
    '[[id]]'             => $product[0]['id'],
    '[[name]]'           => $product[0]['name'],
    '[[link]]'           => $product[0]['link'],
    '[[categories]]'     => $categories_html,
    '[[table-files]]'    => $files_html,
    '[[videos]]'         => $videos_html,
    '[[adult-checked]]'  => $product[0]['adult'] == 1 ? ' checked' : '',
    '[[hidden-checked]]' => $product[0]['hidden'] == 1 ? ' checked' : '',
    '[[error]]'          => isset($_GET['error']) ? file_get_contents('template/product-new-edit-error.html') : '',
    '[[error_message]]'  => isset($_GET['error']) ? $_GET['error'] : ''
   );
   if (file_exists($image) && is_file($image)) {
    $body_array['[[image]]'] = $image;
   }
  } else {
   $body_array = array(
    '[[title]]'   => 'Úprava produktu',
    '[[content]]' => file_get_contents('template/product-error.html'),
   );
  }
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getFiles() {
  $hidden_template = file_get_contents('template/files-search.html');
  $hidden_html = '';
  foreach ($_GET as $k => $v) {
   if ($k != 'search') {
    $hidden_array = array(
     '[[name]]'  => $k,
     '[[value]]' => $v
    );
    $hidden_html .= html_replace($hidden_array, $hidden_template) . "\r\n";
   }
  }
  $playable_name = array('0' => 'Vše', '1' => 'Ano', '2' => 'Ne');
  $body_array = array(
   '[[title]]'                => 'Soubory produktů',
   '[[content]]'              => file_get_contents('template/files.html'),
   '[[order-name-asc]]'       => getAddress(array('o' => 'f.name', 'd' => 'asc')),
   '[[order-name-desc]]'      => getAddress(array('o' => 'f.name', 'd' => 'desc')),
   '[[order-product-asc]]'    => getAddress(array('o' => 'product_name', 'd' => 'asc')),
   '[[order-product-desc]]'   => getAddress(array('o' => 'product_name', 'd' => 'desc')),
   '[[order-playable-asc]]'   => getAddress(array('o' => 'f.playable', 'd' => 'asc')),
   '[[order-playable-desc]]'  => getAddress(array('o' => 'f.playable', 'd' => 'desc')),
   '[[order-size-asc]]'       => getAddress(array('o' => 'f.size', 'd' => 'asc')),
   '[[order-size-desc]]'      => getAddress(array('o' => 'f.size', 'd' => 'desc')),
   '[[order-ip-asc]]'         => getAddress(array('o' => 'f.ip', 'd' => 'asc')),
   '[[order-ip-desc]]'        => getAddress(array('o' => 'f.ip', 'd' => 'desc')),
   '[[order-downloads-asc]]'  => getAddress(array('o' => 'downloads', 'd' => 'asc')),
   '[[order-downloads-desc]]' => getAddress(array('o' => 'downloads', 'd' => 'desc')),
   '[[order-plays-asc]]'      => getAddress(array('o' => 'plays', 'd' => 'asc')),
   '[[order-plays-desc]]'     => getAddress(array('o' => 'plays', 'd' => 'desc')),
   '[[order-created-asc]]'    => getAddress(array('o' => 'f.created', 'd' => 'asc')),
   '[[order-created-desc]]'   => getAddress(array('o' => 'f.created', 'd' => 'desc')),
   '[[playable-link-all]]'    => getAddress(array('playable' => '0')),
   '[[playable-link-yes]]'    => getAddress(array('playable' => '1')),
   '[[playable-link-no]]'     => getAddress(array('playable' => '2')),
   '[[playable-selected]]'    => ($_GET['playable'] != '' && in_array($_GET['playable'], array_keys($playable_name)) ? $playable_name[$_GET['playable']] : $playable_name['0']),
   '[[search-values]]'        => $hidden_html,
   '[[phrase]]'               => $_GET['search'],
   '[[params]]'               => 'o: \'' . $_GET['o'] . '\', d: \'' . $_GET['d'] . '\', p: \'' . $_GET['playable'] . '\', search: \'' . $_GET['search'] . '\'',
   '[[error]]'                => isset($_GET['error']) ? file_get_contents('template/products-error.html') : '',
   '[[error_message]]'        => isset($_GET['error']) ? $_GET['error'] : '',
   '[[files]]'                => file_get_contents('template/table-items-more.html')
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getFileEdit() {
  $f = getAPI('api/get_file_by_id?id=' . $_GET['id']);
  if (isset($f[0])) {
   $body_array = array(
    '[[title]]'         => 'Úprava souboru z produktu',
    '[[content]]'       => file_get_contents('template/file-edit.html'),
    '[[id]]'            => $f[0]['id'],
    '[[id-product]]'    => $f[0]['id_product'],
    '[[name]]'          => $f[0]['filename'],
    '[[product-name]]'  => $f[0]['product_name'],
    '[[playable]]'      => $f[0]['playable'] == '1' ? ' checked' : '',
    '[[size]]'          => getHumanSize($f[0]['size']),
    '[[ip]]'            => $f[0]['ip'],
    '[[link]]'          => $f[0]['name'],
    '[[created]]'       => date("j.n.Y H:i:s", strtotime($f[0]['created'])),
    '[[error]]'         => isset($_GET['error']) ? file_get_contents('template/file-edit-move-error.html') : '',
    '[[error_message]]' => isset($_GET['error']) ? $_GET['error'] : ''
   );
  } else {
   $body_array = array(
    '[[title]]'   => 'Úprava souboru z produktu',
    '[[content]]' => file_get_contents('template/file-error.html'),
   );
  }
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }
 
 function getUploads() {
  $hidden_template = file_get_contents('template/uploads-search.html');
  $hidden_html = '';
  foreach ($_GET as $k => $v) {
   if ($k != 'search') {
    $hidden_array = array(
     '[[name]]'  => $k,
     '[[value]]' => $v
    );
    $hidden_html .= html_replace($hidden_array, $hidden_template) . "\r\n";
   }
  }
  $body_array = array(
   '[[title]]'                => 'Uploady',
   '[[content]]'              => file_get_contents('template/uploads.html'),
   '[[order-name-asc]]'       => getAddress(array('o' => 'realname', 'd' => 'asc')),
   '[[order-name-desc]]'      => getAddress(array('o' => 'realname', 'd' => 'desc')),
   '[[order-size-asc]]'       => getAddress(array('o' => 'size', 'd' => 'asc')),
   '[[order-size-desc]]'      => getAddress(array('o' => 'size', 'd' => 'desc')),
   '[[order-ip-asc]]'         => getAddress(array('o' => 'ip', 'd' => 'asc')),
   '[[order-ip-desc]]'        => getAddress(array('o' => 'ip', 'd' => 'desc')),
   '[[order-downloads-asc]]'  => getAddress(array('o' => 'downloads', 'd' => 'asc')),
   '[[order-downloads-desc]]' => getAddress(array('o' => 'downloads', 'd' => 'desc')),
   '[[order-created-asc]]'    => getAddress(array('o' => 'created', 'd' => 'asc')),
   '[[order-created-desc]]'   => getAddress(array('o' => 'created', 'd' => 'desc')),
   '[[search-values]]'        => $hidden_html,
   '[[phrase]]'               => $_GET['search'],
   '[[params]]'               => 'o: \'' . $_GET['o'] . '\', d: \'' . $_GET['d'] . '\', search: \'' . $_GET['search'] . '\'',
   '[[uploads]]'              => file_get_contents('template/table-items-more.html')
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }
 
 function getUploadEdit() {
  $u = getAPI('api/get_upload_by_id?id=' . $_GET['id']);
  if (isset($u[0])) {
   $body_array = array(
    '[[title]]'         => 'Úprava souboru z uploadu',
    '[[content]]'       => file_get_contents('template/upload-edit.html'),
    '[[id]]'            => $u[0]['id'],
    '[[name]]'          => $u[0]['realname'],
    '[[size]]'          => getHumanSize($u[0]['size']),
    '[[ip]]'            => $u[0]['ip'],
    '[[link]]'          => $u[0]['filename'],
    '[[created]]'       => date("j.n.Y H:i:s", strtotime($u[0]['created'])),
    '[[error]]'         => isset($_GET['error']) ? file_get_contents('template/file-edit-move-error.html') : '',
    '[[error_message]]' => isset($_GET['error']) ? $_GET['error'] : ''
   );
  } else {
   $body_array = array(
    '[[title]]'   => 'Úprava souboru z uploadu',
    '[[content]]' => file_get_contents('template/upload-error.html'),
   );
  }
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getUploadMove() {
  $u = getAPI('api/get_upload_by_id?id=' . $_GET['id']);
  if (isset($u[0])) {
   $body_array = array(
    '[[title]]'         => 'Přesunutí uploadu do produktu',
    '[[content]]'       => file_get_contents('template/upload-move.html'),
    '[[id]]'            => $u[0]['id'],
    '[[name]]'          => $u[0]['realname'],
    '[[size]]'          => getHumanSize($u[0]['size']),
    '[[ip]]'            => $u[0]['ip'],
    '[[link]]'          => $u[0]['filename'],
    '[[created]]'       => date("j.n.Y H:i:s", strtotime($u[0]['created'])),
    '[[error]]'         => isset($_GET['error']) ? file_get_contents('template/file-edit-move-error.html') : '',
    '[[error_message]]' => isset($_GET['error']) ? $_GET['error'] : ''
   );
  } else {
   $body_array = array(
    '[[title]]'   => 'Přesunutí uploadu do produktu',
    '[[content]]' => file_get_contents('template/upload-error.html'),
   );
  }
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getDiffs() {
  $files = getAPI('api/get_files');
  $uploads = getAPI('api/get_uploads');
  $files_fs = array();
  $files_db = array();
  $uploads_fs = array();
  $uploads_db = array();
  $files_fs_html = '';
  $files_db_html = '';
  $uploads_fs_html = '';
  $uploads_db_html = '';
  $diff_item = file_get_contents('template/diffs-item.html');
  foreach ($files as $f) {
   if (!file_exists('../' . $GLOBALS['path-files'] . '/' . $f['name'])) array_push($files_fs, $f);
  }
  $filedir = scandir('../' . $GLOBALS['path-files']);
  foreach ($filedir as $f) {
   if (!is_dir('../' . $GLOBALS['path-files'] . '/' . $f)) {
    $d = getAPI('api/get_file?id=' . $f);
    if (isset($d['error_id'])) array_push($files_db, $f);
   }
  }
  foreach ($uploads as $u) {
   if (!file_exists('../' . $GLOBALS['path-upload'] . '/' . $u['filename'])) array_push($uploads_fs, $u);
  }
  $uploaddir = scandir('../' . $GLOBALS['path-upload']);
  foreach ($uploaddir as $u) {
   if (!is_dir('../' . $GLOBALS['path-upload'] . '/' . $u)) {
    $d = getAPI('api/get_upload?id=' . $u);
    if (isset($d['error_id'])) array_push($uploads_db, $u);
   }
  }
  foreach ($files_fs as $f) {
   $file_array = array(
    '[[name]]' => $f['name'] . ' - ' . $f['filename']
   );
   $files_fs_html .= html_replace($file_array, $diff_item) . "\r\n";
  }
  foreach ($files_db as $f) {
   $file_array = array(
    '[[name]]' => $f
   );
   $files_db_html .= html_replace($file_array, $diff_item) . "\r\n";
  }
  foreach ($uploads_fs as $u) {
   $upload_array = array(
    '[[name]]' => $u['filename'] . ' - ' . $u['realname']
   );
   $uploads_fs_html .= html_replace($upload_array, $diff_item) . "\r\n";
  }
  foreach ($uploads_db as $u) {
   $upload_array = array(
    '[[name]]' => $u
   );
   $uploads_db_html .= html_replace($upload_array, $diff_item) . "\r\n";
  }
  $body_array = array(
   '[[title]]'            => 'Rozdíly DB / FS',
   '[[content]]'          => file_get_contents('template/diffs.html'),
   '[[files-fs]]'         => $files_fs_html,
   '[[files-db]]'         => $files_db_html,
   '[[uploads-fs]]'       => $uploads_fs_html,
   '[[uploads-db]]'       => $uploads_db_html,
   '[[files-fs-count]]'   => count($files_fs),
   '[[files-db-count]]'   => count($files_db),
   '[[uploads-fs-count]]' => count($uploads_fs),
   '[[uploads-db-count]]' => count($uploads_db)
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }
 
 function getSearchStats() {
  $hidden_template = file_get_contents('template/search-search.html');
  $hidden_html = '';
  foreach ($_GET as $k => $v) {
   if ($k != 'search') {
    $hidden_array = array(
     '[[name]]'  => $k,
     '[[value]]' => $v
    );
    $hidden_html .= html_replace($hidden_array, $hidden_template) . "\r\n";
   }
  }
  $body_array = array(
   '[[title]]'                          => 'Statistika hledání',
   '[[content]]'                        => file_get_contents('template/search.html'),
   '[[order-phrase-asc]]'               => getAddress(array('o' => 'phrase', 'd' => 'asc')),
   '[[order-phrase-desc]]'              => getAddress(array('o' => 'phrase', 'd' => 'desc')),
   '[[order-searches-asc]]'             => getAddress(array('o' => 'count_total', 'd' => 'asc')),
   '[[order-searches-desc]]'            => getAddress(array('o' => 'count_total', 'd' => 'desc')),
   '[[order-searches-by-session-asc]]'  => getAddress(array('o' => 'count_session', 'd' => 'asc')),
   '[[order-searches-by-session-desc]]' => getAddress(array('o' => 'count_session', 'd' => 'desc')),
   '[[order-searches-by-ip-asc]]'       => getAddress(array('o' => 'count_ip', 'd' => 'asc')),
   '[[order-searches-by-ip-desc]]'      => getAddress(array('o' => 'count_ip', 'd' => 'desc')),
   '[[order-results-asc]]'              => getAddress(array('o' => 'count_results', 'd' => 'asc')),
   '[[order-results-desc]]'             => getAddress(array('o' => 'count_results', 'd' => 'desc')),
   '[[search-values]]'                  => $hidden_html,
   '[[phrase]]'                         => $_GET['search'],
   '[[params]]'                         => 'o: \'' . $_GET['o'] . '\', d: \'' . $_GET['d'] . '\', search: \'' . $_GET['search'] . '\'',
   '[[table-search]]'                   => file_get_contents('template/table-items-more.html')
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getLog() {
  $admins = getAPI('api/get_admin_admins');
  $admins_template = file_get_contents('template/log-admin.html');
  $admin_name = array('0' => 'Všichni');
  foreach ($admins as $a) array_push($admin_name, $a['username']);
  $admins_html = '';
  foreach ($admins as $a) {
   $admins_array = array(
    '[[link]]' => getAddress(array('id' => $a['id'])),
    '[[name]]' => $a['username']
   );
   $admins_html .= html_replace($admins_array, $admins_template) . "\r\n";
  }
  
  $body_array = array(
   '[[title]]'                => 'Log',
   '[[content]]'              => file_get_contents('template/log.html'),
   '[[order-name-asc]]'       => getAddress(array('o' => 'a.username', 'd' => 'asc')),
   '[[order-name-desc]]'      => getAddress(array('o' => 'a.username', 'd' => 'desc')),
   '[[order-message-asc]]'    => getAddress(array('o' => 'l.message', 'd' => 'asc')),
   '[[order-message-desc]]'   => getAddress(array('o' => 'l.message', 'd' => 'desc')),
   '[[order-ip-asc]]'         => getAddress(array('o' => 'l.ip', 'd' => 'asc')),
   '[[order-ip-desc]]'        => getAddress(array('o' => 'l.ip', 'd' => 'desc')),
   '[[order-session-asc]]'    => getAddress(array('o' => 'l.session', 'd' => 'asc')),
   '[[order-session-desc]]'   => getAddress(array('o' => 'l.session', 'd' => 'desc')),
   '[[order-useragent-asc]]'  => getAddress(array('o' => 'l.user_agent', 'd' => 'asc')),
   '[[order-useragent-desc]]' => getAddress(array('o' => 'l.user_agent', 'd' => 'desc')),
   '[[order-created-asc]]'    => getAddress(array('o' => 'l.created', 'd' => 'asc')),
   '[[order-created-desc]]'   => getAddress(array('o' => 'l.created', 'd' => 'desc')),
   '[[admin-link-all]]'       => getAddress(array('id' => '0')),
   '[[admin-selected]]'       => ($_GET['id'] != '' && in_array($_GET['id'], array_keys($admin_name)) ? $admin_name[$_GET['id']] : $admin_name['0']),
   '[[params]]'               => 'o: \'' . $_GET['o'] . '\', d: \'' . $_GET['d'] . '\', id: \'' . $_GET['id'] . '\'',
   '[[admins]]'               => $admins_html,
   '[[table-log]]'            => file_get_contents('template/table-items-more.html')
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }
?>