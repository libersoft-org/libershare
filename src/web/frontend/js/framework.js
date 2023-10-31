class Framework {
 constructor() {
  // TODO - get page name from backend
  this.pageName = 'LiberShare';
  this.pages;
  this.menuOpened = false;
  this.pathAPI = '/api/';
  this.pathHTML = '/html/';
  this.pathJSON = '/json/';
  this.pathImages = '/img/';
 }

 async init() {
  const getPath = () => location.pathname.substring(location.pathname.lastIndexOf('/') + 1);
  this.pages = JSON.parse(await this.getFileContent(this.pathJSON + 'pages.json'));
  this.getMenu();
  this.getReload(getPath());
  window.addEventListener('popstate', () => this.getReload(getPath()));
  this.qs('.modal-overlay').addEventListener('click', this.closeModalN);
  this.qs('#modal-content').addEventListener('click', (event) => event.stopPropagation());
 }

 async getMenu() {
  const menu = await this.getFileContent(this.pathHTML + 'menu.html');
  this.qs('#menu-desktop').innerHTML = menu;
  this.qs('#menu-mobile').innerHTML = menu;
 }

 menu() {
  this.menuOpened ? this.menuClose() : this.menuOpen();
 }

 menuClose() {
  this.menuOpened = false;
  this.qs('#header .menu-toggler').src = this.pathImages + 'menu.svg';
  this.qs('#menu-mobile').style.transform = 'translateX(-110%)';
  this.qs('#menu-overlay').style.transform = 'translateX(-110%)';
  this.qs('#header').classList.add('shadow');
 }

 menuOpen() {
  this.menuOpened = true;
  this.qs('#header .menu-toggler').src = this.pathImages + 'close.svg';
  this.qs('#menu-mobile').style.transform = 'translateX(0)';
  this.qs('#menu-overlay').style.transform = 'translateX(0)';
  this.qs('#header').classList.remove('shadow');
 }

 async getReload(page) {
  window.history.replaceState('', '', page == '' ? '/' : page);
  await f.getPageContent(page);
 }

 async getPage(page) {
  if (this.menuOpened) this.menuClose();
  window.history.pushState('', '', page == '' ? '/' : page);
  await f.getPageContent(page);
 }

 async getPageContent(page) {
  if (page == '') page = 'news';
  let content = '';
  if (this.qsa('#menu-desktop .item.active').length == 1) this.qsa('#menu-desktop .item.active')[0].classList.remove('active');
  if (this.qsa('#menu-mobile .item.active').length == 1) this.qsa('#menu-mobile .item.active')[0].classList.remove('active');
  if (page in this.pages) {
   document.title = this.pageName + ' - ' + this.pages[page].label;
   if (this.qs('#menu-desktop .item.menu-' + page)) this.qs('#menu-desktop .item.menu-' + page).classList.add('active');
   if (this.qs('#menu-mobile .item.menu-' + page)) this.qs('#menu-mobile .item.menu-' + page).classList.add('active');
   // TODO: only if page exists:
   content = await this.getFileContent(this.pathHTML + this.pages[page].file);
  } else if (page.includes('-')) {
   if (page.startsWith('product-')) content = await this.getFileContent(this.pathHTML + 'product.html');
   else if (page.startsWith('category-')) content = await this.getFileContent(this.pathHTML + 'category.html');
   else {
    document.title = this.pageName + ' - ' + this.pages['notfound'].label;
    content = await this.getFileContent(this.pathHTML + 'notfound.html');
   }
  } else {
   document.title = this.pageName + ' - ' + this.pages['notfound'].label;
   content = await this.getFileContent(this.pathHTML + 'notfound.html');
  }
  this.qs('#content').innerHTML = content;

  // TODO: move this to script.js:
  if (page === 'news') await getPageNews();
  else if (page === 'categories') await getPageCategories();
  else if (page == 'upload') await getPageUpload();
  else if (page == 'search') await getPageSearch();
  else if (page == 'forum') await getPageForum();
  else if (page.startsWith('category-')) await getPageCategory(page.substring(9));
  else if (page.startsWith('product-')) await getPageProduct(page.split('-')[1]);
  var headers = this.qsa('.accordion .header');
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
   this.qs('.menu .username').textContent = localStorage.getItem('libershare_username');
   this.qs('.menu .username').textContent = '';
  }
 }

 async getFileContent(file) {
  return (await fetch(file, { headers: { 'cache-control': 'no-cache' } })).text();
 }

 async getAPI(name, body = null) {
  const res = await fetch(this.pathAPI + name, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: body && JSON.stringify(body)
  });
  return res.ok ? await res.json() : false;
 }

 async getModal(title, body) {
  const html = await this.getFileContent(this.pathHTML + 'modal.html');
  const modal = document.createElement('div');
  modal.innerHTML = html.replace('{TITLE}', title).replace('{BODY}', body);
  this.qs('body').appendChild(modal);
 }

 closeModal() {
  this.qs('.modal').remove();
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
  document.addEventListener('mouseup', () => (isDragging = false));
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

 escapeHTML(text) {
  let map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, (m) => map[m]);
 }

 // TODO: use getAPI instead of fetch:
 async generateCaptcha() {
  try {
   const response = await fetch(this.pathAPI + 'generate_captcha');
   if (!response.ok) throw new Error('Network response was not OK');
   return await response.json();
  } catch (error) {
   return null;
  }
 }

 verifyCaptcha() {
  const userResponse = this.qs('#captcha-input').value;
  const captchaText = this.qs('#captcha-container canvas').getAttribute('data-captcha');
  if (userResponse != captchaText) {
   // TODO - error message?
   this.qs('#captcha-input').value = '';
   this.qs('#captcha-container').innerHTML = '';
   this.generateCaptcha();
  }
 }

 async regenCaptcha() {
  const capt = await this.generateCaptcha();
  const imgElement = this.qs('#captcha-container');
  imgElement.style.backgroundColor = 'red';
  imgElement.src = capt.image;
  const cid = this.qs('#cid');
  cid.value = capt.capid;
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

 getLoader() {
  return '<div class="loader"></div>';
 }
}
