<?php
 if (session_status() == PHP_SESSION_NONE) session_start();
 require_once('../settings.php');
 require_once('../functions.php');
 if ($_SESSION['admin-login']) {
  $page = ($_GET['page'] != '' ? $_GET['page'] : '1');
  $products_template = file_get_contents('template/products-item.html');
  $params = '';
  foreach ($_GET as $k => $v) $params .= '&' . urlencode($k) . '=' . urlencode($v);
  $products = getAPI('api/get_products?count='. $GLOBALS['admin-load-rows'] . '&offset=' . ($page - 1) * $GLOBALS['admin-load-rows'] . $params);
  if($products != NULL) {
   $products_html = '';
   foreach ($products as $p) {
    $products_array = array(
     '[[id]]'                => $p['id'],
     '[[name]]'              => $p['name'],
     '[[category-name]]'     => $p['category_name'],
     '[[files]]'             => $p['files'],
     '[[image]]'             => $p['image'] == NULL ? 'no' : 'yes',
     '[[image-alt]]'         => $p['image'] == NULL ? 'Ne' : 'Ano',
     '[[video]]'             => $p['id_file_video'] == NULL ? 'no' : 'yes',
     '[[video-alt]]'         => $p['id_file_video'] == NULL ? 'Ne' : 'Ano',
     '[[adult]]'             => $p['adult'] == '1' ? 'yes' : 'no',
     '[[adult-alt]]'         => $p['adult'] == '1' ? 'Ano' : 'Ne',
     '[[hidden]]'            => $p['hidden'] == '1' ? 'yes' : 'no',
     '[[hidden-alt]]'        => $p['hidden'] == '1' ? 'Ano' : 'Ne',
     '[[visits]]'            => $p['visits'],
     '[[visits-by-session]]' => $p['visits_by_session'],
     '[[visits-by-ip]]'      => $p['visits_by_ip'],
     '[[created]]'           => date("j.n.Y H:i:s", strtotime($p['created']))
    );
    $products_html .= html_replace($products_array, $products_template) . "\r\n";
   }
   echo $products_html . "\r\n" . file_get_contents('template/table-items-more.html');
  }
 }
?>