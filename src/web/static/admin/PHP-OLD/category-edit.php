<?php
 require_once('../api/set_admin_category_edit');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=category-edit&id=' . $_POST['id'] . '&error=' . urlencode('ID kategorie neexistuje!'));
   break;
  case 3:
   header('Location: ./?page=category-edit&id=' . $_POST['id'] . '&error=' . urlencode('Nebyl vyplněn název kategorie!'));
   break;
  case 4:
   header('Location: ./?page=category-edit&id=' . $_POST['id'] . '&error=' . urlencode('Nebyl vyplněn odkaz kategorie!'));
   break;
  case 5:
   header('Location: ./?page=category-edit&id=' . $_POST['id'] . '&error=' . urlencode('Jiná kategorie se stejným názvem již existuje!'));
   break;
  case 6:
   header('Location: ./?page=category-edit&id=' . $_POST['id'] . '&error=' . urlencode('Jiná kategorie se stejným odkazem již existuje!'));
   break;
  default:
   $message_log = 'Upravena kategorie - ID: ' . $_POST['id'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=categories');
   break;
 }
?>
