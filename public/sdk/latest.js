(function(){
  window.Keilani = window.Keilani || {};
  function createWidget(opts){
    var root = typeof opts.mount==="string" ? document.querySelector(opts.mount) : opts.mount;
    if(!root) throw new Error("mount not found");
    root.innerHTML =
      '<div style="border:1px solid #333;border-radius:12px;padding:12px;font:14px system-ui;background:#0b0b0b;color:#eaeaea">'+
        '<div style="display:flex;gap:8px">'+
          '<input id="kw_msg" placeholder="Say hi..." style="flex:1;padding:10px;border-radius:8px;background:#111;border:1px solid #222;color:#fff"/>'+
          '<button id="kw_send" style="padding:10px 14px;border-radius:8px;border:0;background:'+(opts.theme&&opts.theme.brand||"#00ffcc")+';color:#000">Send</button>'+
        '</div>'+
        '<pre id="kw_out" style="margin-top:12px;white-space:pre-wrap;min-height:80px"></pre>'+
      '</div>';

    var out = root.querySelector("#kw_out");
    var sendBtn = root.querySelector("#kw_send");
    var input = root.querySelector("#kw_msg");
    var apiBase = opts.apiBase || location.origin;

    async function send(){
      try{
        var payload = { message: input.value, userId: "web", agent: opts.agent };
        var res = await fetch(apiBase + "/api/chat-stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!res.ok || !res.body) { out.textContent = "[error]"; return; }
        var reader = res.body.getReader();
        out.textContent = "[stream]\n";
        for(;;){
          var r = await reader.read();
          if (r.done) break;
          var chunk = new TextDecoder().decode(r.value);
          chunk.split("\n\n").forEach(function(line){
            if (line.startsWith("data: ")){
              try {
                var obj = JSON.parse(line.slice(6));
                if (obj.type === "delta") out.textContent += obj.content;
                else if (obj.type === "done") out.textContent += "\n[done]";
                if (opts.onEvent) opts.onEvent(obj);
              } catch(_) {}
            }
          });
        }
      }catch(err){
        out.textContent = "(error) " + (err && err.message || err);
      }
    }

    sendBtn.onclick = send;
    input.addEventListener("keydown", function(e){ if (e.key === "Enter") send(); });
  }
  window.Keilani.createWidget = createWidget;
})();
