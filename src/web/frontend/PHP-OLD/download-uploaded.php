<?php
 require_once('./settings.php');
 require_once('./functions.php');
 $f = getAPI('api/get_upload?id=' . $_GET['id']);
 if ($f['error_id'] == 1) header('Location: ./chyba-soubor-prazdny');
 elseif ($f['error_id'] == 2) header('Location: ./chyba-soubor-nenalezen');
 else {
  $filepath_symlink = $GLOBALS['path-upload'] . '/' . $f[0]['filename'];
  if (file_exists($filepath_symlink)) {
   require_once('api/set_upload_download');
   header('Location: ' . $GLOBALS['url-files'] . 'get-upload.php?id=' . $f[0]['filename'] . '&name=' . urlencode($f[0]['realname']));
  } else header('Location: ./chyba-soubor-nenalezen');
 }
?>
