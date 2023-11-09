<?php
 require_once('../api/set_admin_product_edit');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=product-edit&id=' . $_POST['id'] . '&error=' . urlencode('ID produktu neexistuje!'));
   break;
  case 3:
   header('Location: ./?page=product-edit&id=' . $_POST['id'] . '&error=' . urlencode('Nebyl vyplněn název produktu!'));
   break;
  case 4:
   header('Location: ./?page=product-edit&id=' . $_POST['id'] . '&error=' . urlencode('Nebyl vyplněn odkaz produktu!'));
   break;
  case 5:
   header('Location: ./?page=product-edit&id=' . $_POST['id'] . '&error=' . urlencode('Zadané ID kategorie neexituje!'));
   break;
  case 6:
   header('Location: ./?page=product-edit&id=' . $_POST['id'] . '&error=' . urlencode('Jiný produkt se stejným odkazem již existuje!'));
   break;
  default:
   $message_log = 'Upraven produkt - ID: ' . $_POST['id'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=products');
   break;
 }
?>