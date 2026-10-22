#!/usr/bin/env node
// Synthetic transport fixture, never a provider or collaboration E2E.
const prompt = process.argv[process.argv.indexOf('--print') + 1];
if(prompt==='model-check'&&process.argv[process.argv.indexOf('--model')+1]!=='gemini-3.8-flash-high')process.exit(7);
let preparedRead=false, preparedRequest;
try{preparedRequest=JSON.parse(prompt);preparedRead=preparedRequest.task?.title?.startsWith('read-profile');}catch{}
if (prompt === 'hang') setInterval(()=>{},1000);
else if (prompt === 'overflow') process.stdout.write('x'.repeat(10000));
else if (prompt === 'stderr-overflow') process.stderr.write('x'.repeat(10000));
else if (prompt === 'failure') { process.stdout.write('partial'); process.exitCode = 2; }
else if (prompt === 'bad') process.stdout.write('{}\n');
else if (prompt === 'read-profile'||preparedRead) {
  const id='aaaaaaaa-0000-4000-8000-000000000007';
  const step=(step_index,step_type,state,extra={})=>({event:'step_update',step_update:{conversation_id:id,step_index,step_type,state,...extra}});
  const info={name:'view_file',parameters:{AbsolutePath:process.cwd()+(preparedRead?'/test.cjs':'/fixture.txt')}};
  let answer=preparedRead?JSON.stringify({...preparedRequest.expected,
    verdict:preparedRequest.task.title.includes('invalid')?'WRONG':preparedRequest.task.title.includes('request-changes')?'REQUEST_CHANGES':'PASS'}):'OK';
  if(preparedRead&&preparedRequest.task.title.includes('fenced'))answer='```json\n'+answer+'\n```';
  const rows=[{event:'init',conversation_id:id,init:{cwd:process.cwd(),tools:['view_file'],permission_mode:'request-review'}},
    step(0,'user_input','DONE'),step(1,'agent_response','DONE'),
    step(2,'tool','ACTIVE',{tool_name:'view_file',tool_info:info}),
    step(2,'tool','DONE',{tool_name:'view_file',tool_info:{...info,output:'synthetic only'}}),
    step(3,'agent_response','ACTIVE',{text_delta:answer}),step(3,'agent_response','DONE',{text_delta:'\n'}),
    {event:'result',result:{conversation_id:id,status:'SUCCESS',response:answer+'\n',duration_seconds:1,num_turns:1,usage:{}}}];
  for(const row of rows)process.stdout.write(JSON.stringify(row)+'\n');
}
else {
  if (Object.keys(process.env).some(key=>key.startsWith('ORCA_'))) process.exit(3);
  const id = 'aaaaaaaa-0000-4000-8000-000000000007';
  const rows = [
    {event:'init',conversation_id:id,init:{cwd:process.cwd(),tools:[],permission_mode:'request-review'}},
    {event:'step_update',step_update:{conversation_id:id,step_index:0,state:'DONE',step_type:'user_input'}},
    {event:'step_update',step_update:{conversation_id:id,step_index:1,state:'ACTIVE',step_type:'agent_response',text_delta:'OK'}},
    {event:'step_update',step_update:{conversation_id:id,step_index:1,state:'DONE',step_type:'agent_response',text_delta:'\n'}},
    {event:'result',result:{conversation_id:id,status:'SUCCESS',response:'OK\n',duration_seconds:1,num_turns:1,usage:{}}},
  ];
  for (const row of rows) process.stdout.write(JSON.stringify(row)+'\n');
}
