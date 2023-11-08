const fs = require('fs');
const os = require('os');
const { dirname } = require('path');

class Common {
 static appName = 'LiberShare Server';
 static appVersion = '1.00';
 static settingsFile = 'settings.json';
 static appPath = dirname(require.main.filename) + '/';
 static settings;

 static addLog(message, type = 0) {
  const date = this.getDateTime();
  const msg = message === undefined ? '' : message;
  let typeText = 'INFO';
  let color = '\x1b[32m';
  switch (type) {
   case 1:
    typeText = 'WARNING';
    color = '\x1b[33m';
    break;
   case 2:
    typeText = 'ERROR';
    color = '\x1b[31m';
  }
  console.log('\x1b[96m' + date + '\x1b[0m [' + color + typeText + '\x1b[0m] ' + msg);
  if (this.settings && this.settings.other && this.settings.other.log_to_file) fs.appendFileSync(this.appPath + this.settings.other.log_file, date + ' [' + typeText + '] ' + msg + os.EOL);
 }

 static getDateTime() {
  function toString(number, padLength) {
   return number.toString().padStart(padLength, '0');
  }
  const date = new Date();
  return toString(date.getFullYear(), 4) + '-' + toString(date.getMonth() + 1, 2) + '-' + toString(date.getDate(), 2) + ' ' + toString(date.getHours(), 2) + ':' + toString(date.getMinutes(), 2) + ':' + toString(date.getSeconds(), 2);
 }

 static getDatePlusSeconds(date, seconds) {
  return new Date(date.setSeconds(date.getSeconds() + seconds));
 }

 static translate(template, dictionary) {
  for (const key in dictionary) template = template.replaceAll(key, dictionary[key]);
  return template;
 }

 static validateEmail(email) {
  const re = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
  return re.test(email);
 }
 
 static checkDate(month, day, year) {
  month = parseInt(month, 10);
  day = parseInt(day, 10);
  year = parseInt(year, 10);
  const date = new Date(year, month - 1, day);
  return date && date.getMonth() + 1 === month && date.getDate() === day && date.getFullYear() === year;
 }
}

module.exports = { Common: Common };
