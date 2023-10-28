document.addEventListener('DOMContentLoaded', function () {
 var loginForm = document.getElementById('login');
 if (loginForm) {
  loginForm.addEventListener('submit', function (e) {
   e.preventDefault();
   var formData = new URLSearchParams(new FormData(loginForm)).toString();
   var xhr = new XMLHttpRequest();
   xhr.open('GET', '../api/get_admin_login.php?' + formData, true);
   xhr.onload = function () {
    if (xhr.status === 200) {
     var result = JSON.parse(xhr.responseText);
     var errorElem = document.getElementById('error');
     var errorMessageElem = document.getElementById('error-message');
     if (result.error !== 0) {
      errorElem.style.display = 'block';
      var err = 'Neznámá chyba';
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
 var xhr = new XMLHttpRequest();
 xhr.open('POST', 'net_usage.php', true);
 xhr.onload = function () {
  if (xhr.status === 200) {
   document.getElementById('net').innerHTML = xhr.responseText;
  }
 };
 xhr.send();
}

function getLink() {
 var nameElem = document.getElementById('name');
 var linkElem = document.getElementById('link');
 var s = getEnglishChars(nameElem.value);
 s = s
  .replace(/[^a-zA-Z0-9]|\s+/g, '-')
  .replace(/-+/g, '-')
  .replace(/-$/g, '')
  .replace(/^-+/g, '')
  .toLowerCase();
 linkElem.value = s;
}

function getEnglishChars(str) {
 var accents = 'áàäâãåéèěëêíìïîóòöôõøúùůüûýÿžźšśčćçřŕďðťňńñĺľÁÀÄÂãåéèěëêíìïîóòöôõøúùůüûýÿžźšśčćçřŕďðťňńñĺľß';
 var english = 'aaaaaaeeeeeiiiioooooouuuuuyyzzsscccrrddtnnnllAAAAAAEEEEEIIIIOOOOOOUUUUUYYZZSSCCCRRDDTNNNLLs';
 str = str.split('');
 var i, x;
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
  case 'products':
   LoadItems('products-load-items.php', params);
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
 var elem = document.querySelector('#more');
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
    var pars = '';
    for (var p in params) pars += '&' + p + '=' + params[p];
    window.canLoadMore = false;
    var xhr = new XMLHttpRequest();
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
 var rect = element.getBoundingClientRect();
 return (rect.height > 0 || rect.width > 0) && rect.bottom >= 0 && rect.right >= 0 && rect.top <= (window.innerHeight || document.documentElement.clientHeight) && rect.left <= (window.innerWidth || document.documentElement.clientWidth);
}

function getProductsDropdown() {
 var productSearchElem = document.getElementById('products-search');
 var xhr = new XMLHttpRequest();
 xhr.open('GET', '../api/get_products_autocomplete.php?search=' + productSearchElem.value, true);
 xhr.onload = function () {
  if (xhr.status === 200) {
   var items = JSON.parse(xhr.responseText);
   var product_items = [];
   items.forEach(function (item) {
    product_items.push({ id: item.id, value: item.name });
   });

   // Autocomplete
   var autocompleteList = document.createElement('div');
   autocompleteList.setAttribute('id', 'autocomplete-list');
   autocompleteList.setAttribute('class', 'autocomplete-items');
   productSearchElem.parentNode.appendChild(autocompleteList);

   productSearchElem.addEventListener('input', function () {
    var val = this.value;
    clearAutocomplete();
    if (!val) {
     return false;
    }
    product_items.forEach(function (item) {
     if (item.value.substr(0, val.length).toUpperCase() == val.toUpperCase()) {
      var listItem = document.createElement('div');
      listItem.innerHTML = '<strong>' + item.value.substr(0, val.length) + '</strong>';
      listItem.innerHTML += item.value.substr(val.length);
      listItem.innerHTML += "<input type='hidden' value='" + item.value + "'>";
      listItem.addEventListener('click', function () {
       productSearchElem.value = this.getElementsByTagName('input')[0].value;
       setProductItem(item.id, item.value);
       clearAutocomplete();
      });
      autocompleteList.appendChild(listItem);
     }
    });
   });

   document.addEventListener('click', function (e) {
    if (e.target != productSearchElem && e.target.parentNode != productSearchElem) {
     clearAutocomplete();
    }
   });
  }
 };
 xhr.send();
}

function clearAutocomplete() {
 var autocompleteItems = document.getElementsByClassName('autocomplete-items');
 for (var i = 0; i < autocompleteItems.length; i++) {
  autocompleteItems[i].parentNode.removeChild(autocompleteItems[i]);
 }
}

function setProductItem(id, name) {
 document.getElementById('id-product').value = id;
 document.getElementById('products-search').style.display = 'none';
 var productNameElem = document.getElementById('product-name');
 productNameElem.innerHTML = '<img class="table-icon pointer" src="./template/img/no.svg" alt="Odebrat" onclick="setProductRemove();" /><div class="pl-2">' + name + '</div>';
 productNameElem.style.display = 'block';
}

function setProductRemove() {
 document.getElementById('id-product').value = '';
 document.getElementById('products-search').style.display = 'block';
 document.getElementById('product-name').style.display = 'none';
 document.getElementById('products-search').value = '';
 document.getElementById('products-search').focus();
}
