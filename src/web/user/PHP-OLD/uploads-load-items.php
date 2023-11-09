<?php
 require_once('./settings.php');
 require_once('./functions.php');
 $page = ($_GET['page'] != '' ? $_GET['page'] : '1');
 $file_template = file_get_contents($GLOBALS['template-path'] . '/uploads-file.html');
 $params = '';
 foreach ($_GET as $k => $v) $params .= '&' . urlencode($k) . '=' . urlencode($v);
 $files = getAPI('api/get_uploads?count='. $GLOBALS['upload-load-rows'] . '&offset=' . ($page - 1) * $GLOBALS['upload-load-rows'] . $params);
 if ($files != NULL) {
  $files_html = '';
  foreach ($files as $f) {
   $file_array = array(
    '[[filename]]'      => $f['filename'],
    '[[name]]'          => $f['realname'],
    '[[size]]'          => getHumanSize($f['size']),
    '[[download-link]]' => './download-uploaded.php?id=' . $f['filename'],
   );
   $files_html .= html_replace($file_array, $file_template) . "\r\n";
  }
  echo $files_html . "\r\n" . file_get_contents($GLOBALS['template-path'] . '/uploads-load-more.html');
 }
?>
