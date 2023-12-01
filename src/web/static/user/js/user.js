const f = new Framework();

let loading = false;
let offset = 0;
let categoryId = null;

window.onload = async () => {
 document.addEventListener('page-loaded', () => getPageContent());
 await f.init();
};

async function getPageContent() {
 categoryId = null;
 loading = false;
 offset = 0;
 const pageHandlers = {
  news: getPageNews,
  categories: getPageCategories,
  uploads: getPageUploads,
  search: getPageSearch,
  forum: getPageForum,
  item: getPageItem,
  faq: getPageFAQ,
  contact: getPageContact
 };
 const pageHandler = pageHandlers[f.pathArr[0]];

 if (pageHandler) await pageHandler(f.pathArr);
 const sess = localStorage.getItem('libershare_session_guid');
 if (sess && sess.length > 16) {
  this.qs('.menu .username').textContent = localStorage.getItem('libershare_username');
  this.qs('.menu .username').textContent = '';
 }
}

async function getPageNews() {
 for (const cat of (await f.getAPI('get_categories', { items: true })).data) {
  const items = await f.getAPI('get_items', {
   id_category: cat.id,
   hidden: false,
   files: true,
   direction: true,
   count: 12,
   offset: 0
  });
  const imgFiles = [];
  for (item of items.data) imgFiles.push(item.image_sm);
  const imgData = (await f.getAPI('get_images_items', { files: imgFiles })).data;
  let prows = '';
  for (const item of items.data) {
   prows += f.translate(f.getHTML('items-item'), {
    '{NAME}': item.name,
    '{LINK}': item.link,
    '{IMAGE}': imgData[item.image_sm] ? (item.adult ? f.getImage('item-censored.webp') : imgData[item.image_sm]) : f.getImage('item-default.webp')
   });
  }
  const crow = f.translate(f.getHTML('news-category'), {
   '{LINK}': cat.link,
   '{CATEGORY}': cat.name,
   '{ITEMS}': prows
  });
  f.qs('#content .news').innerHTML += crow;
 }
 f.qs('#content .loader').remove();
}



async function getPageCategories(pathArr = null) {
 const elCategory = f.qs('#content .categories');
 if (pathArr.length == 2) {
    const temp_cat = f.getHTML('categories-category');
    if (pathArr[1] == 'all') {
      const cats = await f.getAPI('get_categories', { items: true });
      let itemsCount = 0;
      for (const cat of cats.data) itemsCount += cat.items_count - cat.items_count_hidden;
      elCategory.innerHTML = f.translate(temp_cat, {
        '{CATEGORY}': 'All',
        '{COUNT}': itemsCount
      });
      await getPageCategoriesMore(null, 12);
    } else {
      const cat = await f.getAPI('get_category_by_link', { link: pathArr[1] });
      if (cat && cat.data) {
        elCategory.innerHTML = f.translate(temp_cat, {
        '{CATEGORY}': cat.data.name,
        '{COUNT}': cat.data.items_count - cat.data.items_count_hidden,
        });
        await getPageCategoriesMore(cat.data.id, 12);
      } else {
        elCategory.innerHTML = f.getHTML('categories-category-notfound');
      }
    }
  } else {
    categoryId = 'root'; // stop listing all items from all categories for root category list
    elCategory.innerHTML = f.getHTML('categories-list');
    const temp_item = f.getHTML('categories-item');
    const cats = await f.getAPI('get_categories', { items: true });
    let catsItemsCount = 0;
    let crows = '';
    if (cats && cats.data) {
    const imgFiles = [];
    for (cat of cats.data) imgFiles.push(cat.image);
    const imgData = await f.getAPI('get_images_categories', { files: imgFiles });
    for (const cat of cats.data) {
      const catItemsCount = cat.items_count - cat.items_count_hidden;
      crows += f.translate(temp_item, {
      '{LINK}': cat.link,
      '{NAME}': cat.name,
      '{IMAGE}': imgData.data[cat.image] ? imgData.data[cat.image] : f.getImage('item-default.webp'),
      '{COUNT}': catItemsCount
      });
      catsItemsCount += catItemsCount;
    }
    }
    f.qs('#content .categories .items').innerHTML = f.translate(temp_item, {
    '{LINK}': 'all',
    '{NAME}': 'All',
    '{IMAGE}': f.getImage('item-all.webp'),
    '{COUNT}': catsItemsCount
    }) + crows;
  }

  if (f.pathArr[1] !== 'all') {
    const categoryByLink = await f.getAPI('get_category_by_link', { link: f.pathArr[1] });
    if (f.propertyTester(() => categoryByLink.data.id)) {
      categoryId = categoryByLink.data.id;
    }
  }

  /* onscroll category items - lazy loading */
  const contentContainer = f.qs('#content');
  if (!contentContainer.onscroll) {
    contentContainer.onscroll = async () => {
      await getPageCategoriesMore(categoryId, 12);
    }
  }
}



async function getPageCategoriesMore(id = null, count = 12) {
// console.log(id, count, offset);
 const loader = f.qs('#content .loader');
 if (loading || !isElementVisible(loader)) return;
 loading = true;
 const items = await f.getAPI('get_items', {
  id_category: id,
  hidden: false,
  files: true,
  direction: true,
  count: count,
  offset: offset
 });

  if (!items.data) {
    loader.remove();
    loading = false;
    return;
  }

 if (items && items.data && items.data.length == 0) {
  loader.remove();
  loading = false;
 } else {
  const imgFiles = [];
  for (item of items.data) imgFiles.push(item.image_sm);
  const imgData = (await f.getAPI('get_images_items', { files: imgFiles })).data;
  let prows = '';
  for (const item of items.data) {
   let prow = f.translate(f.getHTML('items-item'), {
    '{NAME}': item.name,
    '{LINK}': item.link,
    '{IMAGE}': imgData[item.image_sm] ? imgData[item.image_sm] : f.getImage('item-default.webp')
   });
   prows += prow;
  }
  f.qs('#content .items').innerHTML += prows;
  offset += count;
  loading = false;
  if (items.data.length == count) getPageCategoriesMore(id, count, offset);
  else loader.remove();
 }
}

async function getPageItem(pathArr = null) {
 const item = await f.getAPI('get_item_by_link', { link: pathArr[1] });
 if (item.data) {
  const cat = await f.getAPI('get_category_by_id', { id: item.data.id_categories });
  const files = await f.getAPI('get_files', { id_item: item.data.id });
  const temp_files = f.translate(f.getHTML('item-file'), { '{ICON-DOWNLOAD}': f.getImage('download.svg') });
  const temp_play = f.translate(f.getHTML('item-play-button'), { '{ICON-PLAY}': f.getImage('play.svg') });
  let rows = '';
  const extVideo = ['.mp4', '.webm', '.ogg'];
  for (const fd of files.data) {
   let html_play = '';
   if (extVideo.some(ext => fd.file_name.endsWith(ext))) {
    html_play = f.translate(temp_play, {
     '{HASH}': fd.name,
     '{NAME}': fd.file_name,
    });
   }
   rows += f.translate(temp_files, {
    '{NAME}': fd.file_name,
    '{SIZE}': f.getHumanSize(fd.size),
    '{DOWNLOAD-HASH}': fd.name,
    '{DOWNLOAD-NAME}': fd.file_name,
    '{PLAY-ONLINE}': html_play
   });
  }
  const imgData = await f.getAPI('get_images_item', { file: item.data.image });
  const html = f.translate(f.getHTML('item-detail'), {
   '{CATEGORY-LINK}': cat.data.link,
   '{CATEGORY}': cat.data.name,
   '{NAME}': item.data.name,
   '{IMAGE}': imgData.data ? imgData.data : f.getImage('item-default.webp'),
   '{FILES}': rows
  });
  f.qs('#content').innerHTML = html;
 } else f.qs('#content').innerHTML = f.getHTML('item-detail-notfound');
}

async function getPageForum(pathArr = null) {
 if (pathArr.length == 2) await getPageForumThread(pathArr[1]);
 else {
  f.qs('#content').innerHTML = f.getHTML('forum-threads');
  f.qs('#content .body .buttons').innerHTML = f.translate(f.getHTML('forum-threads-buttons'), { '{ICON-NEW}': f.getImage('news.svg') });
  await getPageForumThreadsMore(10);
  const content = f.qs('#content');
  if (!content.onscroll) content.onscroll = async () => await getPageForumThreadsMore(10);
 }
}

async function getPageForumThreadsMore(count = 10) {
 // TODO: check why page is loading the same offset again:
 //console.log(count, offset);
 const loader = f.qs('#content .loader');
 if (loading  || !isElementVisible(loader)) return;
 loading = true;
 const threads = await f.getAPI('get_forum_threads', {
  count: count,
  offset: offset,
  direction: true
 });
 if (!threads || !threads.data || threads.data.length == 0) {
  loader.remove();
  loading = false;
 } else {
  let rows = '';
  for (const thread of threads.data) {
   rows += f.translate(f.getHTML('forum-threads-row'), {
    '{ID}': thread.id,
    '{TOPIC}': f.escapeHTML(thread.topic),
    '{USERNAME}': thread.username,
    '{POSTS}': thread.posts_count,
    '{CREATED}': new Date(thread.created).toLocaleString(),
    '{SEX}': thread.sex ? 'text-blue' : 'text-red'
   });
  }
  f.qs('#content .forum tbody').innerHTML += rows;
  offset += count;
  loading = false;
  if (threads.data.length == count) getPageForumThreadsMore(count);
  else loader.remove();
 }
}

async function getPageForumThread(id) {
 const thread = (await f.getAPI('get_forum_thread', { id: id })).data;
 f.qs('#content').innerHTML = f.translate(f.getHTML('forum-thread'), {
  '{THREAD-TOPIC}': thread.topic,
  '{THREAD-SEX}': thread.sex ? 'text-blue' : 'text-red',
  '{THREAD-USER}': thread.username,
  '{THREAD-CREATED}': new Date(thread.created).toLocaleString(),
  '{THREAD-BODY}': getTextWithLinks(thread.body),
  '{POST}': f.getHTML('forum-post-new-error')
 });
 getPageForumPostsMore(id, 2);
 const elPosts = f.qs('#content .body .posts');
 // TODO: onscroll is not working:
 if (!elPosts.onscroll) elPosts.onscroll = async () => await getPageForumPostsMore(id, 2);
}

async function getPageForumPostsMore(id, count = 10) {
 // TODO: check why page is loading the same offset again:
 //console.log(count, offset);
 const loader = f.qs('#content .loader');
 if (loading  || !isElementVisible(loader)) return;
 loading = true;
 const posts = await f.getAPI('get_forum_posts', {
  id: id,
  count: count,
  offset: offset,
  direction: true
 });
 if (!posts || !posts.data || posts.data.length == 0) {
  loader.remove();
  loading = false;
 } else {
  let rows = '';
  for (const post of posts.data) {
   rows += f.translate(f.getHTML('forum-post-row'), {
    '{POST-USER}': post.username,
    '{POST-DATE}': new Date(post.created).toLocaleString(),
    '{POST-BODY}': getTextWithLinks(post.body)
   });
  }
  f.qs('#content .body .posts').innerHTML += rows;
  offset += count;
  loading = false;
  if (posts.data.length == count) getPageForumPostsMore(id, count);
  else loader.remove();
 }
}

async function getPageUploads() {
 const temp_upload_detail = f.translate(f.getHTML('uploads-detail'), { '{ICON-UPLOAD}': f.getImage('upload.svg') });
 f.qs('#content .body .upload').innerHTML = temp_upload_detail;
 const temp_file = f.translate(f.getHTML('uploads-file'), { '{ICON-DOWNLOAD}': f.getImage('download.svg') });
 const files = await f.getAPI('get_uploads', { order: 'created', direction: true, count: 10 });
 if (files.data) {
  let rows = '';
  for (const item of files.data) {
   rows += f.translate(temp_file, {
    '{NAME}': item.real_name,
    '{SIZE}': f.getHumanSize(item.size),
    '{LINK}': '/upload/' + item.file_name + '/' +  item.real_name
   });
  }
  f.qs('#content .files').innerHTML = rows; 
 } else f.qs('#content .uploads').remove();
}

async function getPageSearch() {
 let phrase = f.escapeHTML(f.qs('#header .search .text').value.trim());

 if (isMobileSearchActive()) {
  phrase = f.escapeHTML(f.qs('#mobile-search .text').value.trim());
 }

 if (phrase) {
  if (isMobileSearchActive()) toggleMobileSearch();
  f.qs('#content .breadcrumb .active').innerHTML = 'Search: ' + phrase;
  const items = await f.getAPI('get_items', {
   search: phrase,
   hidden: false,
   files: true,
   direction: true,
   count: 12,
   offset: 0
  });
  if (items.data.length > 0) {
   let prows = '';
   const imgFiles = [];
   for (item of items.data) imgFiles.push(item.image_sm);
   const imgData = (await f.getAPI('get_images_items', { files: imgFiles })).data;
   for (const item of items.data) {
    let prow = f.translate(f.getHTML('items-item'), {
     '{NAME}': item.name,
     '{LINK}': item.link,
     '{IMAGE}': imgData[item.image_sm] ? (item.adult ? f.getImage('item-censored.webp') : imgData[item.image_sm]) : f.getImage('item-default.webp')
    });
    prows += prow;
   }
   f.qs('#content .items').innerHTML = prows;
  } else {
   f.qs('#content .search-result').innerHTML = f.getHTML('search-notfound');
   f.qs('#content .loader').remove();
  }
 } else {
  f.qs('#content .breadcrumb .active').innerHTML = 'Search';
  f.qs('#content .search-result').innerHTML = f.getHTML('search-notentered');
  f.qs('#content .loader').remove();
 }
}

async function getPageFAQ() {
 f.qs('#content .faq').innerHTML = f.translate(f.getHTML('faq-items'), { '{ICON-DOWN}': f.getImage('down.svg') });
}

async function getPageContact() {
 f.qs('#content .buttons').innerHTML = f.translate(f.getHTML('contact-buttons'), { '{ICON-SEND}': f.getImage('send.svg') });
}

async function getModalLogin() {
 await f.getModal('Login', f.translate(f.getHTML('modal-login'), {
  '{ICON-LOGIN}': f.getImage('login.svg'),
  '{ICON-RELOAD}': f.getImage('reload.svg'),
 }));
 const captcha = await f.getAPI('get_captcha');
 const elCaptcha = f.qs('.modal .body .captcha');
 elCaptcha.style.backgroundColor = 'red';
 elCaptcha.src = captcha.image;
 const cid = f.qs('#cid');
 cid.value = captcha.capid;
}

async function getModalRegistration() {
 const days = Array.from({ length: 31 }, (_, i) => i + 1);
 const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
 const years = Array.from({ length: 100 }, (_, i) => new Date().getFullYear() - i);
 let body = f.translate(f.getHTML('modal-registration'), { '{ICON-RELOAD}': f.getImage('reload.svg') });
 body = body.replace('{DAYS}', days.map((day) => '<option value="' + day + '">' + day + '</option>').join(''));
 body = body.replace('{MONTHS}', months.map((month, index) => '<option value="' + (index + 1) + '">' + month + '</option>').join(''));
 body = body.replace('{YEARS}', years.map((year) => '<option value="' + year + '">' + year + '</option>').join(''));
 await f.getModal('Registration', body);
 capt = await f.getAPI('get_captcha');
 const imgElement = f.qs('#captcha-container');
 imgElement.style.backgroundColor = 'red';
 imgElement.src = capt.image;
 const cid = f.qs('#cid');
 cid.value = capt.capid;
}

function getModalForumNew() {
 f.getModal('New topic', f.getHTML('modal-forum-new'));
}

function logout() {
 localStorage.removeItem('libershare_session_guid');
 localStorage.removeItem('libershare_username');
 f.getPage('');
}

function searchEnter(e) {
 if (e.keyCode == 13 || e.which == 13) fullSearch();
}

function isMobileSearchActive() {
  return f.qs('#mobile-search').classList.contains('show');
}

function fullSearch() {
  if (isMobileSearchActive()) {
    if (f.qs('#mobile-search .text').value.trim() != '') f.getPage('search');
    return;
  }

  if (f.qs('#header .search .text').value.trim() != '') f.getPage('search');
}

function toggleMobileSearch() {
  if (f.qs('#mobile-search').classList.contains('show')) {
    f.qs('#mobile-search').classList.remove('show');
  } else {
    f.qs('#mobile-search').classList.add('show');
  }
}

async function playVideo(link) {
 const temp_video = f.getHTML('item-video');
 f.qs('.play').innerHTML = f.translate (temp_video, { '{SRC}': link });
}

function isElementVisible(el) {
 if (!el) return false;
 let rect = el.getBoundingClientRect();
 return (
  rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
  rect.left < (window.innerWidth || document.documentElement.clientWidth) &&
  rect.bottom > 0 &&
  rect.right > 0
 );
}

function getTextWithLinks(text) {
 const urlRegex = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#/%?=~_|!:,.;]*[-A-Z0-9+&@#/%=~_|])/gi;
 return text.replace(urlRegex, function(url) {
  return '<a href="' + url + '"  target="_blank">' + url + '</a>';
 });
}

/*
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
 } else return;
 const form = document.getElementById(formId);
 const formData = new FormData(form);
 const formObject = {};
 formData.forEach((value, key) => {
  formObject[key] = value;
 });
 f.getAPI(apiUrl, formObject)
  .then((data) => {
   if (data.error && data.error !== 0) {
    throw new Error(data.message);
   } else {
    localStorage.setItem('libershare_session_guid', data.data.sessionguid);
    localStorage.setItem('libershare_username', data.data.username);
    f.closeModalN();
    f.getPage('');
   }
  })
  .catch((error) => {
   setTimeout(() => {
    f.regenCaptcha();
   }, 50);
   const el = f.qs(errorElementId);
   el.innerHTML = `${type.charAt(0).toUpperCase() + type.slice(1)} error: ${error.message}`;
   el.style.display = 'block';
  });
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
 $.get(f.pathHTML + 'header-category.html', function(category_template) {
  $.get('get_categories', function (data) {
   let result = jQuery.parseJSON(data);
   let rows = '';
   $(result).each(function (k, v) {
    if (v.items_count - v.items_count_hidden != 0) {
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

function getPageCategory(link, itemcount, elem) {
 let cpt = '';
 let clm = '';
 $.get(f.pathHTML + 'category-load-more.html', function(data) {
  clm = data;
  $.get(f.pathHTML + 'items-item.html', function(data) {
   cpt = data;
   $.get('get_category_by_link?link=' + link, function(data) {
    let cat = jQuery.parseJSON(data);
    let catid = cat.hasOwnProperty('error_id') ? 0 : cat[0].id;
    window.page = 1;
    window.canLoadMore = true;
    $(document).ready(function() { getPageCategoryNext(itemcount, elem, cpt, clm, cat.hasOwnProperty('error_id') ? 0 : catid); });
    $(window).on('resize scroll', function() { getPageCategoryNext(itemcount, elem, cpt, clm, cat.hasOwnProperty('error_id') ? 0 : catid); });
   });
  });
 });
}

function getPageCategoryNext(itemcount, elem, item_template, item_more_template, cat_id) {
 if ($(elem).length) {
  if ($(elem).isVisible()) {
   if (window.canLoadMore) {
    window.canLoadMore = false;
    $.get('get_items?id=' + cat_id + '&count=' + itemcount + '&offset=' + ((window.page - 1) * itemcount) + '&h=2', function (data) {
     let result = jQuery.parseJSON(data);
     if (result.length != 0) {
      let rows = '';
      $(result).each(function (k, v) {
       let row = item_template;
       row = replaceAll('{LINK}', v.id + '-' + v.link, row);
       row = replaceAll('{NAME}', v.name, row);
       row = replaceAll('{IMAGE}', 'image.php?file=' + v.image_sm, row);
       rows += row + "\r\n";
      });
      $(elem).replaceWith(rows + item_more_template);
      window.page++;
      window.canLoadMore = true;
      getPageCategoryNext(itemcount, elem, item_template, item_more_template, cat_id);
     }
    });
   }
  }
 }
}

function getPageSearch(phrase, itemcount, elem) {
 let cpt = '';
 let clm = '';
 $.get(f.pathHTML + 'search-load-more.html', function(data) {
  slm = data;
  $.get(f.pathHTML + 'item.html', function(data) {
   spt = data;
   window.page = 1;
   window.canLoadMore = true;
   $(document).ready(function() { getPageSearchNext(itemcount, elem, spt, slm, phrase); });
   $(window).on('resize scroll', function() { getPageSearchNext(itemcount, elem, spt, slm, phrase); });
  });
 });
}

function getPageSearchNext(itemcount, elem, item_template, item_more_template, phrase) {
 if ($(elem).length) {
  if ($(elem).isVisible()) {
   if (window.canLoadMore) {
    window.canLoadMore = false;
    $.get('get_items?search=' + phrase + '&count=' + itemcount + '&offset=' + ((window.page - 1) * itemcount) + '&h=2', function (data) {
     let result = jQuery.parseJSON(data);
     if (result.length != 0) {
      let rows = '';
      $(result).each(function (k, v) {
       let row = item_template;
       row = replaceAll('{LINK}', v.id + '-' + v.link, row);
       row = replaceAll('{NAME}', v.name, row);
       row = replaceAll('{IMAGE}', 'image.php?file=' + v.image_sm, row);
       rows += row + "\r\n";
      });
      $(elem).replaceWith(rows + item_more_template);
      window.page++;
      window.canLoadMore = true;
      getPageSearchNext(itemcount, elem, item_template, item_more_template, phrase);
     }
    });
   }
  }
 }
}

function getPageUpload(filecount, elem) {
 $.get(f.pathHTML + 'upload-file.html', function(upload_template) {
  $.get(f.pathHTML + 'upload-load-more.html', function(upload_more_template) {
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
 $.get(f.pathHTML + 'item-video-player.html', function(data) {
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

f.qs('#files').on('change', function() {
 f.qs('#uploaders').empty();
 window.uploaders = [];
 for (let i = 0; i < this.files.length; i++) {
  AddUploader(this.files[i]);
 }
});

f.qs('#upload').click(function() {
 StartUpload(window.uploaders.shift());
 f.qs('#files-buttons').hide();
});

function AddUploader(file) {
 let uploader = $('<div>' + window.tmplUploader + '</div>').clone();
 f.qs('#uploaders').append(uploader);
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
 f.getAPI({
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
 f.getAPI({
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
 f.getAPI({
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
 f.getAPI({
  url: f.pathHTML + 'uploads-item.html',
  success: function(data) {
   window.tmplUploader = data;
  }
 });
}
*/
