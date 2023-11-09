<?php
 require_once('../api/set_admin_category_icon_delete');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=category-edit&id=' . $_GET['id'] . '&error=' . urlencode('Nebylo zadáno ID kategorie!'));
   break;
  case 3:
   header('Location: ./?page=category-edit&id=' . $_GET['id'] . '&error=' . urlencode('Kategorie s tímto ID neexistuje!'));
   break;
  default:
   $message_log = 'Smazána ikona kategorie - ID: ' . $_GET['id'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=category-edit&id=' . $_GET['id']);
   break;
 }
?>