<?php
 if (session_status() == PHP_SESSION_NONE) session_start();
 require_once('./settings.php');
 require_once('./functions.php');
 getPage();

 function getPage() {
  $GLOBALS['body'] = file_get_contents('index.html');
  if (strpos($_GET['page'], '-') !== false) {
   $page = substr($_GET['page'], 0, strpos($_GET['page'], '-'));
   $link = substr($_GET['page'], strpos($_GET['page'], '-') + 1);
   switch ($page) {
    case 'detail':
     $id = substr($link, 0, strpos($link, '-'));
     getProduct($id);
     break;
    case 'kategorie':
     getCategory($link);
     break;
    case 'chyba':
     getError($link);
     break;
    case 'registrace':
     getRegistrationDone($link);
     break;
    case 'email':
     getEmailSent($link == 'odeslan' ? true : false);
     break;
    case 'diskuze':
     getForumAction($link);
     break;
    case 'aktivace':
     getRegistrationConfirmation($link);
     break;
    default:
     getNews();
     break;
   }
  } else {
   switch($_GET['page']) {
    case '':
     getNews();
    case 'upload':
     getUpload();
     break;
    case 'uploady':
     getUploads();
     break;
    case 'hledat':
     getSearch();
     break;
    case 'faq':
     getFAQ();
     break;
    case 'podminky':
     getTerms();
     break;
    case 'kontakt':
     getContact();
     break;
    case 'registrace':
     getRegistration();
     break;
    case 'diskuze':
     getForum();
     break;
    default:
     getHomePage();
     exit;
   }
  }
  $body_array = array(
   '[[og-url]]'                => (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? 'https' : 'http') . '://' . $_SERVER['HTTP_HOST'] . $_SERVER['REQUEST_URI'],
   '[[og-image]]'              => 'img/item-default.png',
   '[[og-description]]'        => 'Share your videos for free on ' . $GLOBALS['product'] . '!',
   '[[login]]'                 => isset($_SESSION['login-id']) ? file_get_contents('index-logout.html') : file_get_contents('index-login.html'),
   '[[login-username]]'        => isset($_SESSION['login-user']) ? $_SESSION['login-user'] : '',
   '[[active-news]]'           => $_GET['page'] == '' ? ' active' : '',
   '[[active-categories]]'     => substr($_GET['page'], 0, strpos($_GET['page'], '-')) == 'kategorie' ? ' active' : '',
   '[[active-upload]]'         => $_GET['page'] == 'upload' ? ' active' : '',
   '[[active-forum]]'          => $_GET['page'] == 'diskuze' ? ' active' : '',
   '[[active-registration]]'   => $_GET['page'] == 'registration' ? ' active' : '',
   '[[active-login]]'          => $_GET['page'] == 'login' ? ' active' : '',
   '[[active-logout]]'         => $_GET['page'] == 'logout' ? ' active' : '',
   '[[path-image-categories]]' => $GLOBALS['path-image-categories'],
   '[[phrase-search]]'         => '',
   '[[url]]'                   => $GLOBALS['url'] . substr($_SERVER['REQUEST_URI'], 1),
   '[[product]]'               => $GLOBALS['product'],
   '[[year-from]]'             => $GLOBALS['year-from'],
   '[[year-to]]'               => date('Y'),
   '[[analytics]]'             => file_get_contents('/analytics.html'),
   '[[analytics-id]]'          => $GLOBALS['analytics-id'],
   '[[toplist]]'               => file_get_contents('/toplist.html'),
   '[[toplist-id]]'            => $GLOBALS['toplist-id'],
   '[[recaptcha]]'             => file_get_contents('/recaptcha.html')
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
  echo $GLOBALS['body'];
 }

 function getNews() {
  $news_template = file_get_contents('/news.html');
  $body_array = array(
   '[[title]]'    => 'Novinky',
   '[[content]]'  => $news_template
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getProduct($id) {
  $product_template = file_get_contents('product.html');
  $file_template = file_get_contents('product-file.html');
  $product = getAPI('get_product?id=' . $id . '&hidden=1');
  if ($product['error_id'] == 1) header('Location: ./chyba-produkt-prazdny');
  elseif ($product['error_id'] == 2) header('Location: ./chyba-produkt-nenalezen');
  else {
   $category = getAPI('get_category_by_id?id=' . $product[0]['id_category']);
   $files = getAPI('get_files?id=' . $product[0]['id'] . '&o=filename');
   $image = $GLOBALS['path-image-products'] . '/' . $product[0]['image'];
   $image_default = 'img/item-default.png';
   $image_censored = 'img/item-censored.png';
   $image_file = file_exists($image) && is_file($image) ? $image : $image_default;
   foreach ($files as $f) {
    $file_array = array(
     '[[name]]'          => $f['name'],
     '[[size]]'          => getHumanSize($f['size']),
     '[[filename]]'      => $f['filename'],
     '[[download-link]]' => isset($_SESSION['login-id']) ? 'getDownload(\'' . $f['name'] . '\')' : 'getLoginModal()', 
     '[[play-online]]'   => $f['playable'] == 1 ? file_get_contents('product-play-button.html') : '',
     '[[play-link]]'     => isset($_SESSION['login-id']) ? 'getPlayOnline(\'' . $f['name'] . '\')' : 'getLoginModal()',
    );
    $files_html .= html_replace($file_array, $file_template) . "\r\n";
   }
   $image_template = file_get_contents('product-image.html');
   $image_array = array(
    '[[image]]' => $image_file,
    '[[name]]'  => $product[0]['name'],
   );
   $image_html = html_replace($image_array, $image_template);
   $video_template = file_get_contents('product-video.html');
   $video_html = '';
   $video_array = array();
   if ($product[0]['id_file_video'] != '') {
    $file = getAPI('get_file_by_id?id=' . $product[0]['id_file_video']);
    $video_array = array(
     '[[video-link]]'    => isset($_SESSION['login-id']) ? 'getVideo(\'./play_web.php?id=' . $file[0]['name'] . '\', \'' . $file[0]['type'] . '\')' : 'getLoginModal()',
     '[[image]]' => $image_file,
    );
   $video_html = html_replace($video_array, $video_template);
   }
   $product_array = array(
    '[[name]]'          => $product[0]['name'],
    '[[category]]'      => $category[0]['name'],
    '[[category-link]]' => $category[0]['link'],
    '[[image]]'         => $product[0]['id_file_video'] != '' ? $video_html : $image_html,
    '[[fb-share-link]]' => 'https://www.facebook.com/sharer.php?u=' . urlencode((isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? 'https' : 'http') . '://' . $_SERVER['HTTP_HOST'] . $_SERVER['REQUEST_URI']),
    '[[table]]'         => $files_html
   );
   $product_template = html_replace($product_array, $product_template);
   $body_array = array(
    '[[og-image]]' => $product[0]['adult'] == '0' ? $GLOBALS['url'] . $image_file : $GLOBALS['url'] . $image_censored,
    '[[title]]'    => $product[0]['name'],
    '[[content]]'  => $product_template
   );
   $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
   require_once('set_product_visit');
  }
 }

 function getUpload() {
  $body_array = array(
   '[[title]]'   => 'Upload',
   '[[content]]' => file_get_contents('upload.html'),
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getUploads() {
  $uploads_template = file_get_contents('uploads.html');
  $body_array = array(
   '[[title]]'            => 'Uploady',
   '[[content]]'          => $uploads_template,
   '[[upload-load-rows]]' => $GLOBALS['upload-load-rows']
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getCategory($link) {
  $category_template = file_get_contents('category.html');
  $category = getAPI('get_category_by_link?link=' . $link);
  $body_array = array(
   '[[title]]'         => $category[0]['name'],
   '[[content]]'       => $category_template,
   '[[link]]'          => $link,
   '[[category]]'      => $category[0]['name'] == '' ? 'Vše' : $category[0]['name'],
   '[[product-count]]' => $GLOBALS['web-load-rows']
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
  require_once('set_category_visit');
 }

 function getSearch() {
  $phrase = trim(preg_replace('/\s\s+/', ' ', $_POST['phrase']));
  if ($phrase == NULL || strlen($phrase) == 0) {
   $search_template = file_get_contents('search-no-phrase.html');
   $body_array = array(
    '[[title]]'   => 'Vyhledávání - chyba',
    '[[content]]' => $search_template
   );
  } else {
   require_once('set_search');
   $search_template = file_get_contents('search.html');
   $body_array = array(
    '[[title]]'         => 'Vyhledávání - ' . htmlspecialchars($phrase),
    '[[content]]'       => $search_template,
    '[[phrase]]'        => htmlspecialchars($phrase),
    '[[phrase-search]]' => $phrase,
    '[[product-count]]' => $GLOBALS['web-load-rows']
   );
  }
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getFAQ() {
  $body_array = array(
   '[[title]]'    => 'Často kladené dotazy (FAQ)',
   '[[content]]'  => file_get_contents('faq.html'),
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getTerms() {
  $body_array = array(
   '[[title]]'    => 'Podmínky užívání',
   '[[content]]'  => file_get_contents('terms.html')
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getContact() {
  $body_array = array(
   '[[title]]'    => 'Kontakt',
   '[[content]]'  => file_get_contents('contact.html')
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getRegistration() {
  //print_r($_SESSION);
  $registration_template = file_get_contents('registration.html');
  $registration_date_template = file_get_contents('registration-date.html');
  $days_html = '';
  for ($i = 1; $i <= 31; $i++) {
   $day_array = array(
    '[[value]]' => $i,
    '[[label]]' => $i
   );
   $day_html = html_replace($day_array, $registration_date_template);
   $days_html .= $day_html . "\r\n";
  }
  $months_html = '';
  $months_array = array(
   '1' => 'Leden',
   '2' => 'Únor',
   '3' => 'Březen',
   '4' => 'Duben',
   '5' => 'Květen',
   '6' => 'Červen',
   '7' => 'Červenec',
   '8' => 'Srpen',
   '9' => 'Září',
   '10' => 'Říjen',
   '11' => 'Listopad',
   '12' => 'Prosinec'
  );
  foreach ($months_array as $k => $v) {
   $month_array = array(
    '[[value]]' => $k,
    '[[label]]' => $v
   );
   $month_html = html_replace($month_array, $registration_date_template);
   $months_html .= $month_html . "\r\n";
  }
  $years_html = '';
  for ($i = date('Y'); $i >= 1900; $i--) {
   $year_array = array(
    '[[value]]' => $i,
    '[[label]]' => $i
   );
   $year_html = html_replace($year_array, $registration_date_template);
   $years_html .= $year_html . "\r\n";
  }
  $registration_array = array(
   '[[days]]'   => $days_html,
   '[[months]]' => $months_html,
   '[[years]]'  => $years_html,
  );
  $registration_html = html_replace($registration_array, $registration_template);
  $body_array = array(
   '[[title]]'    => 'Registrace',
   '[[content]]'  => $registration_html
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getRegistrationDone($link) {
  switch ($link) {
   case 'dokoncena': // after registration
    $body_array = array(
     '[[title]]'   => 'Registrace dokončena',
     '[[content]]' => file_get_contents('registration-done.html')
    );
    $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
    break;
   case 'potvrzena': // after clicking on activation link in registration e-mail
    $body_array = array(
     '[[title]]'   => 'Registrace potvrzena',
     '[[content]]' => file_get_contents('registration-activated.html')
    );
    $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
    break;
   default:
    header('Location: /');
    break;
  }
 }

 function getForum() {
  $body_array = array(
   '[[title]]'   => 'Diskuze',
   '[[content]]' => file_get_contents('forum.html'),
   '[[forum-load-rows]]' => $GLOBALS['forum-load-rows']
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getForumAction($link) {
  if (strpos($link, 'prispevek-') !== false) getForumThread(explode("prispevek-", $link)[1]);
  elseif ($link == 'novy-prispevek') getForumNewThread();
  else header('Location: /');
 }

 function getForumThread($id) {
  $thread = getAPI('get_forum_thread?id=' . $id);
  $post_template = file_get_contents('forum-thread-post.html');
  $posts = getAPI('get_forum_posts?id=' . $id);
  foreach ($posts as $p) {
   $post_array = array(
    '[[post-username]]' => $p['username'],
    '[[post-sex]]'      => $p['sex'] ? 'text-blue' : 'text-red',
    '[[post-date]]'     => $p['created'],
    '[[post-body]]'     => nl2br(linkText(htmlspecialchars($p['body'])))
   );
   $posts_html .= html_replace($post_array, $post_template);
  }
  $body_array = array(
   '[[content]]'         => file_get_contents('forum-thread.html'),
   '[[title]]'           => 'Diskuze - příspěvek - [[thread-subject]]',
   '[[thread-subject]]'  => htmlspecialchars($thread[0]['topic']),
   '[[thread-username]]' => $thread[0]['username'],
   '[[thread-sex]]'      => $thread[0]['sex'] ? 'text-blue' : 'text-red',
   '[[thread-date]]'     => $thread[0]['created'],
   '[[thread-body]]'     => nl2br(linkText(htmlspecialchars($thread[0]['body']))),
   '[[post-new]]'        => file_get_contents(isset($_SESSION['login-id'] ? '/forum-thread-post-new.html' : '/forum-thread-post-new-error.html')),
   '[[thread-id]]'       => $thread[0]['id'],
   '[[captcha]]'         => getCaptchaText(),
   '[[posts]]'           => $posts_html
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getForumNewThread() {
  $body_array = array(
   '[[title]]'   => 'Diskuze - Nový příspěvek',
   '[[content]]' => file_get_contents(isset($_SESSION['login-id'] ? '/forum-new-thread.html' : '/forum-new-thread-error.html')),
   '[[captcha]]' => getCaptchaText()
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getError($link) {
  switch ($link) {
   case 'kategorie-prazdna':
    $file = 'error-category-not-set';
    break;
   case 'kategorie-nenalezena':
    $file = 'error-category-not-found';
    break;
   case 'produkt-prazdny':
    $file = 'error-product-not-set';
    break;
   case 'produkt-nenalezen':
    $file = 'error-product-not-found';
    break;
   case 'soubor-prazdny':
    $file = 'error-file-not-set';
    break;
   case 'soubor-nenalezen':
    $file = 'error-file-not-found';
    break;
   default:
    $file = 'error-unknown';
    break;
  }
  $body_array = array(
   '[[title]]'    => 'Chyba',
   '[[content]]'  => file_get_contents($file . '.html')
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getEmailSent($sent) {
  if ($sent) {
   $body_array = array(
    '[[title]]'    => 'E-mail odeslán',
    '[[content]]'  => file_get_contents('email-sent.html')
   );
  } else {
   $body_array = array(
    '[[title]]'    => 'E-mail neodeslán',
    '[[content]]'  => file_get_contents('email-not-sent.html')
   );
  }
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getRegistrationConfirmation($state){
  $body_array = array(
   '[[title]]'    => 'Dokončení registrace',
   '[[content]]'  => file_get_contents('registration-confirmation-' . ($state == 'ok' ? 'ok' : 'fail') . '.html')
  );
  $GLOBALS['body'] = html_replace($body_array, $GLOBALS['body']);
 }

 function getHomePage() {
  header('Location: /');
 }
?>
