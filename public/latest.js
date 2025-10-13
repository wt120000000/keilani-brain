(function(){
  function createWidget(opts){
    var root = typeof opts.mount==="string"?document.querySelector(opts.mount):opts.mount;
    root.innerHTML =
      '<div style="border:1px solid #333;border-radius:12px;padding:12px;font:14px system-ui;background:#0b0b0b;color:#eaeaea">' +
        '<div style="display:flex;gap:8px">' +
          '<input id="kw_msg" placeholder="Say hi..." style="flex:1;padding:10px;border-radius:8px;background:#111;border:1px solid #222;color:#fff"/>' +
          '<button id="kw_send" style="padding:10px 14px;border:0;border-radius:8px;background:'+(opts.theme&&opts.theme.brand||"#00ffcc")+';color:#000">Send</button>' +
        '</div>' +
        '<pre id="kw_out" style="margin-top:12px;white-space:pre-wrap;min-height:80px"></pre>' +
      '</div>';

    var out=root.querySelector("#kw_out"),
        sendBtn=root.querySelector("#kw_send"),
        input=root.querySelector("#kw_msg");
    var apiBase=opts.apiBase||location.origin;

    async function send(){
      var payload={ message: input.value, userId: "web-"+Math.random().toString(36).slice(2) };
      var res=await fetch(apiBase+"/api/chat-stream",{ method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify(payload) });
      if(!res.ok||!res.body){ out.textContent="(error: "+res.status+")"; return; }

      out.textContent = "[stream]\n";
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let gotAny = false;

      while(true){
        const {done, value} = await reader.read();
        if(done) break;
        buf += dec.decode(value, { stream:true });

        // Process complete SSE frames split by a blank line
        let idx;
        while((idx = buf.indexOf("\n\n")) !== -1){
          const frame = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if(!frame.startsWith("data:")) continue;

          const data = frame.slice(5).trim();
          if(data === "[DONE]") continue;

          try{
            const obj = JSON.parse(data);
            if(obj.type === "delta"){ out.textContent += obj.content; gotAny = true; }
            if(obj.error){ out.textContent += "\n(error: "+obj.error+")"; }
            if(opts.onEvent) opts.onEvent(obj);
          }catch(_){}
        }
      }

      if(!gotAny) out.textContent += "\n[no content received]";
    }

    sendBtn.onclick = send;
    input.addEventListener("keydown", function(e){ if(e.key==="Enter") send(); });
  }

  window.Keilani = { createWidget };
})();
