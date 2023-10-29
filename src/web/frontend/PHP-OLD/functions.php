<?php
 function getAPI($path) {
  $opts = array('http' => array('header' => 'Cookie: ' . $_SERVER['HTTP_COOKIE'] . "\r\n"));
  $context = stream_context_create($opts);
  session_write_close();
  $data = file_get_contents($GLOBALS['url'] . $path, false, $context);
  if (session_status() == PHP_SESSION_NONE) session_start();
  return json_decode($data, true);
 }

 function getHumanSize($bytes) {
  $type = array('', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y');
  $i = 0;
  while ($bytes >= 1024) {
   $bytes /= 1024;
   $i++;
  }
  return round($bytes, 2) . ' ' . $type[$i] .'B';
 }
 
 function getRAMUsage() {
/*
  $data = explode("\n", shell_exec('cat /proc/meminfo'));
  $meminfo = array();
  foreach ($data as $line) {
   list($key, $val) = explode(":", $line);
   $meminfo[$key] = str_replace(' kB', '', trim($val) * 1024);
  }
  $result = array(
   'used' => $meminfo['MemTotal'] - $meminfo['MemAvailable'],
   'free' => $meminfo['MemAvailable'],
   'total' => $meminfo['MemTotal'],
   'used-percent' => round((($meminfo['MemTotal'] - $meminfo['MemAvailable']) / $meminfo['MemAvailable']) * 100, 2)
  );
  */
  return $result;
 }
 
 function getStorageUsage() {
 /*
  $data = explode("\n", shell_exec('df -B1 -x tmpfs -x devtmpfs | tail -n +2 | awk \'{print $6}\''));
  unset($data[count($data) - 1]);
  for ($i = 0; $i < count($data); $i++) {
   $total = disk_total_space($data[$i]);
   $free = disk_free_space($data[$i]);
   $data[$i] = array(
    'path'         => $data[$i],
    'total'        => $total,
    'free'         => $free,
    'used'         => $total - $free,
    'used-percent' => round((($total - $free) / $total) * 100, 2)
   );
  }
  */
  return $data;
 }
 
 function html_replace($array, $html) {
  return str_replace(array_keys($array), $array, $html);
 }
 
 function starts_with($string, $query) {
  return substr($string, 0, strlen($query)) == $query ? true : false;
 }
 
 function getAddress($array) {
  $array = array_merge($_GET, $array);
  $address = '?';
  foreach ($array as $k => $v) {
   $val = $k . '=' . $v;
   $address .= ($address == '?') ? $val : '&' . $val;
  }
  return $address;
 }
 
 function getClientIP() {
  $ip = '';
  if (!empty($_SERVER['HTTP_CLIENT_IP'])) $ip = $_SERVER['HTTP_CLIENT_IP'];
  elseif (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) $ip = $_SERVER['HTTP_X_FORWARDED_FOR'];
  else $ip = $_SERVER['REMOTE_ADDR'];
  return $ip;
 }

 function sendConfirmationEmail($confirmation, $email, $username, $firstname, $lastname){
  require_once('../settings.php');
  require_once('../PHPMailerAutoload.php');
  $aPHPMail = new PHPMailer(true);
  try {
   $email_from = $GLOBALS['mail-from'];
   $name_from = $GLOBALS['product'];
   $subject = 'Aktivace účtu serveru ' . $GLOBALS['product'];
   $message_array = array(
    '[[first-name]]' => $firstname,
    '[[last-name]]'  => $lastname,
    '[[username]]'   => $username,
    '[[link]]'       => $GLOBALS['url'] . "confirm.php?id=" . $confirmation,
    '[[product]]'    => $GLOBALS['product']
   );
   $message = html_replace($message_array, file_get_contents('../' . $GLOBALS['template-path'] . '/registration-email.html'));
   $aPHPMail->CharSet = 'UTF-8';
   $aPHPMail->IsHTML(true);
   $aPHPMail->IsSMTP();
   $aPHPMail->Host       = $GLOBALS['mail-host'];
   $aPHPMail->SMTPAuth   = $GLOBALS['mail-smtpauth'];
   $aPHPMail->SMTPSecure = $GLOBALS['mail-smtpsecure'];
   $aPHPMail->AuthType   = $GLOBALS['mail-authtype'];
   $aPHPMail->Username   = $GLOBALS['mail-username'];
   $aPHPMail->Password   = $GLOBALS['mail-password'];
   $aPHPMail->SMTPOptions = $GLOBALS['mail-smtpoptions'];
   $aPHPMail->SetFrom($email_from, $name_from);
   $aPHPMail->Subject = $subject;
   $aPHPMail->Body = $message;
   $aPHPMail->AddAddress($email, $username);
   if ($aPHPMail->Send()) return true;
   else return false;
  } catch (phpmailerException $e) {
   return false;
  } catch (Exception $e) {
   return false;
  }
 }
 
 function linkText($original) {
  return preg_replace("~[[:alpha:]]+://[^<>[:space:]]+[[:alnum:]/]~", "<a href=\"\\0\" target=\"_blank\">\\0</a>", $original);
 }
 
 function getCaptchaText() {
  for ($i = 0; $i < 5; $i++) $captcha .= chr(mt_rand(65, 90));
  $_SESSION['captcha'] = $captcha;
  return $captcha;
 }
 
 function getCaptchaImage($code) {
  $fontfile = $GLOBALS['template-path'] . '/font/Ubuntu-B.ttf';
  $bg_image = $GLOBALS['template-path'] . '/img/captcha.jpg';
  $captcha = imagecreatetruecolor(250, 80);
  $bg = imagecreatefromjpeg($bg_image);
  $size = getimagesize($bg_image);
  $src_x = mt_rand(0,($size[0] - 250));
  $src_y = mt_rand(0,($size[1] - 80));
  imagecopy($captcha, $bg, 0, 0, $src_x, $src_y, 250, 80);
  for ($i = 0; $i <= strlen($code); $i++) {
   $size2 = mt_rand (15,40);
   if (!isset($size2_old)) $size2_old = $size2;
   $rotation = mt_rand(-20, 20);
   $color = imagecolorallocate($captcha, mt_rand(0, 100), mt_rand(0, 100), mt_rand(0, 100));
   imagettftext($captcha, $size2, $rotation, ($i * 40) + $size2_old, 50, $color, $fontfile, substr($code, $i, 1));
   $size2_old = $size2;
  }
  header('Content-type: image/gif');
  header('Cache-Control: no-cache');
  header('Expires: ' . gmdate('D, d M Y H:i:s', time()) . ' GMT');
  return imagegif($captcha);
 }
 
 function isCaptchaCorrect($captcha) {
  return $captcha == $_SESSION['captcha'] ? true : false;
 }
?>
