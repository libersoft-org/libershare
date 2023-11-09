<?php
 require_once('../api/set_admin_file_edit');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=file-edit&id=' . $_POST['id'] . '&error=' . urlencode('ID souboru neexistuje!'));
   break;
  case 3:
   header('Location: ./?page=file-edit&id=' . $_POST['id'] . '&error=' . urlencode('Nebyl vyplněn název souboru!'));
   break;
  case 4:
   header('Location: ./?page=file-edit&id=' . $_POST['id'] . '&error=' . urlencode('Zadané ID produktu neexituje!'));
   break;
  default:
   $message_log = 'Upraven soubor - ID: ' . $_POST['id'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=files');
   break;
 }
?>