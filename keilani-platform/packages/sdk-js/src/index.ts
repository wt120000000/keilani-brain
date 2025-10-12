export type WidgetOptions = {
  mount: string | HTMLElement;
  agent: string;
  apiBase?: string;
  theme?: { brand?: string };
  features?: { voice?: boolean; memory?: boolean };
  onEvent?: (evt: any) => void;
};

export function createWidget(opts: WidgetOptions) {
  const root = typeof opts.mount === "string" ? document.querySelector(opts.mount)! : opts.mount;
  root.innerHTML = `
    <div style="border:1px solid #333;border-radius:12px;padding:12px;font:14px system-ui;background:#0b0b0b;color:#eaeaea">
      <div style="display:flex;gap:8px">
        <input id="kw_msg" placeholder="Say hi..." style="flex:1;padding:10px;border-radius:8px;background:#111;border:1px solid #222;color:#fff"/>
        <button id="kw_send" style="padding:10px 14px;border-radius:8px;border:0;background:${opts.theme?.brand ?? "#00ffcc"};color:#000">Send</button>
      </div>
      <pre id="kw_out" style="margin-top:12px;white-space:pre-wrap;min-height:80px"></pre>
    </div>
  `;

  const out = root.querySelector<HTMLPreElement>("#kw_out")!;
  const sendBtn = root.querySelector<HTMLButtonElement>("#kw_send")!;
  const input = root.querySelector<HTMLInputElement>("#kw_msg")!;
  const apiBase = opts.apiBase || location.origin;

  async function send() {
    const payload = { message: input.value, agent: opts.agent };
    const res = await fetch(`${apiBase}/api/chat-stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    out.textContent = "[stream]\n";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = new TextDecoder().decode(value);
      chunk.split("\\n\\n").forEach(line => {
        if (line.startsWith("data: ")) {
          const obj = JSON.parse(line.slice(6));
          if (obj.type === "delta") out.textContent += obj.content;
          if (obj.type === "done") out.textContent += "\\n[done]";
          opts.onEvent?.(obj);
        }
      });
    }
  }

  sendBtn.onclick = send;
  input.addEventListener("keydown", (e) => (e.key === "Enter" ? send() : null));
}
export const Keilani = { createWidget };