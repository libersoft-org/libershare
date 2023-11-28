class Framework {
 constructor() {
  // TODO - get page name from backend
  this.pageName = 'LiberShare';
  this.menuOpened = false;
  this.pathAPI = '/api/';
  this.pathJSON = '/json/';
  this.eventPageLoaded = new Event('page-loaded');
 }

 async init() {
  this.pages = JSON.parse(await this.getFileContent(this.pathJSON + 'pages.json'));
  await this.getHTMLFiles();
  document.head.appendChild(document.createElement('style')).textContent = await this.getCSS();
  await this.getImagesFiles();
  this.qs('#splash-style').remove();
  document.body.innerHTML = this.translate(this.getHTML('main'), {
   '{ICON-MENU}': this.getImage('menu.svg'),
   '{ICON-LOGO}': this.getImage('logo.webp')
  });
  document.body.style.backgroundImage = 'url(\'' + this.getImage('background.svg') + '\')';
  this.setPath(location.pathname);
  this.getMenu();
  this.getReload();
  window.addEventListener('popstate', () => this.getReload());
 }

 async getHTMLFiles() {
  this.htmlArr = (await this.getAPI('get_html')).data;
 }

 getHTML(name) {
  if (!this.htmlArr.hasOwnProperty(name)) return '';
  return this.htmlArr[name];
 }

 async getCSS() {
  return (await this.getAPI('get_css', { groups: ['common', 'user', 'components'] })).data;
 }

 async getImagesFiles() {
  this.imgArr = (await this.getAPI('get_images_basic', { groups: ['common', 'user'] })).data;
 }

 getImage(name) {
  if (!this.imgArr.hasOwnProperty(name)) return null;
  return this.imgArr[name];
 }

 setPath(path) {
  if (path) {
   if (!path.endsWith('/')) path += '/';
   if (!path.startsWith('/')) path = '/' + path;
  } else path = '/';
  this.path = path;
  this.pathArr = path.split('/').filter((item) => item !== '');
 }

 getMenu() {
  let menu = this.translate(this.getHTML('menu'), {
   '{ICON-NEWS}': this.getImage('news.svg'),
   '{ICON-CATEGORIES}': this.getImage('categories.svg'),
   '{ICON-UPLOAD}': this.getImage('upload.svg'),
   '{ICON-FORUM}': this.getImage('forum.svg'),
   '{ICON-FAQ}': this.getImage('faq.svg'),
   '{ICON-TERMS}': this.getImage('terms.svg'),
   '{ICON-CONTACT}': this.getImage('contact.svg'),
   '{ICON-SEARCH}': this.getImage('search.svg'),
   '{ICON-SETTINGS}': this.getImage('settings.svg'),
   '{ICON-LOGIN}': this.getImage('login.svg')
  });
  const mobileSearch = this.translate(this.getHTML('mobile-search'), {'{ICON-SEARCH}': this.getImage('search.svg')});
  this.qs('#menu-desktop').innerHTML = menu;
  this.qs('#menu-mobile').innerHTML = menu;
  this.qs('#mobile-search').innerHTML = mobileSearch;
  this.getMenuSwitch();
 }

 getMenuSwitch() {
  const mdActive = this.qsa('#menu-desktop .item.active');
  const mmActive = this.qsa('#menu-mobile .item.active');
  if (mdActive.length == 1) mdActive[0].classList.remove('active');
  if (mmActive.length == 1) mmActive[0].classList.remove('active');
  let item = this.pathArr[0];
  if (!item) item = 'news';
  if (item in this.pages) {
   const mdItem = this.qs('#menu-desktop .item.menu-' + item);
   const mmItem = this.qs('#menu-mobile .item.menu-' + item);
   if (mdItem) mdItem.classList.add('active');
   if (mmItem) mmItem.classList.add('active');
  }
 }

 menu() {
  this.menuOpened ? this.menuClose() : this.menuOpen();
 }

 menuClose() {
  this.menuOpened = false;
  this.qs('#header .menu-toggler').src = this.getImage('menu.svg');
  this.qs('#menu-mobile').style.transform = 'translateX(-110%)';
  this.qs('#menu-overlay').style.transform = 'translateX(-110%)';
  this.qs('#header').classList.add('shadow');
 }

 menuOpen() {
  this.menuOpened = true;
  this.qs('#header .menu-toggler').src = this.getImage('close.svg');
  this.qs('#menu-mobile').style.transform = 'translateX(0)';
  this.qs('#menu-overlay').style.transform = 'translateX(0)';
  this.qs('#header').classList.remove('shadow');
 }

 getReload() {
  return this.processPath(location.pathname, 'replaceState');
 }

 getPage(path) {
  if (this.menuOpened) this.menuClose();
  return this.processPath(path, 'pushState');
 }

 processPath(path, historyMethod) {
  this.setPath(path);
  window.history[historyMethod]('', '', this.path);
  this.getMenuSwitch();
  if (!this.pathArr || this.pathArr.length == 0) this.pathArr = ['news'];
  document.title = this.pageName + ' - ' + this.pages[(this.pathArr[0] in this.pages ? this.pathArr[0] : 'notfound')].label;
  this.qs('#content').innerHTML = this.getHTML(this.pathArr[0] in this.pages ? this.pages[this.pathArr[0]].file : 'notfound');
  document.dispatchEvent(this.eventPageLoaded);
 }

 async getModal(title, body) {
  this.closeModal();
  const html = this.getHTML('modal');
  const allModalComponents = document.createElement('div');
  allModalComponents.id = 'modal-area';
  allModalComponents.innerHTML = this.translate(html, {
   '{TITLE}': title,
   '{BODY}': body,
   '{ICON-CLOSE}': this.getImage('close.svg')
  });

  const movableModalElement = allModalComponents.querySelector('.modal');
  let isDragging = false;

  const header = movableModalElement.querySelector('.title');
  header.onmousedown = (e) => {
   //e.stopPropagation();
   e.preventDefault();
   isDragging = true;
   const clickPosX = e.clientX - movableModalElement.offsetLeft;
   const clickPosY = e.clientY - movableModalElement.offsetTop;
   
   document.onmousemove = (e) => {
    if (!isDragging) return;

    const modalAreaRect = document.querySelector('#modal-area').getBoundingClientRect();
    const movableRect = movableModalElement.getBoundingClientRect();

    const offsetX = e.clientX - clickPosX;
    const offsetY = e.clientY - clickPosY;

    const maxX = modalAreaRect.width - movableRect.width;
    const maxY = modalAreaRect.height - movableRect.height;

    const x = Math.min(Math.max(offsetX, 0), maxX);
    const y = Math.min(Math.max(offsetY, 0), maxY);

    movableModalElement.style.left = x + 'px';
    movableModalElement.style.top = y + 'px';
   };
   document.onmouseup = () => (isDragging = false);
  };

  document.body.appendChild(allModalComponents);
 }

 closeModal() {
  const allModalComponents = this.qs('#modal-area');
  if (allModalComponents) allModalComponents.remove();
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
   body: body ? JSON.stringify(body) : '{}'
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

 /**
 * Property tester - optional chaining
 ** https://silvantroxler.ch/2017/avoid-cannot-read-property-of-undefined/
 * @param {Function} - function with chaning property
 * @param {Value} - optional overide default null value for catch return
 * DEMO USE
 * - if (propertyTester(() => data.plugins.superplugin.items.id)) {...
 */
  propertyTester(fn, defaultVal = null) {
    if (typeof fn !== 'function') {
      console.error('[property tester] first argument not function!');
    }
    try {
      return fn();
    } catch (e) {
      return defaultVal;
    }
  }
}
