<?php
 require_once('./settings.php');
 require_once('./functions.php');
 $f = getAPI('api/get_file?id=' . $_GET['id']);
 if ($f['error_id'] == 1) header('Location: ./chyba-soubor-prazdny');
 elseif ($f['error_id'] == 2) header('Location: ./chyba-soubor-nenalezen');
 else {
  $filepath_symlink = $GLOBALS['path-files'] . '/' . $f[0]['name'];
  if (file_exists($filepath_symlink)) {
   require_once('api/set_file_download');
   header('Location: ' . $GLOBALS['url-files'] . 'get.php?id=' . $f[0]['name'] . '&name=' . urlencode($f[0]['filename']));
  } else header('Location: ./chyba-soubor-nenalezen');
 }
?>
