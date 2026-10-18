import { env } from 'cloudflare:workers';
import { handleApi } from './api';
export function route(request:Request){
 const db=(env as unknown as {DB?:D1Database}).DB;
 if(!db)return new Response(JSON.stringify({error:'데이터베이스가 준비되지 않았습니다.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 const masterUserIds=((env as unknown as {MASTER_USER_IDS?:string}).MASTER_USER_IDS??'').split(',').map(s=>s.trim()).filter(Boolean);
 return handleApi(request,db,{masterUserIds});
}
