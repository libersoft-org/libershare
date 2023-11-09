<?php
 require_once('../api/set_admin_upload_edit');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=upload-edit&id=' . $_POST['id'] . '&error=' . urlencode('ID souboru neexistuje!'));
   break;
  case 3:
   header('Location: ./?page=upload-edit&id=' . $_POST['id'] . '&error=' . urlencode('Nebyl vyplněn název souboru!'));
   break;
  default:
   $message_log = 'Upraven upload - ID: ' . $_POST['id'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=uploads');
   break;
 }
?>
