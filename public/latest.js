<script>
// (If you're pasting in the file, keep only the JS body — no <script> tags)
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
      var res=await fetch(apiBase+"/api/chat-stream",{
        method:"POST",
        headers:{ "content-type":"application/json" },
        body:JSON.stringify(payload)
      });
      if(!res.ok||!res.body){ out.textContent="(error: "+res.status+")"; return; }

      out.textContent = "[stream]\n";
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let gotAny = false;

      // helper: extract one SSE event from buffer (handles \n, \r\n and \r)
      function takeEvent(){
        // split on blank line (any newline style)
        const m = buf.match(/([\s\S]*?)(?:\r?\n|\r)\s*(?:\r?\n|\r)/);
        if(!m) return null;
        const chunk = m[1];
        buf = buf.slice(m[0].length);
        // gather all "data:" lines (there may be multiple)
        const datas = [];
        chunk.split(/\r?\n|\r/).forEach(line=>{
          const dm = line.match(/^\s*data:\s?(.*)$/);
          if(dm) datas.push(dm[1]);
        });
        return datas.length ? datas.join("\n") : "";
      }

      while(true){
        const {done, value} = await reader.read();
        if(done) break;
        buf += dec.decode(value, { stream:true });

        // process as many complete events as we have
        for(;;){
          const payload = takeEvent();
          if(payload === null) break; // no full event yet
          if(payload === "" || payload === "[DONE]") continue;

          try{
            const obj = JSON.parse(payload);
            if(obj.type === "delta"){ out.textContent += obj.content; gotAny = true; }
            if(obj.error){ out.textContent += "\n(error: "+obj.error+")"; }
            if(opts.onEvent) opts.onEvent(obj);
          }catch(_){
            // Log non-JSON frames to help debugging
            console.debug("SSE payload:", payload);
          }
        }
      }

      if(!gotAny) out.textContent += "\n[no content received]";
    }

    sendBtn.onclick = send;
    input.addEventListener("keydown", function(e){ if(e.key==="Enter") send(); });
  }
  window.Keilani = { createWidget };
})();
</script>
