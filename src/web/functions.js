// TODO - get page name from backend:
const pageName = 'LiberShare';
let pages;
let menuOpened = false;

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const YEARS = Array.from({ length: 100 }, (_, i) => new Date().getFullYear() - i);

const ALLOWED_EXTENSIONS = ['mp4', 'mp3', 'avi', 'webm'];

window.onload = async () => {
 const pg = location.pathname.substring(location.pathname.lastIndexOf('/') + 1);
 pages = JSON.parse(await getFileContent('pages.json'));
 getMenu();
 getReload(pg);
 window.addEventListener('popstate', async function (e) {
  const currentPage = location.pathname.substring(location.pathname.lastIndexOf('/') + 1);
  getReload(currentPage);
 });

 document.querySelector('.modal-overlay').addEventListener('click', closeModalN);

 document.querySelector('#modal-content').addEventListener('click', function (event) {
  event.stopPropagation();
 });
};

async function getMenu() {
 const menu = await getFileContent('html/menu.html');
 qs('#menu-desktop').innerHTML = menu;
 qs('#menu-mobile').innerHTML = menu;
}

function menu() {
 if (menuOpened) menuClose();
 else menuOpen();
}

function menuClose() {
 menuOpened = false;
 qs('#header .menu-toggler').src = 'img/menu.svg';
 qs('#menu-mobile').style.transform = 'translateX(-110%)'; // Slide out to the left
 qs('#menu-overlay').style.transform = 'translateX(-110%)'; // Slide out to the left
 qs('#header').classList.add('shadow');
}

function menuOpen() {
 menuOpened = true;
 qs('#header .menu-toggler').src = 'img/close.svg';
 qs('#menu-mobile').style.transform = 'translateX(0)'; // Slide out to the left
 qs('#menu-overlay').style.transform = 'translateX(0)'; // Slide out to the left
 qs('#header').classList.remove('shadow');
}

async function getReload(page) {
 window.history.replaceState('', '', page == '' ? '' : page);
 await getPageContent(page);
}

async function getPage(page) {
 if (menuOpened) menuClose();
 window.history.pushState('', '', page == '' ? '/' : page);
 await getPageContent(page);
}

async function getPageContent(page) {
 if (page == '') page = 'news';
 let content = '';
 if (qsa('#menu-desktop .item.active').length == 1) qsa('#menu-desktop .item.active')[0].classList.remove('active');
 if (qsa('#menu-mobile .item.active').length == 1) qsa('#menu-mobile .item.active')[0].classList.remove('active');
 if (page in pages) {
  document.title = pageName + ' - ' + pages[page].label;
  if (qs('#menu-desktop .item.menu-' + page)) qs('#menu-desktop .item.menu-' + page).classList.add('active');
  if (qs('#menu-mobile .item.menu-' + page)) qs('#menu-mobile .item.menu-' + page).classList.add('active');
  // TODO: only if page exists:
  content = await getFileContent('html/' + pages[page].file);
 } else if (page.includes('-')) {
  if (page.startsWith('product-')) content = await getFileContent('html/product.html');
  else if (page.startsWith('category-')) content = await getFileContent('html/category.html');
  else {
   document.title = pageName + ' - ' + pages['notfound'].label;
   content = await getFileContent('html/notfound.html');
  }
 } else {
  document.title = pageName + ' - ' + pages['notfound'].label;
  content = await getFileContent('html/notfound.html');
 }
 qs('#content').innerHTML = content;
 if (page === 'news') await getPageNews();
 else if (page === 'categories') await getPageCategories();
 else if (page == 'upload') await getPageUpload();
 else if (page == 'search') await getPageSearch();
 else if (page == 'forum') await getPageForum();
 else if (page.startsWith('category-')) await getPageCategory(page.substring(9));
 else if (page.startsWith('product-')) await getPageProduct(page.split('-')[1]);
 var headers = document.querySelectorAll('.accordion .header');
 headers.forEach(function (header) {
  header.addEventListener('click', function () {
   var body = this.nextElementSibling;
   if (body.style.height === '0px' || body.style.height === '') {
    body.style.height = body.scrollHeight + 'px';
    header.firstElementChild.style.transform = 'translateY(-50%) rotate(180deg)'; // Otočení šipky směrem nahoru
   } else {
    body.style.height = '0px';
    header.firstElementChild.style.transform = 'translateY(-50%) rotate(0deg)'; // Otočení šipky směrem nahoru
   }
  });
 });

 const sess = localStorage.getItem('libershare_session_guid');
 if (sess && sess.length > 16) {
  document.querySelector('.menu-username').textContent = localStorage.getItem('libershare_username');

  document.querySelectorAll('.need-login').forEach((element) => {
   element.classList.add('hidden-important');
   element.classList.remove('flex-important');
  });

  document.querySelectorAll('.need-logout').forEach((element) => {
   element.classList.remove('hidden-important');
   element.classList.add('flex-important');
  });
 } else {
  document.querySelectorAll('.need-login').forEach((element) => {
   element.classList.remove('hidden-important');
   element.classList.add('flex-important');
  });

  document.querySelectorAll('.need-logout').forEach((element) => {
   element.classList.add('hidden-important');
   element.classList.remove('flex-important');
  });

  document.querySelector('.menu-username').textContent = '';
 }
}

async function getPageNews() {
 const image_default = 'img/item-default.webp'; // TODO: no mention - why?
 const temp_cat = await getFileContent('html/news-category.html');
 const temp_prod = await getFileContent('html/products-item.html');
 const cats = await getAPI('get_categories');
 for (let i = 0; i < cats.data.length; i++) {
  if (cats.data[i].products_count - cats.data[i].products_count_hidden !== 0) {
   const prods = await getAPI('get_products', {
    id_category: cats.data[i].id,
    h: 2,
    d: true,
    count: 12
   });
   let prows = '';
   for (let j = 0; j < prods.data.length; j++) {
    let imgee = image_default;
    if (prods.data[j].image_sm) imgee = `img/products/${prods.data[j].image_sm}`;
    let prow = translate(temp_prod, {
     '{NAME}': prods.data[j].name,
     '{LINK}': prods.data[j].id + '-' + prods.data[j].link,
     '{IMAGE}': prods.data[j].adult === 0 ? imgee : 'img/item-censored.webp'
    });
    prows += prow;
   }
   const crow = translate(temp_cat, {
    '{LINK}': cats.data[i].link,
    '{CATEGORY}': cats.data[i].name,
    '{ITEMS}': prows
   });
   qs('#content .news').innerHTML += crow;
  }
 }
 qs('#content .loader').remove();
}

async function getPageCategories() {
 const image_default = 'img/item-default.webp'; // TODO: no mention - why?
 const temp = await getFileContent('html/categories-item.html');
 const cats = await getAPI('get_categories');
 let prods_count = 0;
 let crows = '';
 for (let i = 0; i < cats.data.length; i++) {
  if (cats.data[i].products_count - cats.data[i].products_count_hidden !== 0) {
   let imgee = image_default;
   if (cats.data[i].image) imgee = `img/categories/${cats.data[i].image}`;
   const crow = translate(temp, {
    '{LINK}': cats.data[i].link,
    '{NAME}': cats.data[i].name,
    '{IMAGE}': imgee,
    '{COUNT}': cats.data[i].products_count - cats.data[i].products_count_hidden
   });
   prods_count += cats.data[i].products_count - cats.data[i].products_count_hidden;
   crows += crow;
  }
 }
 let all = translate(temp, {
  '{LINK}': 'all',
  '{NAME}': 'All',
  '{IMAGE}': 'img/item-all.webp',
  '{COUNT}': prods_count
 });
 qs('#content .categories .items').innerHTML = all + crows;
 qs('#content .loader').remove();
}

async function getPageProduct(id) {
 const image_default = 'img/item-default.webp'; // TODO: no mention - why?
 let temp = await getFileContent('html/product-detail.html');
 const prod = await getAPI('get_product', { id: id });
 if (prod.data.length == 1) {
  const cat = await getAPI('get_category_by_id', {
   id: prod.data[0].id_categories
  });
  prod.data[0].id_categories;
  const files = await getAPI('get_files', { id_product: prod.data[0].id });
  let temp_files = await getFileContent('html/product-file.html');
  let rows = '';
  for (const f of files.data) {
   const fileExtension = f.file_name.split('.').pop().toLowerCase();
   let repl = await getFileContent('html/product-play-button.html');
   if (!ALLOWED_EXTENSIONS.includes(fileExtension)) repl = '';
   if (f.file_name && ALLOWED_EXTENSIONS.includes(fileExtension)) {
    rows += translate(temp_files, {
     '{NAME}': f.file_name,
     '{SIZE}': getHumanSize(f.size),
     '{LINK-DOWNLOAD}': 'download?id=' + f.name,
     '{PLAY-ONLINE}': repl
    });
   } else {
    rows += translate(temp_files, {
     '{NAME}': f.file_name,
     '{SIZE}': getHumanSize(f.size),
     '{LINK-DOWNLOAD}': 'download?id=' + f.name,
     '{PLAY-ONLINE}': ''
    });
   }
  }
  let imgee = image_default;
  if (prod.data[0].image) imgee = `img/products/${prod.data[0].image}`;
  const html = translate(temp, {
   '{CATEGORY-LINK}': cat.data[0].link,
   '{CATEGORY}': cat.data[0].name,
   '{NAME}': prod.data[0].name,
   '{IMAGE}': imgee, //'{FB-SHARE-LINK}': '',
   '{FILES}': rows
  });
  qs('#content').innerHTML = html;
 } else qs('#content').innerHTML = 'Product not found'; // TODO: replace for HTML page
}

async function getPageCategory(link) {
 const image_default = 'img/item-default.webp'; // TODO: no mention - why?
 const cat = await getAPI('get_category_by_link', { link: link });
 if (cat.data.length == 1) {
  const temp_cat = await getFileContent('html/category-detail.html');
  const html = translate(temp_cat, {
   '{CATEGORY}': cat.data[0].name
  });
  qs('#content').innerHTML = html;
  const temp_prod = await getFileContent('html/products-item.html');
  const prods = await getAPI('get_products', {
   id_category: cat.data[0].id,
   h: 2,
   d: true,
   count: 12
  });
  let prows = '';
  for (let i = 0; i < prods.data.length; i++) {
   let imgee = image_default;
   if (prods.data[i].image_sm) imgee = `img/products/${prods.data[i].image_sm}`;
   let prow = translate(temp_prod, {
    '{NAME}': prods.data[i].name,
    '{LINK}': prods.data[i].id + '-' + prods.data[i].link,
    '{IMAGE}': prods.data[i].adult === 0 ? imgee : 'img/item-censored.webp'
   });
   prows += prow;
  }
  qs('#content .items').innerHTML = prows;
  //qs('#content .loader').remove();
 } else qs('#content').innerHTML = 'Category not found'; // TODO: replace for HTML page
}

async function getPageForum() {
 await getPageForumThreads(10);
 //$(window).on('resize scroll', function() { getPageForumThreadsNext(threadscount, elem, temp_thread, temp_more); });
}

async function getPageForumThreads(count, page = 1) {
 const temp_thread = await getFileContent('html/forum-row.html');
 const table = qs('#content .forum tbody');
 // TODO: if div with class "more" is not visible, return, otherwise load more threads
 //if (!table.length) return;
 //if (!table.isVisible()) return;
 const threads = await getAPI('get_forum_threads', {
  count: count,
  offset: (page - 1) * count
 });
 if (threads.data.length == 0) return;
 let rows = '';
 for (let item of threads.data) {
  rows += translate(temp_thread, {
   '{ID}': item.id,
   '{TOPIC}': escapeHTML(item.topic),
   '{USERNAME}': item.username,
   '{POSTS}': item.posts_count,
   '{CREATED}': new Date(item.created).toLocaleString(),
   '{SEX}': item.sex == 1 ? 'text-blue' : 'text-red'
  });
 }
 table.innerHTML = rows;
 //page++;
 //getPageForumThreads(count, page);
}

async function getPageUpload() {
 var dropzone = new Dropzone('#demo-upload', {
  url: '/api/upload',
  previewTemplate: document.querySelector('#preview-template').innerHTML,
  parallelUploads: 2,
  thumbnailHeight: 120,
  thumbnailWidth: 120,
  maxFilesize: 2048,
  filesizeBase: 1000,
  autoProcessQueue: false, // Zakázání automatického zpracování fronty
  addRemoveLinks: true, // Přidání odkazů pro odstranění souborů
  thumbnail: function (file, dataUrl) {
   if (file.previewElement) {
    file.previewElement.classList.remove('dz-file-preview');
    var images = file.previewElement.querySelectorAll('[data-dz-thumbnail]');
    for (var i = 0; i < images.length; i++) {
     var thumbnailElement = images[i];
     thumbnailElement.alt = file.name;
     thumbnailElement.src = dataUrl;
    }
    setTimeout(function () {
     file.previewElement.classList.add('dz-image-preview');
    }, 1);
   }
  }
 });

 // Now fake the file upload, since GitHub does not handle file uploads
 // and returns a 404

 var minSteps = 6,
  maxSteps = 60,
  timeBetweenSteps = 100,
  bytesPerStep = 100000;

 dropzone.uploadFiles = function (files) {
  var self = this;

  for (var i = 0; i < files.length; i++) {
   var file = files[i];
   totalSteps = Math.round(Math.min(maxSteps, Math.max(minSteps, file.size / bytesPerStep)));

   for (var step = 0; step < totalSteps; step++) {
    var duration = timeBetweenSteps * (step + 1);
    setTimeout(
     (function (file, totalSteps, step) {
      return function () {
       file.upload = {
        progress: (100 * (step + 1)) / totalSteps,
        total: file.size,
        bytesSent: ((step + 1) * file.size) / totalSteps
       };

       self.emit('uploadprogress', file, file.upload.progress, file.upload.bytesSent);
       if (file.upload.progress === 100) {
        file.status = Dropzone.SUCCESS;
        self.emit('success', file, 'success', null);
        self.emit('complete', file);
        self.processQueue();
        //document.getElementsByClassName("dz-success-mark").style.opacity = "1";
       }
      };
     })(file, totalSteps, step),
     duration
    );
   }
  }
 };
 const temp_file = await getFileContent('html/upload-file.html');
 document.querySelector('#upload-button').addEventListener('click', function () {
  console.log('--- upload ---');
  dropzone.processQueue();
 });
 const files = await getAPI('get_uploads', {
  o: 'created',
  d: true,
  count: 10
 });
 // TODO: check if files.data exists, otherwise remove table
 let rows = '';
 for (const item of files.data) {
  rows += translate(temp_file, {
   '{NAME}': item.real_name,
   '{SIZE}': getHumanSize(item.size),
   '{LINK}': './download?id=' + item.file_name
  });
 }
 qs('#content .files').innerHTML = rows;
}

async function getFileContent(file) {
 const content = await fetch(file, {
  headers: { 'cache-control': 'no-cache' }
 });
 return content.text();
}

async function getAPI(name, body = null) {
 const post =
  body != null
   ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
     }
   : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
     };
 const res = await fetch('api/' + name, post);
 if (res.ok) return await res.json();
 else return false;
}

async function getModal(title, body) {
 const html = await getFileContent('html/modal.html');
 const modal = document.createElement('div');
 modal.innerHTML = html.replace('{TITLE}', title).replace('{BODY}', body);
 qs('body').appendChild(modal);
}

function closeModal() {
 qs('.modal').remove();
}

function getLoader() {
 return '<div class="loader"></div>';
}

function escapeHTML(text) {
 let map = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;'
 };
 return text.replace(/[&<>"']/g, function (m) {
  return map[m];
 });
}

function getHumanSize(bytes) {
 const type = ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
 let i = 0;
 while (bytes >= 1024) {
  bytes /= 1024;
  i++;
 }
 return Math.round(bytes * 100) / 100 + ' ' + type[i] + 'B';
}

function translate(template, dictionary) {
 for (const key in dictionary) template = template.replaceAll(key, dictionary[key]);
 return template;
}

function qs(query) {
 return document.querySelector(query);
}

function qsa(query) {
 return document.querySelectorAll(query);
}

async function generateCaptcha() {
 try {
  const response = await fetch('/api/generate_captcha', { method: 'GET' });

  if (!response.ok) {
   throw new Error('Network response was not ok');
  }

  const data = await response.json(); // Převedení odpovědi na JSON

  return data;
 } catch (error) {
  return null;
 }
}

function verifyCaptcha() {
 const userResponse = document.getElementById('captcha-input').value;
 const captchaText = document.querySelector('#captcha-container canvas').getAttribute('data-captcha');

 if (userResponse === captchaText) {
  alert('CAPTCHA je správná!');
 } else {
  alert('CAPTCHA je nesprávná. Zkuste to znovu.');
  document.getElementById('captcha-input').value = '';
  document.getElementById('captcha-container').innerHTML = '';
  generateCaptcha();
 }
}

function toggleLoginRegister(mode) {
 const modalTitle = document.querySelector('.modal-title');
 const llog = document.querySelector('.l-log');
 const lreg = document.querySelector('.l-reg');
 const modalButton = document.querySelector('.btn-lr');
 if (mode === 'login') {
  modalTitle.textContent = 'Login';
  modalButton.textContent = 'Login';
  llog.style.display = 'none';
  lreg.style.display = 'block';
 } else if (mode === 'register') {
  modalTitle.textContent = 'Register';
  modalButton.textContent = 'Register';
  llog.style.display = 'block';
  lreg.style.display = 'none';
 }
}

function openLoginModal() {
 const modal = document.getElementById('login_modal');
 modal.style.display = 'block';
}

function makeDraggable(modal) {
 let isDragging = false;
 let offsetX, offsetY;
 const header = modal.querySelector('.modal-header');

 header.addEventListener('mousedown', (e) => {
  isDragging = true;
  offsetX = e.clientX - modal.getBoundingClientRect().left;
  offsetY = e.clientY - modal.getBoundingClientRect().top;
 });

 document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  let top = e.clientY - offsetY;
  let left = e.clientX - offsetX;

  left = Math.max(left, 0);
  top = Math.max(top, 0);
  left = Math.min(left, window.innerWidth - modal.offsetWidth);
  top = Math.min(top, window.innerHeight - modal.offsetHeight);

  modal.style.left = left + 'px';
  modal.style.top = top + 'px';
 });

 document.addEventListener('mouseup', () => {
  isDragging = false;
 });
}

async function openModal(type) {
 let content;
 if (type === 'login') {
  content = await getFileContent('html/login.html');
 } else if (type === 'registration') {
  content = await getFileContent('html/registration.html');
  content = content.replace('{DAYS}', DAYS.map((day) => `<option value="${day}">${day}</option>`).join(''));
  content = content.replace('{MONTHS}', MONTHS.map((month, index) => `<option value="${index + 1}">${month}</option>`).join(''));
  content = content.replace('{YEARS}', YEARS.map((year) => `<option value="${year}">${year}</option>`).join(''));
 }
 const modwin = document.querySelector('#modal-win');
 modwin.style.display = 'flex';
 modwin.querySelector('#modal-content').innerHTML = content;
 makeDraggable(modwin.querySelector('#modal-content'));
 setTimeout(async () => {
  capt = await generateCaptcha();
  const imgElement = document.querySelector('#captcha-container');
  imgElement.style.backgroundColor = 'red';
  imgElement.src = capt.image;
  const cid = document.querySelector('#cid');
  cid.value = capt.capid;
 });
}

function closeModalN() {
 document.querySelector('#modal-win').style.display = 'none';
}

function logout() {
 localStorage.removeItem('libershare_session_guid');
 localStorage.removeItem('libershare_username');
 getPage('');
}
async function regenCaptcha() {
 const capt = await generateCaptcha();
 const imgElement = document.querySelector('#captcha-container');
 imgElement.style.backgroundColor = 'red';
 imgElement.src = capt.image;
 const cid = document.querySelector('#cid');
 cid.value = capt.capid;
}

function submitForm(type) {
 let formId;
 let apiUrl;
 let errorElementId;

 if (type === 'registration') {
  formId = 'registration';
  apiUrl = 'set_registration';
  errorElementId = '#registration-error';
 } else if (type === 'login') {
  formId = 'login';
  apiUrl = 'validate_login';
  errorElementId = '#login-error';
 } else {
  return;
 }

 const form = document.getElementById(formId);
 const formData = new FormData(form);
 const formObject = {};

 formData.forEach((value, key) => {
  formObject[key] = value;
 });

 //fetch(apiUrl, {
 // method: 'POST',
 // headers: {
 //  'Content-Type': 'application/json'
 // },
 // body: JSON.stringify(formObject)
 //})
 getAPI(apiUrl, formObject)
  .then((data) => {
   if (data.error && data.error !== 0) {
    throw new Error(data.message);
   } else {
    localStorage.setItem('libershare_session_guid', data.data.sessionguid);
    localStorage.setItem('libershare_username', data.data.username);
    closeModalN();
    getPage('');
   }
  })
  .catch((error) => {
   setTimeout(() => {
    regenCaptcha();
   }, 50);
   const el = document.querySelector(errorElementId);
   el.innerHTML = `${type.charAt(0).toUpperCase() + type.slice(1)} error: ${error.message}`;
   el.style.display = 'block';
  });
}

// Funkce pro zavření modálního okna
function closeLoginModal() {
 const modal = document.getElementById('login_modal');
 modal.style.display = 'none';
}

/* FROM E-MAIL SENDER APP - DELETE WHEN NOT NEEDED ANYMORE:
 await getModal('Edit campaign', html);
 await getModal('Edit campaign', '<div class="error">' + res.message + '</div>');

async function deleteLinkModal(id, name) {
 await getModal('Delete link', await getFileContent('html/links-delete.html'));
 const body = qs('.modal .body');
 body.innerHTML = body.innerHTML.replaceAll('{ID}', id).replaceAll('{NAME}', name);
}

async function addServerModal() {
 await getModal('New server', await getFileContent('html/servers-add.html'));
}
*/

/* FROM OLD WEBSITE - DELETE WHEN NOT NEEDED ANYMORE:
$(document).ready(function() {
 $("#registration").submit(function (e) {
  e.preventDefault();
  let formdata = $('#registration').serialize();
  $.ajax({
   url: 'set_registration',
   type: 'GET',
   data: formdata,
   contentType: false,
   processData: false
  }).done(function (response) {
   let result = jQuery.parseJSON(response);
   if (result.error != 0) {
    $('#registration-error').show();
    let err = 'Neznámá chyba';
    switch (result.error) {
     case 1:
      err = 'Pro dokončení registrace je potřeba potvrdit, že nejste robot!';
      break;
     case 2:
      err = 'Uživatelské jméno smí obsahovat pouze písmena anglické abecedy a číslice, délka 3 - 24 znaků!';
      break;
     case 3:
      err = 'Uživatelské jméno již bylo zaregistrováno, prosíme zvolte jiné!';
      break;
     case 4:
      err = 'E-mailová adresa nemá platný formát!';
      break;
     case 5:
      err = 'Pod stejnou e-mailovou adresou již existuje účet!';
      break;
     case 6:
      err = 'Prosíme, vyberte své pohlaví!';
      break;
     case 7:
      err = 'Špatně zadané datum narození!';
      break;
     case 8:
      err = 'Heslo musí obsahovat alespoň 3 znaky!';
      break;
     case 9:
      err = 'Hesla se neshodují!';
      break;
     case 10:
      err = 'Pro dokončení registrace musíte souhlasit s Podmínkami užívání!';
      break;
     case 11:
      err = 'Nepodařilo se odeslat aktivační email!';
      break;
    }
     grecaptcha.reset(static_captcha);
    $('#registration-error').text(err);
   } else window.location.href = './registrace-dokoncena';
  });
 });

 $("#contact").submit(function (e) {
  e.preventDefault();
  let formdata = $('#contact').serialize();
  $.ajax({
   url: 'set_contact',
   type: 'GET',
   data: formdata,
   contentType: false,
   processData: false
  }).done(function (response) {
   let result = jQuery.parseJSON(response);
   if (result.error != 0) {
    $('#contact-error').show();
    let err = 'Neznámá chyba';
    switch (result.error) {
     case 1:
      err = 'Pro dokončení odeslání kontaktního formuláře je potřeba potvrdit, že nejste robot!';
      break;
     case 2:
      err = 'Prosím, vyplňte své celé  jméno!';
      break;
     case 3:
      err = 'Prosím, vyplňte e-mailovou adresu ve správném tvaru!';
      break;
     case 4:
      err = 'Prosím, vyplňte předmět zprávy!';
      break;
     case 5:
      err = 'Prosím, vyplňte text zprávy!';
      break;
     case 6:
      err = 'Neznámá chyba při odesílání e-mailu!';
      break;
    }
    $('#contact-success').hide();
    $('#contact-error').text(err);
   } else {
    $('#contact-error').hide();
    $('#contact-success').text("Zpráva byla úspěšně odeslána.");
    $('#contact-success').show();
   }
   grecaptcha.reset(static_captcha);
  });
 });

 $("#login").submit(function (e) {
  e.preventDefault();
  let formdata = $('#login').serialize();
  $.ajax({
   url: 'get_login',
   type: 'GET',
   data: formdata,
   contentType: false,
   processData: false
  }).done(function (response) {
   let result = jQuery.parseJSON(response);
   if (result.error != 0) {
    $('#error').show();
    let err = 'Neznámá chyba';
    switch (result.error) {
     case 1:
      err = 'Špatně zadané uživatelské jméno nebo e-mail!';
      break;
     case 2:
      err = 'Špatně zadané heslo!';
      break;
     case 3:
      err = 'Zadané heslo je chybné!';
      break;
     case 4:
      err = 'Váš účet není aktivován! Byl Vám znovu zaslán aktivační e-mail. Prosím, klikněte na odkaz v e-mailu před prvním přihlášením!';
      break;
     case 5:
      err = 'Váš účet je zablokován!';
      break;
    }
    $('#error-message').text(err);
   } else window.location.href = window.location.href;
  });
 });
 
 $("#forum-thread-new").submit(function (e) {
  e.preventDefault();
  let formdata = $('#forum-thread-new').serialize();
  $.ajax({
   url: 'set_forum_thread_new',
   type: 'POST',
   data: formdata,
   processData: false
  }).done(function (response) {
   let result = jQuery.parseJSON(response);
   if (result.error_id != 0) {
    $('#error_message').show();
    let err = 'Neznámá chyba';
    switch (result.error_id) {
     case 1:
      err = 'Nejste přihlášeni!';
      break;
     case 2:
      err = 'Nadpis příspěvku není vyplněn!';
      break;
     case 3:
      err = 'Text příspěvku není vyplněn!';
      break;
     case 4:
      err = 'Nesprávně opsaný kód z obrázku!';
      break;
    }
    $('#error-message').text(err);
    $('#error-message').show();
   } else window.location.href = './diskuze';
  });
 });
 
 $("#forum-new-post").submit(function (e) {
  e.preventDefault();
  let formdata = $('#forum-new-post').serialize();
  $.ajax({
   url: 'set_forum_post_new',
   type: 'POST',
   data: formdata,
   processData: false
  }).done(function (response) {
   let result = jQuery.parseJSON(response);
   if (result.error_id != 0) {
    $('#error_message').show();
    let err = 'Neznámá chyba';
    switch (result.error_id) {
     case 1:
      err = 'Nejste přihlášeni!';
      break;
     case 2:
      err = 'Příspěvek neexistuje!';
      break;
     case 3:
      err = 'Text odpovědi není vyplněn!';
      break;
     case 4:
      err = 'Nesprávně opsaný kód z obrázku!';
      break;
    }
    $('#error-message').text(err);
    $('#error-message').show();
   } else window.location.href = window.location.href;
  });
 });
});

function getHeaderCategories(path_image_categories) {
 $.get('html/header-category.html', function(category_template) {
  $.get('get_categories', function (data) {
   let result = jQuery.parseJSON(data);
   let rows = '';
   $(result).each(function (k, v) {
    if (v.products_count - v.products_count_hidden != 0) {
     let row = category_template;
     row = replaceAll('{LINK}', v.link, row);
     row = replaceAll('{NAME}', v.name, row);
     row = replaceAll('{IMAGE}', v.image, row);
     row = replaceAll('{path-image-categories}', path_image_categories, row);
     rows += row + "\r\n";
    }
   });
   $('#header-categories').replaceWith(rows);
  });
 });
}

function getPageCategory(link, productcount, elem) {
 let cpt = '';
 let clm = '';
 $.get('html/category-load-more.html', function(data) {
  clm = data;
  $.get('html/products-item.html', function(data) {
   cpt = data;
   $.get('get_category_by_link?link=' + link, function(data) {
    let cat = jQuery.parseJSON(data);
    let catid = cat.hasOwnProperty('error_id') ? 0 : cat[0].id;
    window.page = 1;
    window.canLoadMore = true;
    $(document).ready(function() { getPageCategoryNext(productcount, elem, cpt, clm, cat.hasOwnProperty('error_id') ? 0 : catid); });
    $(window).on('resize scroll', function() { getPageCategoryNext(productcount, elem, cpt, clm, cat.hasOwnProperty('error_id') ? 0 : catid); });
   });
  });
 });
}

function getPageCategoryNext(productcount, elem, product_template, product_more_template, cat_id) {
 if ($(elem).length) {
  if ($(elem).isVisible()) {
   if (window.canLoadMore) {
    window.canLoadMore = false;
    $.get('get_products?id=' + cat_id + '&count=' + productcount + '&offset=' + ((window.page - 1) * productcount) + '&h=2', function (data) {
     let result = jQuery.parseJSON(data);
     if (result.length != 0) {
      let rows = '';
      $(result).each(function (k, v) {
       let row = product_template;
       row = replaceAll('{LINK}', v.id + '-' + v.link, row);
       row = replaceAll('{NAME}', v.name, row);
       row = replaceAll('{IMAGE}', 'image.php?file=' + v.image_sm, row);
       rows += row + "\r\n";
      });
      $(elem).replaceWith(rows + product_more_template);
      window.page++;
      window.canLoadMore = true;
      getPageCategoryNext(productcount, elem, product_template, product_more_template, cat_id);
     }
    });
   }
  }
 }
}

function getPageSearch(phrase, productcount, elem) {
 let cpt = '';
 let clm = '';
 $.get('html/search-load-more.html', function(data) {
  slm = data;
  $.get('html/item.html', function(data) {
   spt = data;
   window.page = 1;
   window.canLoadMore = true;
   $(document).ready(function() { getPageSearchNext(productcount, elem, spt, slm, phrase); });
   $(window).on('resize scroll', function() { getPageSearchNext(productcount, elem, spt, slm, phrase); });
  });
 });
}

function getPageSearchNext(productcount, elem, product_template, product_more_template, phrase) {
 if ($(elem).length) {
  if ($(elem).isVisible()) {
   if (window.canLoadMore) {
    window.canLoadMore = false;
    $.get('get_products?search=' + phrase + '&count=' + productcount + '&offset=' + ((window.page - 1) * productcount) + '&h=2', function (data) {
     let result = jQuery.parseJSON(data);
     if (result.length != 0) {
      let rows = '';
      $(result).each(function (k, v) {
       let row = product_template;
       row = replaceAll('{LINK}', v.id + '-' + v.link, row);
       row = replaceAll('{NAME}', v.name, row);
       row = replaceAll('{IMAGE}', 'image.php?file=' + v.image_sm, row);
       rows += row + "\r\n";
      });
      $(elem).replaceWith(rows + product_more_template);
      window.page++;
      window.canLoadMore = true;
      getPageSearchNext(productcount, elem, product_template, product_more_template, phrase);
     }
    });
   }
  }
 }
}

function getPageUpload(filecount, elem) {
 $.get('html/upload-file.html', function(upload_template) {
  $.get('html/upload-load-more.html', function(upload_more_template) {
   window.page = 1;
   window.canLoadMore = true;
   $(document).ready(function() { getPageUploadNext(filecount, elem, upload_template, upload_more_template); });
   $(window).on('resize scroll', function() { getPageUploadNext(filecount, elem, upload_template, upload_more_template); });
  });
 });
}

function getPageUploadNext(filecount, elem, upload_template, upload_more_template) {
 if ($(elem).length) {
  if ($(elem).isVisible()) {
   if (window.canLoadMore) {
    window.canLoadMore = false;
    $.get('get_uploads?count=' + filecount + '&offset=' + ((window.page - 1) * filecount), function (data) {
     let result = jQuery.parseJSON(data);
     if (result.length != 0) {
      let rows = '';
      $(result).each(function (k, v) {
       let row = upload_template;
       row = replaceAll('{FILENAME}', v.filename, row);
       row = replaceAll('{NAME}', v.realname, row);
       row = replaceAll('{SIZE}', getHumanSize(v.size), row);
       row = replaceAll('{DOWNLOAD-LINK}', './download-uploaded?id=' + v.filename, row);
       rows += row + "\r\n";
      });
      $(elem).replaceWith(rows + upload_more_template);
      window.page++;
      window.canLoadMore = true;
      getPageUploadNext(filecount, elem, upload_template, upload_more_template);
     }
    });
   }
  }
 }
}

function getVideo(src, type) {
 $.get('html/product-video-player.html', function(data) {
  data = replaceAll('{SRC}', src, data);
  data = replaceAll('{TYPE}', type, data);
  $('#video-box').replaceWith(data);
 });
}

function replaceAll (search, replace, what) {
 return what.replace(new RegExp(search.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&"), 'g'), replace);
};



function GetPage(page, params) {
 switch (page) {
  case 'hledat':
   LoadItems('search-load-items.php', params);
   break;
 }
}

function getLoginModal() {
 $("#login_modal").modal();
 $("#login_modal").on('shown.bs.modal', function() {
  $('#login_username').focus();
  login_captcha = grecaptcha.render('login-captcha', {
   'sitekey' : '6LeI1W0UAAAAALUBY5p5C6VJc4EE7ouef2GdLQHD'
  });
 });
}

function getLogin() {
  let formdata = $('#login').serialize();
  $.ajax({
   url: 'get_login',
   type: 'GET',
   data: formdata,
   contentType: false,
   processData: false
  }).done(function (response) {
   let result = jQuery.parseJSON(response);
   if (result.error != 0) {
    $('#error-message').show();
    let err = 'Neznámá chyba';
    switch (result.error) {
     case 1:
      err = 'Nepotvrdili jste, že nejste robot!';
      break;
     case 2:
      err = 'Špatně zadané uživatelské jméno!';
      break;
     case 3:
      err = 'Špatně zadané heslo!';
      break;
     case 4:
      err = 'Váš účet není aktivován! Byl Vám znovu zaslán aktivační e-mail. Prosím, klikněte na odkaz v e-mailu před prvním přihlášením!';
      break;
     case 5:
      err = 'Váš účet je zablokován!';
      break;
    }
    $('#error-message').text(err);
     grecaptcha.reset(login_captcha);
   } else window.location.reload();
  });
}

function getLogout() {
 $.get('./logout.php', function(data) {
  window.location.reload();
 });
}

function getDownload(id) {
 window.location.href = 'download.php?id=' + id;
}

function getPlayOnline(id) {
 window.location.href = 'play.php?id=' + id;
}

$.fn.isVisible = function() {
 let rect = this[0].getBoundingClientRect();
 return ((rect.height > 0 || rect.width > 0) && rect.bottom >= 0 && rect.right >= 0 && rect.top <= (window.innerHeight || document.documentElement.clientHeight) && rect.left <= (window.innerWidth || document.documentElement.clientWidth));
};
*/

/* TODO: FORMER upload.js:
window.part = 0;
window.chunksize = 20971520;
window.sizeuploaded = 0;
window.totalElapsedTime = 0;
window.totalLoaded = 0;
window.uploaders = [];

LoadUploaderTemplate();

qs('#files').on('change', function() {
 qs('#uploaders').empty();
 window.uploaders = [];
 for (let i = 0; i < this.files.length; i++) {
  AddUploader(this.files[i]);
 }
});

qs('#upload').click(function() {
 StartUpload(window.uploaders.shift());
 qs('#files-buttons').hide();
});

function AddUploader(file) {
 let uploader = $('<div>' + window.tmplUploader + '</div>').clone();
 qs('#uploaders').append(uploader);
 uploader.find('.filename').text(file.name);
 let stateHTML = '<tr><td>Stav:</td><td class="status bold pl-2" style="color: #DD6000;">Ve frontě ...</td></tr>';
 stateHTML += '<tr><td>Velikost souboru:</td><td class="pl-2">' + getHumanSize(file.size) + '</td></tr>';
 uploader.find('.state').html(stateHTML);
 window.uploaders.push({
  ui: uploader,
  file: file
 });
}

function StartUpload(uploader) {
 window.currentUi = uploader['ui'];
 window.currentFile = uploader['file'];
 getAPI({
  url: 'set_upload',
  data: { 'action': 'new' },
  success: function(data) {
   let result = jQuery.parseJSON(data);
   window.currentUi.find('.filename').get(0).scrollIntoView();
   if (result.error == 0) {
    window.part = 0;
    window.sizeuploaded = 0;
    window.totalElapsedTime = 0;
    window.totalLoaded = 0;
    let blob = GetBlob();
    Add(result.message, blob);
   } else {
    window.currentUi.find('.status').css('color', '#FF0000');
    window.currentUi.find('.status').text('Chyba: ' + result.message);
   }
  }
 });
}

function Add(filename, blob) {
 let startTime = new Date().getTime();
 let fd = new FormData();
 fd.append('files', blob);
 fd.append('action', 'add');
 fd.append('filename', filename);
 getAPI({
  contentType: false,
  processData: false,
  url: 'set_upload',
  data: fd,
  xhr: function() {
   let myXhr = $.ajaxSettings.xhr();
   if (myXhr.upload) {
    myXhr.upload.addEventListener('progress', function(e) {
     if (e.lengthComputable) {
      window.sizeuploaded = (window.part * window.chunksize) + e.loaded;
      let percent = window.currentFile.size != 0 ? (100 / window.currentFile.size) * window.sizeuploaded : 0;
      if (percent > 100) percent = 100;
      window.currentUi.find('.progress-bar').css('width', percent + '%');
      let elapsedTime = (new Date().getTime()) - startTime;
      window.totalElapsedTime += elapsedTime;
      window.totalLoaded += e.loaded;
      let stateHTML = '<tr><td>Stav:</td><td class="status bold pl-2" style="color: #0000FF;">Nahrávám na server...</td></tr>';
      stateHTML += '<tr><td>Nahráno:</td><td class="pl-2">' + Math.round(percent) + ' % (' + (window.sizeuploaded <= window.currentFile.size ? getHumanSize(window.sizeuploaded) : getHumanSize(window.currentFile.size)) + ' / ' + getHumanSize(window.currentFile.size) + ')</td></tr>';
      stateHTML += '<tr><td>Aktuální rychlost:</td><td class="pl-2">' + getHumanSize((e.loaded / elapsedTime) * 1000) + ' / s</td></tr>';
      stateHTML += '<tr><td>Průměrná rychlost:</td><td class="pl-2">' + getHumanSize((totalLoaded / totalElapsedTime) * 1000) + ' / s</td></tr>';
      window.currentUi.find('.state').html(stateHTML);
     }
    }, false);
   }
   return myXhr;
  },
  success: function(data) {
   let result = jQuery.parseJSON(data);
   if (result.error == 0) {
    window.part++;
    let blob = GetBlob();
    if (blob.size != 0) Add(filename, blob);
    else Done(filename, window.currentUi.find('.filename').text());
   } else {
    window.currentUi.find('.status').css('color', '#FF0000');
    window.currentUi.find('.status').text('Chyba: ' + result.message);
   }
  }
 });
}

function GetBlob() {
 return window.currentFile.slice(window.part * window.chunksize, (window.part + 1) * window.chunksize);
}

function Done(originalFile, newFile) {
 getAPI({
  url: 'set_upload',
  data: {
   action: 'done',
   original: originalFile,
   new: newFile
  },
  success: function(data) {
   let result = jQuery.parseJSON(data);
   window.currentUi.find('.progress-bar').removeClass('progress-bar-animated');
   if (result.error == 0) {
    window.currentUi.find('.progress-bar').addClass('bg-success');
    window.currentUi.find('.status').css('color', '#009000');
    window.currentUi.find('.status').text('Hotovo.');
    let uploader = window.uploaders.shift();
    if (uploader) StartUpload(uploader);
   } else {
    window.currentUi.find('.progress-bar').addClass('bg-danger');
    window.currentUi.find('.status').css('color', '#FF0000');
    window.currentUi.find('.status').text('Chyba: ' + result.message);
   }
  }
 });
}



function LoadUploaderTemplate() {
 getAPI({
  url: 'html/upload-item.html',
  success: function(data) {
   window.tmplUploader = data;
  }
 });
}
*/
