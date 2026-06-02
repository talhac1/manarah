(function () {
  if (sessionStorage.getItem('manarah_auth') !== '1') {
    var isSubdir = location.pathname.indexOf('/khateebs/') !== -1;
    location.replace(isSubdir ? '../login.html' : 'login.html');
  }
})();
