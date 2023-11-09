<?php
 require_once('./settings.php');
 $filepath = $GLOBALS['path-files'] . '/' . $_GET['id'];
 header('Content-Disposition: attachment; filename="' . $_GET['name'] . '"');
 header('Content-Type: ' . mime_content_type($filepath));
 header('Content-Length: ' . filesize($filepath));
 header('X-Accel-Redirect: /' . $filepath);
?>