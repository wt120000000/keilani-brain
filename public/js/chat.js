/* Keilani Chat front-end (compat selectors)
 * - Streams/JSON to /api/chat
 * - Voice modes: "voice" (audio) and "avatar" (video) via /api/did-speak
 * - Flexible DOM lookups so it works with existing chat.html without strict IDs
 */

/* =========================
 *   CONFIG – UPDATE THESE
 * ========================= */
const DID_CFG = {
  VOICE_ID: "REPLACE_WITH_DID_VOICE_ID",   // D-ID voice id (your ElevenLabs voice inside D-ID)
  AVATAR_URL: "REPLACE_WITH_DID_AVATAR_URL" // Image/Video URL for the avatar (png/jpg/mp4)
};

/* =========================
 *   PERSISTENCE HELPERS
 * ========================= */
const store = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }
    catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch {}
  }
};

/* =========================
 *   COMPAT SELECTOR HELPERS
 * ========================= */
function firstOf(selectors, scope = document) {
  for (const s of selectors) {
    const n = scope.querySelector(s);
    if (n) return n;
  }
  return null;
}
function need(node, name) {
  if (!node) throw new Error(`Missing UI node: ${name}`);
  return node;
}
function $ui() {
  // FEED container
  const feed = firstOf(["#feed", ".feed", "#messages", ".messages"]);
  // COMPOSER (the whole row with textarea + send)
  const composer = firstOf(["#composer", ".composer", "form#chat-form", "form.composer", "form"]);
  // TEXTAREA inside composer (fallback to any textarea on the page)
  const input =
    (composer && firstOf(["#input", "#message", "textarea[name='message']", "textarea#composer-input", "textarea"], composer))
    || firstOf(["#input", "#message", "textarea[name='message']", "textarea#composer-input", "textarea"]);
  // SEND button inside composer
  const sendBtn =
    (composer && firstOf(["#sendBtn", "[data-send]", "button[type='submit']", "button[type='button']", "button"], composer))
    || firstOf(["#sendBtn", "[data-send]", "button[type='submit']", "button[type='button']", "button"]);

  // Top controls (these already exist in your layout)
  const model  = firstOf(["#model", "select#model", "select[name='model']"]);
  const api    = firstOf(["#api", "input#api", "input[name='api']"]);
  const token  = firstOf(["#token", "input#token", "input[name='token']", "input[placeholder*='Client Token']"]);
  const stream = firstOf(["#stream", "input#stream", "input[name='stream']"]);
  const sse    = firstOf(["#sse", "input#sse", "input[name='sse']"]);
  const voice  = firstOf(["#voice", "select#voice", "select[name='voice']"]);

  // Voice dock (auto-inject if missing)
  let voiceDock = firstOf(["#voiceDock", ".voice-dock"]);
  let voiceAudio = firstOf(["#voiceAudio", "audio#voiceAudio", "audio.voice"]);
  let voiceVideo = firstOf(["#voiceVideo", "video#voiceVideo", "video.voice"]);
  if (!voiceDock) {
    voiceDock = document.createElement("div");
    voiceDock.id = "voiceDock";
    voiceDock.style.cssText = "display:flex; gap:.75rem; align-items:center; margin:.5rem 0;";
    voiceAudio = document.createElement("audio");
    voiceAudio.id = "voiceAudio";
    voiceAudio.controls = true;
    voiceAudio.preload = "auto";
    voiceVideo = document.createElement("video");
    voiceVideo.id = "voiceVideo";
    voiceVideo.controls = true;
    voiceVideo.muted = false;
    voiceVideo.playsInline = true;
    voiceVideo.style.maxWidth = "240px";
    voiceDock.appendChild(voiceAudio);
    voiceDock.appendChild(voiceVideo);

    // place it just above the composer if possible; otherwise at the end of body
    if (composer && composer.parentElement) {
      composer.parentElement.insertBefore(voiceDock, composer);
    } else {
      document.body.appendChild(voiceDock);
    }
  }

  return {
    feed: need(feed, "feed"),
    form: need(composer || document.body, "form"),
    input: need(input, "input"),
    sendBtn: need(sendBtn, "sendBtn"),

    model: need(model, "model"),
    api: need(api, "api"),
    token: need(token, "token"),
    stream: need(stream, "stream"),
    sse: need(sse, "sse"),
    voice: need(voice, "voice"),

    voiceDock, voiceAudio, voiceVideo
  };
}

/* =========================
 *   UI RENDER HELPERS
 * ========================= */
function nowISO() {
  const d = new Date(); const z = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}
function escapeHTML(s){return s.replace(/[&<>"']/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));}
function autoscroll(feed){const nearBottom=feed.scrollHeight-feed.scrollTop-feed.clientHeight<120;if(nearBottom)feed.scrollTop=feed.scrollHeight;}

function bubble({role, html, error=false}){
  const wrap=document.createElement("div");
  wrap.className=`msg ${role}${error?" msg-error":""}`;
  wrap.innerHTML=html;
  return wrap;
}
function addUserBubble(feed, text){
  const html=`<div class="msg-head">You <span class="muted">${nowISO()}</span></div>
              <div class="msg-body">${escapeHTML(text)}</div>`;
  const n=bubble({role:"user", html}); feed.appendChild(n); autoscroll(feed);
}
function addAssistantBubble(feed, html, {error=false}={}){
  const n=bubble({role:"assistant", html, error}); feed.appendChild(n); autoscroll(feed); return n;
}
function setAssistantBody(node, html){ const b=node.querySelector(".msg-body"); if(b) b.innerHTML=html; }

/* =========================
 *   NETWORK + SSE
 * ========================= */
async function postJSON(url, body, signal){
  return fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body), signal });
}
async function readJSON(res){
  const ct=(res.headers.get("content-type")||"").toLowerCase();
  if(!ct.includes("application/json")){
    const t=await res.text().catch(()=>"(no body)");
    throw new Error(`Expected JSON, got ${ct}. Body: ${t.slice(0,800)}`);
  }
  return res.json();
}
async function readSSE(res, onChunk){
  const r=res.body.getReader(); const td=new TextDecoder(); let buf="";
  while(true){
    const {done, value}=await r.read(); if(done) break;
    buf+=td.decode(value,{stream:true});
    let i; while((i=buf.indexOf("\n\n"))>=0){
      const block=buf.slice(0,i); buf=buf.slice(i+2);
      block.split("\n").map(l=>l.trim()).filter(l=>l.startsWith("data:")).forEach(dl=>{
        const json=dl.slice(5).trim(); if(json==="[DONE]") return;
        try{ onChunk(JSON.parse(json)); }catch{ onChunk({type:"error", error:`Bad chunk: ${json}`});}
      });
    }
  }
}

/* =========================
 *   PERSISTENCE
 * ========================= */
function persistAfterUser(text){
  const cur=store.get("chat.messages", []); cur.push({role:"user", content:text}); store.set("chat.messages", cur.slice(-20));
}
function persistAfterAssistant(text){
  const cur=store.get("chat.messages", []); cur.push({role:"assistant", content:text}); store.set("chat.messages", cur.slice(-20));
}

/* =========================
 *   VOICE
 * ========================= */
function ensureMediaSession(){
  if("mediaSession" in navigator){
    navigator.mediaSession.metadata=new MediaMetadata({ title:"Keilani", artist:"Assistant", album:"Keilani" });
  }
}
async function speakWithDID({ text, mode }){
  const body={ mode, text, voice_id: DID_CFG.VOICE_ID||"", source_url: DID_CFG.AVATAR_URL||"" };
  const res=await postJSON("/api/did-speak", body);
  if(!res.ok){ const t=await res.text().catch(()=>"(no details)"); throw new Error(`D-ID speak ${res.status}: ${t}`); }
  const data=await readJSON(res);
  if(!data.ok || !data.url) throw new Error(`Bad D-ID payload: ${JSON.stringify(data).slice(0,500)}`);
  return data.url;
}
async function renderAssistant(ui, text){
  if(!text) return;
  const node=addAssistantBubble(ui.feed, `
    <div class="msg-head">Keilani <span class="muted">${nowISO()}</span></div>
    <div class="msg-body">${escapeHTML(text)}</div>
  `);
  persistAfterAssistant(text);

  const mode=(ui.voice.value||"off").toLowerCase();
  if(mode==="off") return;
  try{
    ensureMediaSession();
    if(mode==="voice"){
      const url=await speakWithDID({ text, mode:"voice" });
      ui.voiceDock.hidden=false; ui.voiceAudio.src=url; ui.voiceAudio.play().catch(()=>{});
    }else if(mode==="avatar"){
      const url=await speakWithDID({ text, mode:"avatar" });
      ui.voiceDock.hidden=false; ui.voiceVideo.src=url; ui.voiceVideo.play().catch(()=>{});
    }
  }catch(err){
    const errNode=bubble({ role:"assistant", html:`<div class="msg-body"><span class="muted">Voice error:</span> ${escapeHTML(err.message||String(err))}</div>`, error:true });
    ui.feed.appendChild(errNode); autoscroll(ui.feed);
  }
}

/* =========================
 *   SEND
 * ========================= */
function gatherPayload(ui, msgText){
  const messages=[...(store.get("chat.messages", [])), {role:"user", content:msgText}].slice(-20);
  const payload={
    model: ui.model?.value || "gpt-5",
    stream: !!(ui.stream && ui.stream.checked),
    expectSSE: !!(ui.sse && ui.sse.checked),
    messages
  };
  const tok=ui.token?.value?.trim(); if(tok) payload.client_token=tok;
  return payload;
}
async function send(ui){
  const text=ui.input.value.trim(); if(!text) return;
  addUserBubble(ui.feed, text); persistAfterUser(text); ui.input.value="";
  const aNode=addAssistantBubble(ui.feed, `<div class="msg-head">Keilani <span class="muted">${nowISO()}</span></div><div class="msg-body">…</div>`);

  const payload=gatherPayload(ui, text);
  try{
    const res=await postJSON((ui.api?.value?.trim())||"/api/chat", payload);
    if(!res.ok){ const t=await res.text().catch(()=>"(no body)"); throw new Error(`HTTP ${res.status}: ${t.slice(0,600)}`); }
    const ct=(res.headers.get("content-type")||"").toLowerCase();

    let finalText="";
    if(ct.includes("text/event-stream")){
      await readSSE(res,(chunk)=>{
        if(chunk?.choices?.[0]?.delta?.content){
          finalText+=chunk.choices[0].delta.content; setAssistantBody(aNode, escapeHTML(finalText));
        }else if(chunk?.type==="error"){
          setAssistantBody(aNode, `<span class="muted">${escapeHTML(chunk.error)}</span>`);
        }
      });
      aNode.remove(); await renderAssistant(ui, finalText);
    }else{
      const data=await readJSON(res);
      finalText = data?.choices?.[0]?.message?.content ?? "";
      if(!finalText){
        setAssistantBody(aNode, `<span class="muted">No content.</span><pre>${escapeHTML(JSON.stringify(data,null,2).slice(0,1500))}</pre>`);
        return;
      }
      aNode.remove(); await renderAssistant(ui, finalText);
    }
  }catch(err){
    setAssistantBody(aNode, `<span class="muted">Error:</span> ${escapeHTML(err.message||String(err))}`);
  }
}

/* =========================
 *   BOOT
 * ========================= */
function boot(){
  const ui=$ui();

  // restore persisted
  if(ui.api)   ui.api.value = store.get("chat.api", "/api/chat");
  if(ui.model) ui.model.value = store.get("chat.model", "gpt-5");
  if(ui.stream) ui.stream.checked = store.get("chat.stream", true);
  if(ui.sse)    ui.sse.checked = store.get("chat.sse", true);
  if(ui.voice)  ui.voice.value = store.get("chat.voice", "off");
  if(ui.token)  ui.token.value = store.get("chat.client_token", "");

  // previous conversation
  const hist=store.get("chat.messages", []);
  if(hist.length){
    hist.forEach(m=>{
      if(m.role==="user") addUserBubble(ui.feed, m.content);
      else addAssistantBubble(ui.feed, `<div class="msg-head">Keilani <span class="muted">${nowISO()}</span></div><div class="msg-body">${escapeHTML(m.content)}</div>`);
    });
  }else{
    addAssistantBubble(ui.feed, `<div class="msg-head">Keilani <span class="muted">${nowISO()}</span></div>
      <div class="msg-body">Hi! I’m here and working. What can I help you with today? • Ask a quick question • Summarize a paragraph • Generate a short code snippet • Translate a sentence</div>`);
  }

  // persist changes
  ui.api?.addEventListener("change", ()=>store.set("chat.api", ui.api.value.trim()));
  ui.model?.addEventListener("change", ()=>store.set("chat.model", ui.model.value));
  ui.stream?.addEventListener("change", ()=>store.set("chat.stream", !!ui.stream.checked));
  ui.sse?.addEventListener("change", ()=>store.set("chat.sse", !!ui.sse.checked));
  ui.voice?.addEventListener("change", ()=>store.set("chat.voice", ui.voice.value));
  ui.token?.addEventListener("change", ()=>store.set("chat.client_token", ui.token.value.trim()));

  // handlers
  ui.input.addEventListener("keydown",(e)=>{ if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); send(ui).catch(console.error); }});
  ui.sendBtn.addEventListener("click", ()=>send(ui).catch(console.error));

  console.log("[chat.js] UI found:", {
    feed: !!ui.feed, input: !!ui.input, form: !!ui.form, sendBtn: !!ui.sendBtn,
    model: !!ui.model, api: !!ui.api, token: !!ui.token, stream: !!ui.stream, sse: !!ui.sse,
    voice: !!ui.voice, voiceDock: !!ui.voiceDock, voiceVideo: !!ui.voiceVideo, voiceAudio: !!ui.voiceAudio
  });
  console.log("[chat.js] Ready. Tip: call window.__send() in console to force a send.");
  window.__send = ()=>send(ui);
}

document.addEventListener("DOMContentLoaded", ()=>{
  try { boot(); }
  catch(e){ console.error(e); alert(e.message); }
});
