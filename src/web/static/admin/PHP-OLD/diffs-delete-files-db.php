<?php
 require_once('../api/set_admin_diffs_delete_files_db');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  default:
   $message_log = 'Smazány soubory na disku, které chybí v databázi';
   require_once('../api/set_admin_log');
   header('Location: ./?page=diffs');
   break;
 }
?>