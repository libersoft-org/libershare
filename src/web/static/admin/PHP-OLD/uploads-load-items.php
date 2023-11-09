<?php
 if (session_status() == PHP_SESSION_NONE) session_start();
 require_once('../settings.php');
 require_once('../functions.php');
 if ($_SESSION['admin-login']) {
  $page = ($_GET['page'] != '' ? $_GET['page'] : '1');
  $uploads_template = file_get_contents('template/uploads-item.html');
  $params = '';
  foreach ($_GET as $k => $v) $params .= '&' . urlencode($k) . '=' . urlencode($v);
  $uploads = getAPI('api/get_uploads?count='. $GLOBALS['admin-load-rows'] . '&offset=' . ($page - 1) * $GLOBALS['admin-load-rows'] . $params);
  if ($uploads != NULL) {
   $uploads_html = '';
   foreach ($uploads as $u) {
    $uploads_array = array(
     '[[id]]'                   => $u['id'],
     '[[order]]'                => $_GET['o'],
     '[[sort]]'                 => $_GET['d'],
     '[[name]]'                 => htmlspecialchars($u['realname']),
     '[[escaped-name]]'         => htmlspecialchars(addslashes($u['realname'])),
     '[[size]]'                 => getHumanSize($u['size']),
     '[[ip]]'                   => $u['ip'],
     '[[downloads]]'            => $u['downloads'],
     '[[downloads-by-session]]' => $u['downloads_by_session'],
     '[[downloads-by-ip]]'      => $u['downloads_by_ip'],
     '[[created]]'              => date("j.n.Y H:i:s", strtotime($u['created']))
    );
    $uploads_html .= html_replace($uploads_array, $uploads_template) . "\r\n";
   }
   echo $uploads_html . "\r\n" . file_get_contents('template/table-items-more.html');
  }
 }
?>
