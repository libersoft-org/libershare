<?php
 if (session_status() == PHP_SESSION_NONE) session_start();
 require_once('../settings.php');
 require_once('../functions.php');
 if ($_SESSION['admin-login']) {
  $page = ($_GET['page'] != '' ? $_GET['page'] : '1');
  $files_template = file_get_contents('template/files-item.html');
  $params = '';
  foreach ($_GET as $k => $v) $params .= '&' . urlencode($k) . '=' . urlencode($v);
  $files = getAPI('api/get_files?count='. $GLOBALS['admin-load-rows'] . '&offset=' . ($page - 1) * $GLOBALS['admin-load-rows'] . $params);
  if ($files != NULL) {
   $files_html = '';
   foreach ($files as $f) {
    $files_array = array(
     '[[id]]'                   => $f['id'],
     '[[name]]'                 => $f['filename'],
     '[[id_product]]'           => $f['product_id'],
     '[[product_name]]'         => $f['product_name'],
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
   }
   echo $files_html . "\r\n" . file_get_contents('template/table-items-more.html');
  }
 }
?>