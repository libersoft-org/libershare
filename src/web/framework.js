class Framework {
 constructor() {
  // TODO - get page name from backend
  this.pageName = 'LiberShare';
  this.pages;
  this.menuOpened = false;
 }

 async init() {
  const pg = location.pathname.substring(location.pathname.lastIndexOf('/') + 1);
  pages = JSON.parse(await getFileContent('json/pages.json'));
  getMenu();
  getReload(pg);
  window.addEventListener('popstate', async function (e) {
   const currentPage = location.pathname.substring(location.pathname.lastIndexOf('/') + 1);
   getReload(currentPage);
  });
  qs('.modal-overlay').addEventListener('click', closeModalN);
  qs('#modal-content').addEventListener('click', function (event) {
   event.stopPropagation();
  });
 }

 async getMenu() {
  const menu = await getFileContent('html/menu.html');
  qs('#menu-desktop').innerHTML = menu;
  qs('#menu-mobile').innerHTML = menu;
 }

 menu() {
  if (menuOpened) menuClose();
  else menuOpen();
 }

 menuClose() {
  menuOpened = false;
  qs('#header .menu-toggler').src = 'img/menu.svg';
  qs('#menu-mobile').style.transform = 'translateX(-110%)';
  qs('#menu-overlay').style.transform = 'translateX(-110%)';
  qs('#header').classList.add('shadow');
 }

 menuOpen() {
  menuOpened = true;
  qs('#header .menu-toggler').src = 'img/close.svg';
  qs('#menu-mobile').style.transform = 'translateX(0)';
  qs('#menu-overlay').style.transform = 'translateX(0)';
  qs('#header').classList.remove('shadow');
 }

 async getReload(page) {
  window.history.replaceState('', '', page == '' ? '' : page);
  await getPageContent(page);
 }

 async getPage(page) {
  if (menuOpened) menuClose();
  window.history.pushState('', '', page == '' ? '/' : page);
  await getPageContent(page);
 }

 async getPageContent(page) {
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
  var headers = qsa('.accordion .header');
  headers.forEach(function (header) {
   header.addEventListener('click', function () {
    var body = this.nextElementSibling;
    if (body.style.height === '0px' || body.style.height === '') {
     body.style.height = body.scrollHeight + 'px';
     header.firstElementChild.style.transform = 'translateY(-50%) rotate(180deg)';
    } else {
     body.style.height = '0px';
     header.firstElementChild.style.transform = 'translateY(-50%) rotate(0deg)';
    }
   });
  });
  const sess = localStorage.getItem('libershare_session_guid');
  if (sess && sess.length > 16) {
   qs('.menu-username').textContent = localStorage.getItem('libershare_username');
   qsa('.need-login').forEach((element) => {
    element.classList.add('hidden-important');
    element.classList.remove('flex-important');
   });
   qsa('.need-logout').forEach((element) => {
    element.classList.remove('hidden-important');
    element.classList.add('flex-important');
   });
  } else {
   qsa('.need-login').forEach((element) => {
    element.classList.remove('hidden-important');
    element.classList.add('flex-important');
   });
   qsa('.need-logout').forEach((element) => {
    element.classList.add('hidden-important');
    element.classList.remove('flex-important');
   });
   qs('.menu-username').textContent = '';
  }
 }

 async getFileContent(file) {
  const content = await fetch(file, { headers: { 'cache-control': 'no-cache' } });
  return content.text();
 }

 async getAPI(name, body = null) {
  let post;
  if (body != null) {
   post = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
   };
  } else {
   post = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
   };
  }
  const res = await fetch('api/' + name, post);
  if (res.ok) return await res.json();
  else return false;
 }

 async getModal(title, body) {
  const html = await getFileContent('html/modal.html');
  const modal = document.createElement('div');
  modal.innerHTML = html.replace('{TITLE}', title).replace('{BODY}', body);
  qs('body').appendChild(modal);
 }

 closeModal() {
  qs('.modal').remove();
 }

 getLoader() {
  return '<div class="loader"></div>';
 }

 escapeHTML(text) {
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

 getHumanSize(bytes) {
  const type = ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
  let i = 0;
  while (bytes >= 1024) {
   bytes /= 1024;
   i++;
  }
  return Math.round(bytes * 100) / 100 + ' ' + type[i] + 'B';
 }

 translate(template, dictionary) {
  for (const key in dictionary) template = template.replaceAll(key, dictionary[key]);
  return template;
 }

 qs(query) {
  return document.querySelector(query);
 }

 qsa(query) {
  return document.querySelectorAll(query);
 }

 async generateCaptcha() {
  try {
   const response = await fetch('/api/generate_captcha', { method: 'GET' });
   if (!response.ok) throw new Error('Network response was not OK');
   const data = await response.json();
   return data;
  } catch (error) {
   return null;
  }
 }

 verifyCaptcha() {
  const userResponse = qs('#captcha-input').value;
  const captchaText = qs('#captcha-container canvas').getAttribute('data-captcha');
  if (userResponse === captchaText) alert('CAPTCHA je správná!');
  else {
   alert('CAPTCHA je nesprávná. Zkuste to znovu.');
   qs('#captcha-input').value = '';
   qs('#captcha-container').innerHTML = '';
   generateCaptcha();
  }
 }

 openLoginModal() {
  const modal = qs('#login_modal');
  modal.style.display = 'block';
 }

 makeDraggable(modal) {
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

 async openModal(type) {
  let content;
  if (type === 'login') content = await getFileContent('html/login.html');
  else if (type === 'registration') {
   content = await getFileContent('html/registration.html');
   content = content.replace('{DAYS}', days.map((day) => `<option value="${day}">${day}</option>`).join(''));
   content = content.replace('{MONTHS}', months.map((month, index) => `<option value="${index + 1}">${month}</option>`).join(''));
   content = content.replace('{YEARS}', years.map((year) => `<option value="${year}">${year}</option>`).join(''));
  }
  const modwin = qs('#modal-win');
  modwin.style.display = 'flex';
  modwin.querySelector('#modal-content').innerHTML = content;
  makeDraggable(modwin.querySelector('#modal-content'));
  setTimeout(async () => {
   capt = await generateCaptcha();
   const imgElement = qs('#captcha-container');
   imgElement.style.backgroundColor = 'red';
   imgElement.src = capt.image;
   const cid = qs('#cid');
   cid.value = capt.capid;
  });
 }

 closeModalN() {
  qs('#modal-win').style.display = 'none';
 }

 async regenCaptcha() {
  const capt = await generateCaptcha();
  const imgElement = qs('#captcha-container');
  imgElement.style.backgroundColor = 'red';
  imgElement.src = capt.image;
  const cid = qs('#cid');
  cid.value = capt.capid;
 }

 closeLoginModal() {
  qs('#login_modal').style.display = 'none';
 }
}
