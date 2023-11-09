<?php
 require_once('../settings.php');
 $net_template = file_get_contents('template/status-network.html');
 $networks = shell_exec('cat /proc/net/dev | awk \'{print $1}\' | grep : | sed \'s/.$//\'');
 $nets = explode("\n", $networks);
 foreach ($nets as $net_name) {
  if ($net_name != 'lo' && $net_name != '') {
   shell_exec('vnstati -i ' . $net_name . ' -s -o ' . $GLOBALS['path_netstat'] . 'netstat_s_' . $net_name . '.png');
   shell_exec('vnstati -i ' . $net_name . ' -h -o ' . $GLOBALS['path_netstat'] . 'netstat_h_' . $net_name . '.png');
   shell_exec('vnstati -i ' . $net_name . ' -d -o ' . $GLOBALS['path_netstat'] . 'netstat_d_' . $net_name . '.png');
   shell_exec('vnstati -i ' . $net_name . ' -m -o ' . $GLOBALS['path_netstat'] . 'netstat_m_' . $net_name . '.png');
   shell_exec('vnstati -i ' . $net_name . ' -t -o ' . $GLOBALS['path_netstat'] . 'netstat_t_' . $net_name . '.png');
   $network = shell_exec('vnstat -i ' . $net_name . ' -tr 2');
   $net = explode("\n", $network);
   $net_html = str_replace('[[name]]', $net_name, $net_template);
   for ($i = 3; $i < count ($net); $i++) {
    $parts = preg_replace('!\s+!', ';', trim($net[$i]));
    $parts = explode(';',trim($parts));
    if ($parts[0] == 'rx') $net_html = str_replace('[[download]]', $parts[1] . ' ' . $parts[2], $net_html);
    if ($parts[0] == 'tx') $net_html = str_replace('[[upload]]', $parts[1] . ' ' . $parts[2], $net_html);
   }
   echo $net_html;
  }
 }
?>