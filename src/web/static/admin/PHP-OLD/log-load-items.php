<?php
 if (session_status() == PHP_SESSION_NONE) session_start();
 require_once('../settings.php');
 require_once('../functions.php');
 if ($_SESSION['admin-login']) {
  $page = ($_GET['page'] != '' ? $_GET['page'] : '1');
  $log_template = file_get_contents('template/log-item.html');
  $params = '';
  foreach ($_GET as $k => $v) $params .= '&' . urlencode($k) . '=' . urlencode($v);
  $log = getAPI('api/get_admin_log?count='. $GLOBALS['admin-load-rows'] . '&offset=' . ($page - 1) * $GLOBALS['admin-load-rows'] . $params);
  if ($log != NULL) {
   $log_html = '';
   foreach ($log as $l) {
    $log_array = array(
     '[[name]]'    => $l['username'],
     '[[message]]' => $l['message'],
     '[[ip]]'      => $l['ip'],
     '[[session]]' => $l['session'],
     '[[user-agent]]' => $l['user_agent'],
     '[[created]]' =>  date("j.n.Y H:i:s", strtotime($l['created']))
    );
    $log_html .= html_replace($log_array, $log_template);
   }
   echo $log_html . "\r\n" . file_get_contents('template/table-items-more.html');
  }
 }
?>