<?php
 require_once('../api/set_admin_upload_move');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=upload-move&id=' . $_POST['id'] . '&error=' . urlencode('ID uploadu neexistuje!'));
   break;
  case 3:
   header('Location: ./?page=upload-move&id=' . $_POST['id'] . '&error=' . urlencode('ID produktu neexistuje!'));
   break;
  default:
   $message_log = 'Přesunut upload - ID: ' . $_POST['id'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=uploads');
   break;
 }
?>
