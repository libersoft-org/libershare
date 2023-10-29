<?php
 require_once('./settings.php');
 require_once('./functions.php');
 $f = getAPI('api/get_file?id=' . $_GET['id']);
 if ($f['error_id'] == 1) {
  header('Location: ./chyba-soubor-prazdny');
 } elseif ($f['error_id'] == 2) {
  header('Location: ./chyba-soubor-nenalezen');
 } else {
  $filepath = $GLOBALS['url-products'] . $f[0]['name'];
  $filepath_symlink = $GLOBALS['path-files'] . '/' . $f[0]['name'];
  if (file_exists($filepath_symlink)) {
   require_once('api/set_file_play');
   header('Content-Disposition: attachment; filename="' . $f[0]['filename'] . '.m3u"');
   header('Content-Type: audio/x-mpegurl');
   echo $GLOBALS['url-files'] . 'get;?id=' . $f[0]['name'] . '&name=' . urlencode($f[0]['filename']);
  } else {
   header('Location: ./chyba-soubor-nenalezen');
  }
 }
?>
