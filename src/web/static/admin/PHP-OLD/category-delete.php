<?php
 require_once('../api/set_admin_category_delete');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=categories&error=' . urlencode('Nebylo zadáno ID kategorie!'));
   break;
  case 3:
   header('Location: ./?page=categories&error=' . urlencode('Kategorie s tímto ID neexistuje!'));
   break;
  case 4:
   header('Location: ./?page=categories&error=' . urlencode('Nemohu smazat tuto kategorii. Stále obsahuje položky produktů!'));
   break;
  default:
   $message_log = 'Smazána kategorie - ID: ' . $_GET['id'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=categories');
   break;
 }
?>
