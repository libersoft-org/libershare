<?php
 require_once('../api/set_admin_upload_delete');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=uploads&error=' . urlencode('Nebylo zadáno ID uploadovaného souboru!'));
   break;
  case 3:
   header('Location: ./?page=uploads&error=' . urlencode('Uploadovaný soubor s tímto ID neexistuje!'));
   break;
  default:
   $message_log = 'Smazán upload - ID: ' . $_GET['id'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=uploads&o=' . $_GET['o'] . '&d=' . $_GET['d']);
   break;
 }
?>