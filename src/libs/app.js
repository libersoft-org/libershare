const fs = require('fs');
const Common = require('./common.js').Common;

class App {
 async run() {
  const args = process.argv.slice(2);
  switch (args.length) {
   case 0:
    this.startServer();
    break;
   case 1:
    if (args[0] === '--create-settings') this.createSettings();
    else if (args[0] === '--create-database') await this.createDatabase();
    else this.getHelp();
    break;
   default:
    this.getHelp();
    break;
  }
 }

 startServer() {
  this.loadSettings();
  const header = Common.appName + ' ver. ' + Common.appVersion;
  const dashes = '='.repeat(header.length);
  Common.addLog('');
  Common.addLog(dashes);
  Common.addLog(header);
  Common.addLog(dashes);
  Common.addLog('');
  const WebServer = require('./webserver.js');
  const webServer = new WebServer();
  webServer.run().then(() => {
   fs.chmodSync(Common.settings.web.socket_path, '777');
  });
 }

 getHelp() {
  Common.addLog('Command line arguments:');
  Common.addLog('');
  Common.addLog('--help - to see this help');
  Common.addLog('--create-settings - to create a default settings file named "' + Common.settingsFile + '"');
  Common.addLog('--create-database - to create a database defined in "' + Common.settingsFile + '" file');
  Common.addLog('');
 }

 loadSettings() {
  if (fs.existsSync(Common.appPath + Common.settingsFile)) {
   Common.settings = JSON.parse(
    fs.readFileSync(Common.appPath + Common.settingsFile, {
     encoding: 'utf8',
     flag: 'r'
    })
   );
  } else {
   Common.addLog('The settings file "' + Common.settingsFile + '" was not found. If you would like to create a new settings file, please use the parameter "--create-settings".', 2);
   process.exit(1);
  }
 }

 createSettings() {
  if (fs.existsSync(Common.appPath + Common.settingsFile)) {
   Common.addLog('The settings file "' + Common.settingsFile + '" already exists. If you need to replace it with a default one, delete the old one first.', 2);
   process.exit(1);
  } else {
   let settings = {
    web: {
     name: 'LiberShare',
     description: 'Share your files!',
     standalone: true,
     port: 80,
     socket_path: '/run/libershare.sock',
     socket_owner: 'nginx',
     sessions_users: 604800,
     sessions_admins: 604800
    },
    storage: {
     upload: './upload/',
     download: './download/',
     images: './images/',
     temp: './temp/',
     chunk_upload: 10485760,
     chunk_download: 1048576
    },
    database: {
     host: '127.0.0.1',
     port: '3306',
     name: 'libershare_com',
     user: 'libershare',
     password: ''
    },
    email: {
     host: '127.0.0.1',
     port: '465',
     tls: true,
     user: 'info@libershare.com',
     password: '',
     from_email: 'info@libershare.com',
     from_visible: 'LiberShare'
    },
    other: {
     log_to_file: true,
     log_file: 'libershare.log'
    }
   };
   fs.writeFileSync(Common.appPath + Common.settingsFile, JSON.stringify(settings, null, ' '));
   Common.addLog('The settings file "' + Common.settingsFile + '" has been successfully created.');
  }
 }

 async createDatabase() {
  this.loadSettings();
  const Data = require('./data.js');
  const data = new Data();
  Common.addLog('Creating the database "' + Common.settings.database.name + '" ...');
  await data.dbCreate();
  Common.addLog('The database "' + Common.settings.database.name + '" has been successfully created.');
 }
}

module.exports = App;
