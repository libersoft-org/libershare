<?php
 require_once('./settings.php');
 require_once('./functions.php');
 $f = getAPI('api/set_registration_confirmation?id=' . $_GET['id']);
 if ($f['error'] == 1) header('Location: ./aktivace-chyba');
 else header('Location: ./aktivace-ok');
?>
