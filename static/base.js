(function () {
  var B = window.BASE || '';
  window.BASE = B;
  if (window.self !== window.top) document.documentElement.classList.add('embed');
  function fix(u) {
    return (typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/') ? B + u : u;
  }
  if (window.fetch) {
    var f = window.fetch;
    window.fetch = function (u, o) { return f.call(this, fix(u), o); };
  }
  if (window.axios) {
    axios.interceptors.request.use(function (c) { c.url = fix(c.url); return c; });
  }
})();
