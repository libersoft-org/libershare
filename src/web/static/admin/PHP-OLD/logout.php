<?php
 if (session_status() == PHP_SESSION_NONE) session_start();
 $message_log = 'Odhlášení';
 require_once('../api/set_admin_log');
 if (isset($_SESSION)) session_destroy();
 header('Location: ./');
?>