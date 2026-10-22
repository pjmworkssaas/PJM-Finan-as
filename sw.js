/* Fine Gestor — uso offline. Troque a versão abaixo a cada atualização do index.html. */
var CACHE='fine-gestor-v7';
var FILES=['./','index.html','config.js','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(FILES);}).then(function(){return self.skipWaiting();}));
});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));
});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  if(new URL(e.request.url).origin!==self.location.origin)return; /* nunca guardar respostas do Supabase ou de outros sites */
  e.respondWith(
    fetch(e.request).then(function(r){
      var copy=r.clone();caches.open(CACHE).then(function(c){c.put(e.request,copy);});return r;
    }).catch(function(){return caches.match(e.request).then(function(m){return m||caches.match('index.html');});})
  );
});
