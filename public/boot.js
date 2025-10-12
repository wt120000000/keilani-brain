window.addEventListener("DOMContentLoaded", function(){
  if (window.Keilani) {
    window.Keilani.createWidget({
      mount: "#widget",
      agent: "keilani",
      apiBase: location.origin,
      theme: { brand: "#00ffcc" }
    });
  }
});
