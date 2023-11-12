document.addEventListener('DOMContentLoaded', function () {
 let loginForm = f.qs('#login');
 if (loginForm) {
  loginForm.addEventListener('submit', function (e) {
   e.preventDefault();
   let formData = new URLSearchParams(new FormData(loginForm)).toString();
   let xhr = new XMLHttpRequest();
   xhr.open('GET', '/api/get_admin_login.php?' + formData, true);
   xhr.onload = function () {
    if (xhr.status === 200) {
     let result = JSON.parse(xhr.responseText);
     let errorElem = f.qs('#error');
     let errorMessageElem = f.qs('#error-message');
     if (result.error !== 0) {
      errorElem.style.display = 'block';
      let err = 'Neznámá chyba';
      switch (result.error) {
       case 1:
        err = 'Špatně zadané uživatelské jméno!';
        break;
       case 2:
        err = 'Špatně zadané heslo!';
        break;
      }
      errorMessageElem.textContent = err;
     } else {
      window.location.href = './';
     }
    }
   };
   xhr.send();
  });
 }
});

function getNetworkUsage() {
 let xhr = new XMLHttpRequest();
 xhr.open('POST', 'net_usage.php', true);
 xhr.onload = function () {
  if (xhr.status === 200) {
   f.qs('#net').innerHTML = xhr.responseText;
  }
 };
 xhr.send();
}

function getLink() {
 let nameElem = f.qs('#name');
 let linkElem = f.qs('#link');
 let s = getEnglishChars(nameElem.value);
 s = s
  .replace(/[^a-zA-Z0-9]|\s+/g, '-')
  .replace(/-+/g, '-')
  .replace(/-$/g, '')
  .replace(/^-+/g, '')
  .toLowerCase();
 linkElem.value = s;
}

function getEnglishChars(str) {
 let accents = 'áàäâãåéèěëêíìïîóòöôõøúùůüûýÿžźšśčćçřŕďðťňńñĺľÁÀÄÂãåéèěëêíìïîóòöôõøúùůüûýÿžźšśčćçřŕďðťňńñĺľß';
 let english = 'aaaaaaeeeeeiiiioooooouuuuuyyzzsscccrrddtnnnllAAAAAAEEEEEIIIIOOOOOOUUUUUYYZZSSCCCRRDDTNNNLLs';
 str = str.split('');
 let i, x;
 for (i = 0; i < str.length; i++) {
  if ((x = accents.indexOf(str[i])) != -1) {
   str[i] = english[x];
  }
 }
 return str.join('');
}

function confirmDelete(link, name) {
 if (confirm('Opravdu chcete smazat ' + name + '?')) {
  window.location = './' + link;
 }
}

function GetPage(page, params) {
 switch (page) {
  case 'categories':
   LoadItems('categories-load-items.php', params);
   break;
  case 'items':
   LoadItems('items-load-items.php', params);
   break;
  case 'files':
   LoadItems('files-load-items.php', params);
   break;
  case 'uploads':
   LoadItems('uploads-load-items.php', params);
   break;
  case 'search':
   LoadItems('search-load-items.php', params);
   break;
  case 'log':
   LoadItems('log-load-items.php', params);
   break;
 }
}

function LoadItems(file, params) {
 let elem = f.qs('#more');
 window.page = 1;
 window.canLoadMore = true;
 LoadMoreHTML(elem, file, params);
 window.addEventListener('resize', function () {
  LoadMoreHTML(elem, file, params);
 });
 window.addEventListener('scroll', function () {
  LoadMoreHTML(elem, file, params);
 });
}

function LoadMoreHTML(elem, file, params) {
 if (elem) {
  if (isVisible(elem)) {
   if (window.canLoadMore) {
    let pars = '';
    for (let p in params) pars += '&' + p + '=' + params[p];
    window.canLoadMore = false;
    let xhr = new XMLHttpRequest();
    xhr.open('GET', file + '?page=' + window.page + pars, true);
    xhr.onload = function () {
     if (xhr.status === 200) {
      elem.outerHTML = xhr.responseText;
      window.page += 1;
      window.canLoadMore = true;
      LoadMoreHTML(elem, file, params);
     }
    };
    xhr.send();
   }
  }
 }
}

function isVisible(element) {
 let rect = element.getBoundingClientRect();
 return (rect.height > 0 || rect.width > 0) && rect.bottom >= 0 && rect.right >= 0 && rect.top <= (window.innerHeight || document.documentElement.clientHeight) && rect.left <= (window.innerWidth || document.documentElement.clientWidth);
}

function getItemsDropdown() {
 let itemSearchElem = f.qs('#items-search');
 let xhr = new XMLHttpRequest();
 xhr.open('GET', '/api/get_items_autocomplete.php?search=' + itemSearchElem.value, true);
 xhr.onload = function () {
  if (xhr.status === 200) {
   let items = JSON.parse(xhr.responseText);
   let item_items = [];
   items.forEach(function (item) {
    item_items.push({ id: item.id, value: item.name });
   });

   // Autocomplete
   let autocompleteList = document.createElement('div');
   autocompleteList.setAttribute('id', 'autocomplete-list');
   autocompleteList.setAttribute('class', 'autocomplete-items');
   itemSearchElem.parentNode.appendChild(autocompleteList);

   itemSearchElem.addEventListener('input', function () {
    let val = this.value;
    clearAutocomplete();
    if (!val) {
     return false;
    }
    item_items.forEach(function (item) {
     if (item.value.substr(0, val.length).toUpperCase() == val.toUpperCase()) {
      let listItem = document.createElement('div');
      listItem.innerHTML = '<strong>' + item.value.substr(0, val.length) + '</strong>';
      listItem.innerHTML += item.value.substr(val.length);
      listItem.innerHTML += "<input type='hidden' value='" + item.value + "'>";
      listItem.addEventListener('click', function () {
       itemSearchElem.value = this.getElementsByTagName('input')[0].value;
       setItem(item.id, item.value);
       clearAutocomplete();
      });
      autocompleteList.appendChild(listItem);
     }
    });
   });

   document.addEventListener('click', function (e) {
    if (e.target != itemSearchElem && e.target.parentNode != itemSearchElem) {
     clearAutocomplete();
    }
   });
  }
 };
 xhr.send();
}

function clearAutocomplete() {
 let autocompleteItems = f.qsa('.autocomplete-items');
 for (let i = 0; i < autocompleteItems.length; i++) {
  autocompleteItems[i].parentNode.removeChild(autocompleteItems[i]);
 }
}

function setItem(id, name) {
 f.qs('#id-item').value = id;
 f.qs('#items-search').style.display = 'none';
 let itemNameElem = f.qs('#item-name');
 itemNameElem.innerHTML = '<img class="table-icon pointer" src="img/no.svg" alt="Odebrat" onclick="setItemRemove();" /><div class="pl-2">' + name + '</div>';
 itemNameElem.style.display = 'block';
}

function setItemRemove() {
 f.qs('#id-item').value = '';
 f.qs('#items-search').style.display = 'block';
 f.qs('#item-name').style.display = 'none';
 f.qs('#items-search').value = '';
 f.qs('#items-search').focus();
}
