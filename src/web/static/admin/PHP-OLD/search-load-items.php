<?php
 if (session_status() == PHP_SESSION_NONE) session_start();
 require_once('../settings.php');
 require_once('../functions.php');
 if ($_SESSION['admin-login']) {
  $page = ($_GET['page'] != '' ? $_GET['page'] : '1');
  $search_template = file_get_contents('template/search-item.html');
  $params = '';
  foreach ($_GET as $k => $v) $params .= '&' . urlencode($k) . '=' . urlencode($v);
  $search = getAPI('api/get_search_stats?count='. $GLOBALS['admin-load-rows'] . '&offset=' . ($page - 1) * $GLOBALS['admin-load-rows'] . $params);
  if ($search != NULL) {
   $search_html = '';
   foreach ($search as $s) {
    $search_array = array(
     '[[phrase]]'        => htmlspecialchars($s['phrase']),
     '[[count]]'         => $s['count_total'],
     '[[count-session]]' => $s['count_session'],
     '[[count-ip]]'      => $s['count_ip'],
     '[[count-results]]' => $s['count_results'],
    );
    $search_html .= html_replace($search_array, $search_template) . "\r\n";
   }
   echo $search_html . "\r\n" . file_get_contents('template/table-items-more.html');
  }
 }
?>