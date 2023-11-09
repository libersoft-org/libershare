<?php
 if (session_status() == PHP_SESSION_NONE) session_start();
 require_once('../settings.php');
 require_once('../functions.php');
 if ($_SESSION['admin-login']) {
  $page = ($_GET['page'] != '' ? $_GET['page'] : '1');
  $categories_template = file_get_contents('template/categories-item.html');
  $params = '';
  foreach ($_GET as $k => $v) $params .= '&' . urlencode($k) . '=' . urlencode($v);
  $categories = getAPI('api/get_categories?count='. $GLOBALS['admin-load-rows'] . '&offset=' . ($page - 1) * $GLOBALS['admin-load-rows'] . $params);
  if ($categories != NULL) {
   $categories_html = '';
   foreach ($categories as $c) {
    $categories_array = array(
     '[[id]]'                => $c['id'],
     '[[name]]'              => $c['name'],
     '[[products]]'          => $c['products_count'],
     '[[products-hidden]]'   => $c['products_count_hidden'],
     '[[products-visible]]'  => $c['products_count'] - $c['products_count_hidden'],
     '[[size]]'              => getHumanSize($c['size']),
     '[[visits]]'            => $c['visits'],
     '[[visits-by-session]]' => $c['visits_by_session'],
     '[[visits-by-ip]]'      => $c['visits_by_ip'],
     '[[created]]'           => date("j.n.Y H:i:s", strtotime($c['created']))
    );
    $categories_html .= html_replace($categories_array, $categories_template) . "\r\n";
   }
   echo $categories_html . "\r\n" . file_get_contents('template/table-items-more.html');
  }
 }
?>
