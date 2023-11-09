<?php
 require_once('./settings.php');
 $filepath = $GLOBALS['path-upload'] . '/' . $_GET['id'];
 header('Content-Disposition: attachment; filename="' . $_GET['name'] . '"');
 header('Content-Type: ' . mime_content_type($filepath));
 header('Content-Length: ' . filesize($filepath));
 readfile($filepath);
?>