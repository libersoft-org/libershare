<?php
 require_once('./settings.php');
 require_once('./functions.php');
 $f = getAPI('api/get_file?id=' . $_GET['id']);
 $filepath_symlink = $GLOBALS['path-files'] . '/' . $f[0]['name'];
 if (file_exists($filepath_symlink)) {
  require_once('api/set_file_web_play');
  header('Location: ' . $GLOBALS['url-files'] . 'get.php?id=' . $f[0]['name'] . '&name=' . urlencode($f[0]['filename']));
 }
?>
