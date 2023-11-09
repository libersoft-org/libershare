<?php
 require_once('../api/set_admin_file_delete');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=files&error=' . urlencode('Nebylo zadáno ID souboru!'));
   break;
  case 3:
   header('Location: ./?page=files&error=' . urlencode('Soubor s tímto ID neexistuje!'));
   break;
  default:
   $message_log = 'Smazán soubor - ID: ' . $_GET['id'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=files');
   break;
 }
?>