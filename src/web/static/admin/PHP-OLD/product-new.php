<?php
 require_once('../api/set_admin_product_add');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=product-new&error=' . urlencode('Nebyl vyplněn název produktu!'));
   break;
  case 3:
   header('Location: ./?page=product-new&error=' . urlencode('Nebyl vyplněn odkaz produktu!'));
   break;
  case 4:
   header('Location: ./?page=product-new&error=' . urlencode('Zadané ID kategorie neexituje!'));
   break;
  case 5:
   header('Location: ./?page=product-new&error=' . urlencode('Produkt se stejným odkazem již existuje!'));
   break;
  default:
   $message_log = 'Vytvořen nový produkt - ' . $_POST['name'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=products');
   break;
 }
?>