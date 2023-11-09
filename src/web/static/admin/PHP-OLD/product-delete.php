<?php
 require_once('../api/set_admin_product_delete');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=products&error=' . urlencode('Nebylo zadáno ID produktu!'));
   break;
  case 3:
   header('Location: ./?page=products&error=' . urlencode('Produkt s tímto ID neexistuje!'));
   break;
  case 4:
   header('Location: ./?page=products&error=' . urlencode('Nemohu smazat tento produkt. Stále obsahuje položky souborů!'));
   break;
  default:
   $message_log = 'Smazán produkt - ID: ' . $_GET['id'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=products');
   break;
 }
?>