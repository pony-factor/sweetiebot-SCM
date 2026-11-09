'use strict';

// The public loopback page outlives its extension host. Only the live host can
// execute a handoff; this process retains pages and observed receipts, never
// credentials or an executor. A lost host therefore cannot replay a write.
const http = require('node:http');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
let worker, ready;

async function persistentHandoff({route, backendPort, page, ttlMs}) {
  if (!worker?.connected) {
    worker = fork(__filename, [], { detached:true, execArgv:[], stdio:['ignore','ignore','ignore','ipc'],
      env:{ELECTRON_RUN_AS_NODE:'1',PATH:process.env.PATH || '/usr/bin:/bin'} });
    const child=worker;
    ready=new Promise((resolve,reject)=>{
      const onMessage=message=>{if(message?.type==='ready'){child.off('message',onMessage);resolve(message.port);}};
      child.on('message',onMessage);
      child.once('error',reject);
      child.once('exit',()=>reject(Error('The persistent handoff receiver stopped.')));
    });
    child.unref();
  }
  const child=worker;
  child.channel?.ref();
  const port=await ready, id=randomUUID();
  await new Promise((resolve,reject)=>{
    const onMessage=message=>{if(message?.id===id){child.off('message',onMessage);child.off('exit',onExit);resolve();}};
    const onExit=()=>{child.off('message',onMessage);reject(Error('The persistent handoff receiver stopped.'));};
    child.on('message',onMessage);child.once('exit',onExit);
    child.send({type:'register',id,route,backendPort,page,ttlMs});
  });
  child.channel?.unref();
  return {url:'http://127.0.0.1:'+port+route,
    retire(){if(child.connected)child.send({type:'retire',route},()=>{});}};
}
function shutdownHandoffProxy() { worker?.kill();worker=undefined;ready=undefined; }

function runReceiver() {
  const routes=new Map();
  const server=http.createServer({maxHeaderSize:16384},(request,response)=>{
    const origin='http://127.0.0.1:'+server.address().port;
    const entry=[...routes.values()].find(item=>[item.route,item.route+'/status',item.route+'/prompt',item.route+'/stage'].includes(request.url));
    const json=(status,data)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(data));};
    if(request.headers.host!==new URL(origin).host || !entry)return json(404,{error:'Unknown merge handoff.'});
    if(request.method==='POST'&&(request.headers.origin!==origin||request.headers['content-type']!=='application/json'))
      return json(403,{error:'Use the authorized local Lindsey handoff.'});
    const stopped=()=>{
      if(request.method==='GET'&&request.url===entry.route){
        response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
          'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
          'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
        return response.end(entry.page);
      }
      const error=entry.reason || 'This merge session stopped or its window reloaded. This receiver cannot execute or replay the handoff. Check the current Lindsey dashboard and GitHub state before starting a new current-base review.';
      const receipt=entry.result ? {...entry.result,continueUrl:undefined,
        continuationError:'The executor stopped. Its recorded result is shown without relaunching the next review.'} : null;
      if(request.method==='GET'&&request.url===entry.route+'/status')
        return json(200,receipt?{phase:'finished',result:receipt}:{phase:'failed',error});
      if(request.method==='POST'&&request.url===entry.route&&receipt)return json(200,receipt);
      return json(409,{error});
    };
    if(entry.retired)return stopped();
    const backendOrigin='http://127.0.0.1:'+entry.backendPort;
    const headers={...request.headers,host:new URL(backendOrigin).host};
    if(headers.origin===origin)headers.origin=backendOrigin;
    const upstream=http.request(backendOrigin+request.url,{method:request.method,headers},incoming=>{
      response.writeHead(incoming.statusCode,incoming.headers);
      const chunks=[];let size=0;
      incoming.on('data',chunk=>{size+=chunk.length;if(size<=2*1024*1024)chunks.push(chunk);});
      incoming.on('end',()=>{
        if(size>2*1024*1024)return;
        try {
          const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(incoming.statusCode===200&&request.method==='POST'&&request.url===entry.route&&Array.isArray(body.results))entry.result=body;
          if(body.phase==='finished'&&Array.isArray(body.result?.results))entry.result=body.result;
        } catch { /* Pages and incomplete responses are never receipts. */ }
      });
      incoming.pipe(response);
    });
    upstream.on('error',()=>{entry.retired=true;if(!response.headersSent)stopped();else response.end();});
    request.pipe(upstream);
  });
  process.on('message',message=>{
    if(message?.type==='register'&&/^\/lindsey-merge\/[a-f0-9-]{36}$/.test(message.route)&&
        Number.isInteger(message.backendPort)&&message.backendPort>0&&message.backendPort<65536&&
        typeof message.page==='string'){
      routes.set(message.route,{...message,expires:Date.now()+Math.min(86400000,Math.max(1000,message.ttlMs||21600000))});
      process.send?.({id:message.id});
    }
    if(message?.type==='retire'&&routes.has(message.route))routes.get(message.route).retired=true;
  });
  process.on('disconnect',()=>{});
  const timer=setInterval(()=>{
    for(const [route,entry]of routes)if(entry.expires<Date.now())routes.delete(route);
    if(!routes.size){clearInterval(timer);server.close();}
  },30000);timer.unref();
  const requestedPort=Number(process.argv[2]||0);
  server.listen(Number.isInteger(requestedPort)&&requestedPort>=0&&requestedPort<65536?requestedPort:0,
    '127.0.0.1',()=>process.send?.({type:'ready',port:server.address().port}));
}
if(require.main===module)runReceiver();
module.exports={persistentHandoff,shutdownHandoffProxy};
