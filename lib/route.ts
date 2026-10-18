import { env } from 'cloudflare:workers';
import { handleApi } from './api';
export function route(request:Request){
 const db=(env as unknown as {DB?:D1Database}).DB;
 if(!db)return new Response(JSON.stringify({error:'데이터베이스가 준비되지 않았습니다.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 const masterUserIds=((env as unknown as {MASTER_USER_IDS?:string}).MASTER_USER_IDS??'').split(',').map(s=>s.trim()).filter(Boolean);
 const aiEnv=env as unknown as {SCHEDULER_AI_KEY?:string;SCHEDULER_AI_MODEL?:string};
 return handleApi(request,db,{masterUserIds,...(aiEnv.SCHEDULER_AI_KEY&&aiEnv.SCHEDULER_AI_MODEL?{schedulerAI:{key:aiEnv.SCHEDULER_AI_KEY,model:aiEnv.SCHEDULER_AI_MODEL}}:{})});
}
