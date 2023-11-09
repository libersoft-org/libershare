<?php
 require_once('../api/set_admin_product_image_delete');
 switch ($answer['error_id']) {
  case 1:
   header('Location: ./?error=' . urlencode('Nejste přihlášeni!'));
   break;
  case 2:
   header('Location: ./?page=product-edit&id=' . $_GET['id'] . '&error=' . urlencode('Nebylo zadáno ID produktu!'));
   break;
  case 3:
   header('Location: ./?page=product-edit&id=' . $_GET['id'] . '&error=' . urlencode('Produkt s tímto ID neexistuje!'));
   break;
  default:
   $message_log = 'Smazán obrázek produktu - ID: ' . $_GET['id'];
   require_once('../api/set_admin_log');
   header('Location: ./?page=product-edit&id=' . $_GET['id']);
   break;
 }
?>