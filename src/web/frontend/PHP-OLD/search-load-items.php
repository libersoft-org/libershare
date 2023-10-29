<?php
 require_once('./settings.php');
 require_once('./functions.php');
 $page = ($_GET['page'] != '' ? $_GET['page'] : '1');
 $product_template = file_get_contents($GLOBALS['template-path'] . '/search-product.html');
 $params = '';
 foreach ($_GET as $k => $v) $params .= '&' . urlencode($k) . '=' . urlencode($v);
 $products = getAPI('api/get_products?count='. $GLOBALS['web-load-rows'] . '&offset=' . ($page - 1) * $GLOBALS['web-load-rows'] . '&h=2' . $params);
 if ($products != NULL) {
  $file_default = $GLOBALS['template-path'] . '/img/item-default.png';
  $file_censored = $GLOBALS['template-path'] . '/img/item-censored.png';
  $products_html = '';
  foreach ($products as $p) {
   $file = $GLOBALS['path-image-products'] . '/' . $p['image_sm'];
   $product_array = array(
    '[[link]]'  => $p['id'] . '-' . $p['link'],
    '[[name]]'  => $p['name'],
    '[[image]]' => $p['adult'] == '0' ? (file_exists($file) && is_file($file) ? $file : $file_default) : $file_censored
   );
   $search_html .= html_replace($product_array, $product_template) . "\r\n";
  }
  echo $search_html . "\r\n" . file_get_contents($GLOBALS['template-path'] . '/search-load-more.html');
 }
?>
