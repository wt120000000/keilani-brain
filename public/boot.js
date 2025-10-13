document.addEventListener('DOMContentLoaded', function(){
  if(window.Keilani){
    window.Keilani.createWidget({
      mount: '#widget',
      apiBase: location.origin,
      theme: { brand: '#00ffcc' }
    });
  } else {
    console.error('Keilani SDK not found (latest.js).');
  }
});
