<?php
 require_once('../api/set_admin_diffs_delete_uploads_fs');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  default:
   $message_log = 'Smazány uploady v databázi, které chybí na disku';
   require_once('../api/set_admin_log');
   header('Location: ./?page=diffs');
   break;
 }
?>