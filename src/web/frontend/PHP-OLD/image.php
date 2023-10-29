<?php
 require_once('./settings.php');
 $image_file = $GLOBALS['path-image-products'] . '/' . $_GET['file'];
 $image_default = $GLOBALS['template-path'] . '/img/item-default.png';
 $file = file_exists($image_file) && is_file($image_file) ? $image_file : $image_default;
 header('Content-Type: ' . mime_content_type($file));
 header('Content-Length: ' . filesize($file));
 echo file_get_contents($file);
?>
