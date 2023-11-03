class Framework {
 constructor() {
  // TODO - get page name from backend
  this.pageName = 'LiberShare';
  this.menuOpened = false;
  this.pathAPI = '/api/';
  this.pathHTML = '/html/';
  this.pathImages = '/img/';
  this.pathJSON = '/json/';
  this.eventPageLoaded = new Event('page-loaded');
 }

 async init() {
  this.pages = JSON.parse(await this.getFileContent(this.pathJSON + 'pages.json'));
  this.setPath(location.pathname);
  this.getMenu();
  await this.getReload();
  window.addEventListener('popstate', async () => await this.getReload());
 }

 setPath(path) {
  if (path) {
   if (!path.endsWith('/')) path += '/';
   if (!path.startsWith('/')) path = '/' + path;
  } else path = '/';
  this.path = path;
  this.pathArr = path.split('/').filter((item) => item !== '');
 }

 async getMenu() {
  const menu = await this.getFileContent(this.pathHTML + 'menu.html');
  this.qs('#menu-desktop').innerHTML = menu;
  this.qs('#menu-mobile').innerHTML = menu;
  this.getMenuSwitch();
 }

 getMenuSwitch() {
  const mdActive = this.qsa('#menu-desktop .menu-item.active');
  const mmActive = this.qsa('#menu-mobile .menu-item.active');
  if (mdActive.length == 1) mdActive[0].classList.remove('active');
  if (mmActive.length == 1) mmActive[0].classList.remove('active');
  var item = this.pathArr[0];
  if (!item) item = 'news';
  if (this.pathArr[0] in this.pages) {
   const mdItem = this.qs('#menu-desktop .menu-item.menu-' + item);
   const mmItem = this.qs('#menu-mobile .menu-item.menu-' + item);
   if (mdItem) mdItem.classList.add('active');
   if (mmItem) mmItem.classList.add('active');
  }
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

 async getReload() {
  return await this.processPath(this.path, 'replaceState');
 }

 async getPage(path) {
  if (this.menuOpened) this.menuClose();
  return await this.processPath(path, 'pushState');
 }

 async processPath(path, historyMethod) {
  this.setPath(path);
  window.history[historyMethod]('', '', this.path);
  this.getMenuSwitch();
  if (!this.pathArr || this.pathArr.length == 0) this.pathArr = ['news'];
  let content = '';
  document.title = this.pageName + ' - ' + this.pages[(this.pathArr[0] in this.pages ? this.pathArr[0] : 'notfound')].label;
  content = await this.getFileContent(this.pathHTML + (this.pathArr[0] in this.pages ? this.pages[this.pathArr[0]].file : 'notfound.html'));
  this.qs('#content').innerHTML = content;
  document.dispatchEvent(this.eventPageLoaded);
 }

 async getModal(title, body) {
  this.closeModal();
  const html = await this.getFileContent(this.pathHTML + 'modal.html');
  const modal = document.createElement('div');
  modal.innerHTML = this.translate(html, { '{TITLE}': title, '{BODY}': body });
  
  // TODO - DRAGABLE NOT WORKING:
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;
  const header = modal.querySelector('.title');
  header.onmousedown = (e) => {
   //e.stopPropagation();
   e.preventDefault();
   isDragging = true;
   const rect = modal.getBoundingClientRect();
   offsetX = e.clientX - rect.left;
   offsetY = e.clientY - rect.top;
  };
  document.onmousemove = (e) => {
   if (!isDragging) return;
   modal.style.left = e.clientX - offsetX + 'px';
   modal.style.top = e.clientY - offsetY + 'px';
  };
  document.onmouseup = () => (isDragging = false);

  document.body.appendChild(modal);
 }

 closeModal() {
  const m = this.qs('.modal');
  const mo = this.qs('.modal-overlay');
  if (m) m.remove();
  if (mo) mo.remove();
 }

 accordionToggle(el) {
  const caret = el.querySelector('.caret');
  const body = el.parentElement.querySelector('.body');
  caret.classList.toggle('open');
  if (body.style.height === '0px' || body.style.height === '') {
   const bodyHeight = body.scrollHeight;
   body.style.height = bodyHeight + 'px';
  } else {
   body.style.height = body.scrollHeight + 'px';
   window.getComputedStyle(body).height;
   body.style.height = '0px';
  }
  body.addEventListener('transitionend', function transitionEndListener() {
   if (body.style.height !== '0px') body.style.height = 'auto';
   body.removeEventListener('transitionend', transitionEndListener);
  });
 }

 // TODO: use getAPI instead of fetch:
 async getCaptcha() {
  try {
   const response = await fetch(this.pathAPI + 'get_captcha');
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

 getHumanSize(bytes) {
  const units = ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
   bytes /= 1024;
   i++;
  }
  return bytes.toFixed(2) + ' ' + units[i] + 'B';
 }

 getLoader() {
  return '<div class="loader"></div>';
 }
}
