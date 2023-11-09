<?php
 require_once('../api/set_admin_category_add');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=category-new&error=' . urlencode('Nebyl vyplněn název kategorie!'));
   break;
  case 3:
   header('Location: ./?page=category-new&error=' . urlencode('Nebyl vyplněn odkaz kategorie!'));
   break;
  case 4:
   header('Location: ./?page=category-new&error=' . urlencode('Kategorie se stejným názvem již existuje!'));
   break;
  case 5:
   header('Location: ./?page=category-new&error=' . urlencode('Kategorie se stejným odkazem již existuje!'));
   break;
  default:
   $message_log = 'Vytvořena nová kategorie - ' . $_POST['name'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=categories');
   break;
 }
?>