(function(){
  function getUID(){
    try{
      const KEY = "keilani_uid";
      let v = localStorage.getItem(KEY);
      if(!v){ v = "anon-" + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)); localStorage.setItem(KEY, v); }
      return v;
    }catch{ return "anon-" + Math.random().toString(36).slice(2); }
  }

  function createWidget(opts){
    const root = typeof opts.mount==="string" ? document.querySelector(opts.mount) : opts.mount;
    root.innerHTML =
      '<div style="border:1px solid #333;border-radius:12px;padding:12px;font:14px system-ui;background:#0b0b0b;color:#eaeaea">'+
      '<div style="display:flex;gap:8px">'+
      '<input id="kw_msg" placeholder="Say hi..." style="flex:1;padding:10px;border-radius:8px;background:#111;border:1px solid #222;color:#fff"/>'+
      '<button id="kw_send" style="padding:10px 14px;border-radius:8px;border:0;background:'+(opts.theme&&opts.theme.brand||"#00ffcc")+';color:#000">Send</button>'+
      '</div><pre id="kw_out" style="margin-top:12px;white-space:pre-wrap;min-height:80px"></pre></div>';

    const out = root.querySelector("#kw_out");
    const input = root.querySelector("#kw_msg");
    const sendBtn = root.querySelector("#kw_send");

    async function send(){
      const payload = { message: input.value, agent: opts.agent || "keilani", userId: getUID() };
      const res = await fetch((opts.apiBase||"") + "/api/chat-stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if(!res.ok || !res.body){
        let detail=""; try{ detail = await res.text(); }catch{}
        out.textContent = `(error ${res.status}${detail?`: ${detail}`:""})`;
        return;
      }
      out.textContent = "[stream]\n";
      const reader = res.body.getReader();
      const td = new TextDecoder();
      while(true){
        const {done, value} = await reader.read(); if(done) break;
        td.decode(value).split("\n\n").forEach(line=>{
          if(line.startsWith("data: ")){
            const obj = JSON.parse(line.slice(6));
            if(obj.type==="delta") out.textContent += obj.content;
            if(obj.type==="done")  out.textContent += "\n[done]";
          }
        });
      }
    }

    sendBtn.onclick = send;
    input.addEventListener("keydown", e => e.key==="Enter" && send());
  }

  window.Keilani = { createWidget };
})();
