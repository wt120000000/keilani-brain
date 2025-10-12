"use client";
import { useEffect } from "react";

export default function AgentPage({ params }: { params: { agent: string } }) {
  useEffect(() => {
    // @ts-ignore
    if (window.Keilani) window.Keilani.createWidget({ mount: "#widget", agent: params.agent, apiBase: location.origin, theme:{brand:"#00ffcc"}});
  }, [params.agent]);
  return (
    <div>
      <h1>{params.agent}</h1>
      <div id="widget" />
    </div>
  );
}