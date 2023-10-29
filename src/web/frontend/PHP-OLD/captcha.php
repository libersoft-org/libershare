<?php
 require_once('./settings.php');
 require_once('./functions.php');
 for ($i = 0; $i < 5; $i++) $captcha .= chr(mt_rand(65, 90));
 getCaptchaImage($_GET['code']);
?>
