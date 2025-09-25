import { Handler } from '@netlify/functions';

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }
  
  if (event.httpMethod !== "GET") {
    return { 
      statusCode: 405, 
      headers: CORS, 
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  const response = {
    status: 'ok',
    time: new Date().toISOString()
  };

  return {
    statusCode: 200,
    headers: { 
      "content-type": "application/json; charset=utf-8", 
      ...CORS 
    },
    body: JSON.stringify(response),
  };
};