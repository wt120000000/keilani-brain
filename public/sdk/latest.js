(function(){
  function createWidget(opts){
    var root = typeof opts.mount==="string"?document.querySelector(opts.mount):opts.mount;
    root.innerHTML='<div style="border:1px solid #333;border-radius:12px;padding:12px;font:14px system-ui;background:#0b0b0b;color:#eaeaea"><div style="display:flex;gap:8px"><input id="kw_msg" placeholder="Say hi..." style="flex:1;padding:10px;border-radius:8px;background:#111;border:1px solid #222;color:#fff"/><button id="kw_send" style="padding:10px 14px;border-radius:8px;border:0;background:'+(opts.theme&&opts.theme.brand||"#00ffcc")+';color:#000">Send</button></div><pre id="kw_out" style="margin-top:12px;white-space:pre-wrap;min-height:80px"></pre></div>';
    var out=root.querySelector("#kw_out"), send=root.querySelector("#kw_send"), input=root.querySelector("#kw_msg");
    var apiBase=opts.apiBase||"";
    async function sendMsg(){
      var payload={message:input.value,agent:opts.agent};
      var res=await fetch(apiBase+"/api/chat-stream",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
      if(!res.ok||!res.body){ out.textContent="(error)"; return; }
      var reader=res.body.getReader(); out.textContent="[stream]\n";
      while(true){ var r=await reader.read(); if(r.done)break;
        var chunk=new TextDecoder().decode(r.value);
        chunk.split("\n\n").forEach(function(line){
          if(line.startsWith("data: ")){ var obj=JSON.parse(line.slice(6));
            if(obj.type==="delta") out.textContent+=obj.content;
            if(obj.type==="done") out.textContent+="\n[done]";
          }
        });
      }
    }
    send.onclick=sendMsg; input.addEventListener("keydown",function(e){ if(e.key==="Enter") sendMsg();});
  }
  window.Keilani={ createWidget };
})();