// Assemble OpenAI-compatible SSE responses, including split tool arguments.
export async function readCompletionStream(response){
 const message={role:'assistant',content:'',reasoning_content:''},calls=new Map();let usage=null,finish=null,buffer='',size=0;
 const decoder=new TextDecoder();
 function line(value){
  if(!value.startsWith('data:'))return;
  const text=value.slice(5).trim();if(!text||text==='[DONE]')return;
  const event=JSON.parse(text);if(event.error)throw new Error('Upstream stream error');
  if(event.usage)usage=event.usage;
  const choice=event.choices?.[0];if(!choice)return;
  if(choice.finish_reason)finish=choice.finish_reason;
  const d=choice.delta||{};message.content+=d.content||'';message.reasoning_content+=d.reasoning_content||'';
  for(const t of d.tool_calls||[]){const c=calls.get(t.index)||{id:'',type:'function',function:{name:'',arguments:''}};if(t.id)c.id=t.id;c.function.name+=t.function?.name||'';c.function.arguments+=t.function?.arguments||'';calls.set(t.index,c);}
 }
 for await(const chunk of response.body){size+=chunk.length;if(size>8*1024*1024)throw new Error('Stream too large');buffer+=decoder.decode(chunk,{stream:true});let split;while((split=buffer.indexOf('\n'))>=0){line(buffer.slice(0,split).trimEnd());buffer=buffer.slice(split+1);}}
 buffer+=decoder.decode();if(buffer.trim())line(buffer.trim());
 if(!finish)throw new Error('Incomplete completion stream');
 if(calls.size)message.tool_calls=[...calls.entries()].sort((a,b)=>a[0]-b[0]).map(([,v])=>v);
 return {choices:[{message,finish_reason:finish}],usage};
}
