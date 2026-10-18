import {addTicket,DomainError,ownerCommand,publicShop,queueSummary,stats,ticketView,makeShop,revenueReport,ownerView,membershipView,memberCardCode,ticketDisplayName,loyaltySettings,type Shop} from './domain.ts';
import {findByToken,findShop,initialize,mutate,ownedShops,allShops,insertShop,platformSettings,validatePlatform,savePlatform,findMemberByToken} from './repository.ts';
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers});}
function identity(request:Request){const id=request.headers.get('oai-authenticated-user-id');if(!id)throw new DomainError('로그인이 필요합니다.',401);return id;}
type ApiConfig={masterUserIds:string[]};
function master(request:Request,config:ApiConfig){const user=request.headers.get('oai-authenticated-user-id');return !!user&&config.masterUserIds.includes(user);}
async function owner(request:Request,shop:Shop,db:D1Database,config:ApiConfig){const user=identity(request);if(master(request,config))return;const assigned=(await ownedShops(db,user))[0];if(user!==shop.ownerId||assigned?.id!==shop.id)throw new DomainError('담당 매장만 관리할 수 있습니다.',403);}
async function body(request:Request):Promise<Record<string,unknown>>{
 const contentLength=Number(request.headers.get('content-length')??0);if(contentLength>32768)throw new DomainError('요청이 너무 큽니다.',413);
 const reader=request.body?.getReader();if(!reader)throw new DomainError('요청 내용을 확인해 주세요.');
 const chunks:Uint8Array[]=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){await reader.cancel();throw new DomainError('요청이 너무 큽니다.',413);}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try {const data=JSON.parse(new TextDecoder().decode(bytes));if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();return data;}catch{throw new DomainError('요청 내용을 확인해 주세요.');}
}
export async function handleApi(request:Request,db:D1Database,config:ApiConfig={masterUserIds:[]}):Promise<Response>{
 try{
 const url=new URL(request.url);const method=request.method;
 if(method!=='GET'&&method!=='HEAD'){
 const origin=request.headers.get('origin');if(origin&&origin!==url.origin)throw new DomainError('허용하지 않는 요청입니다.',403);
 if(request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('허용하지 않는 요청입니다.',403);
 }
 const path=url.pathname.replace(/\/$/,'');
 if(path==='/api/session'&&method==='GET'){
 const userId=request.headers.get('oai-authenticated-user-id'),assigned=userId?(await ownedShops(db,userId))[0]:undefined;
 const role=master(request,config)?'master':assigned?'owner':'customer';
 return json({role,userId,assignedShopId:assigned?.id??null,availableModes:role==='master'?['master','owner','customer']:role==='owner'?['owner','customer']:['customer'],platform:await platformSettings(db)});
 }
 if(path==='/api/master'){
 identity(request);if(!master(request,config))throw new DomainError('마스터 권한이 필요합니다.',403);
 if(method==='GET')return json({shops:(await allShops(db)).map(s=>({id:s.id,name:s.name,subtitle:s.subtitle,ownerId:s.ownerId,stats:stats(s),summary:queueSummary(s)})),platform:await platformSettings(db)});
 if(method==='POST'){
 const input=await body(request);if(input.action!=='create')throw new DomainError('작업을 확인해 주세요.');
 const name=shopName(input.name),subtitle=shopSubtitle(input.subtitle??''),ownerId=await assignment(db,input.ownerId,config);
 const shop=makeShop(ownerId,name,subtitle);await insertShop(db,shop,!config.masterUserIds.includes(ownerId));return json({shop:{id:shop.id,name:shop.name,subtitle:shop.subtitle,ownerId:shop.ownerId}},201);
 }
 if(method==='PATCH'){
 const input=await body(request);
 if(input.action==='platform'){const platform=validatePlatform(input);await savePlatform(db,platform);return json({platform});}
 if(input.action==='shop'){
 if(typeof input.shopId!=='string')throw new DomainError('매장을 확인해 주세요.');
 const name=shopName(input.name),subtitle=shopSubtitle(input.subtitle),shopId=input.shopId;
 const ownerId=await assignment(db,input.ownerId,config,shopId);
 const {shop}=await mutate(db,shopId,s=>{s.name=name;s.subtitle=subtitle;s.ownerId=ownerId;},!config.masterUserIds.includes(ownerId));
 return json({shop:{id:shop.id,name:shop.name,subtitle:shop.subtitle,ownerId:shop.ownerId}});
 }
 throw new DomainError('작업을 확인해 주세요.');
 }
 }
 if(path==='/api/salons'){
 const user=identity(request);
 const list=async()=>master(request,config)?(await allShops(db)).map(s=>({id:s.id,name:s.name,subtitle:s.subtitle})):await ownedShops(db,user);
 if(method==='GET')return json({shops:await list()});
 if(method==='POST'){
 const input=await body(request);
 if(input.action==='init'){
 const shops=await list();if(shops.length)return json({shops});
 if(!master(request,config))throw new DomainError('담당 매장 등록을 관리자에게 요청해 주세요.',403);
 return json({shops:await initialize(db,user)});
 }
 if(input.action==='create'){
 if(!master(request,config)){if((await ownedShops(db,user)).length)throw new DomainError('이미 담당 매장이 등록되어 있습니다.',409);throw new DomainError('마스터 권한이 필요합니다.',403);}
 const shop=makeShop(user,shopName(input.name));await insertShop(db,shop);return json({shops:await list()},201);
 }
 throw new DomainError('작업을 확인해 주세요.');
 }
 }
 const memberMatch=path.match(/^\/api\/members\/([^/]+)$/);
 if(memberMatch&&method==='GET'){const {shop,member}=await findMemberByToken(db,decodeURIComponent(memberMatch[1]));return json({member:{cardCode:memberCardCode(member.id),nickname:member.nickname,stamps:member.stamps,lifetimeVisits:member.lifetimeVisits},shop:{id:shop.id,name:shop.name},loyalty:loyaltySettings(shop),history:member.ledger.map(({id,kind,delta,at})=>({id,kind,delta,at}))});}
 const tokenMatch=path.match(/^\/api\/tickets\/([^/]+)$/);
 if(tokenMatch&&method==='GET'){const {shop,ticket}=await findByToken(db,decodeURIComponent(tokenMatch[1]));return json(ticketView(shop,ticket));}
 const match=path.match(/^\/api\/salons\/([^/]+)(?:\/(owner|tickets|reports))?$/);
 if(match){
 const id=decodeURIComponent(match[1]),endpoint=match[2];
 if(!endpoint&&method==='GET')return json({shop:publicShop(await findShop(db,id))});
 if(endpoint==='reports'&&method==='GET'){const shop=await findShop(db,id);await owner(request,shop,db,config);return json(revenueReport(shop,url.searchParams.get('from'),url.searchParams.get('to')));}
 if(endpoint==='owner'&&method==='GET'){
 const shop=await findShop(db,id);await owner(request,shop,db,config);
 return json(ownerView(shop));
 }
 if(endpoint==='owner'&&method==='PATCH'){
 const user=identity(request),input=await body(request);
 await owner(request,await findShop(db,id),db,config);
 const {shop}=await mutate(db,id,s=>{if(!master(request,config)&&s.ownerId!==user)throw new DomainError('매장 권한이 없습니다.',403);ownerCommand(s,input);});
 return json(ownerView(shop));
 }
 if(endpoint==='tickets'&&method==='POST'){
 const input=await body(request);const user=request.headers.get('oai-authenticated-user-id');
 const assigned=user?(await ownedShops(db,user))[0]:undefined;
 if(input.source==='owner'&&!master(request,config)&&assigned?.id!==id)throw new DomainError('담당 매장만 관리할 수 있습니다.',403);
 const platform=await platformSettings(db);
 const {shop,result:ticket}=await mutate(db,id,s=>{
 if(platform.maintenance&&!s.state.tickets.some(t=>t.requestId===input.requestId))throw new DomainError('시스템 점검 중입니다. 잠시 후 접수해 주세요.',503);
 if(s.state.tickets.length>=2000&&!s.state.tickets.some(t=>t.requestId===input.requestId))throw new DomainError('매장 접수 한도에 도달했습니다. 관리자에게 문의해 주세요.',409);
 if(input.source==='qr'&&s.state.tickets.filter(t=>!['completed','cancelled'].includes(t.status)).length>=100&&!s.state.tickets.some(t=>t.requestId===input.requestId))throw new DomainError('접수가 많습니다. 매장 직원에게 문의해 주세요.',429);
 if(input.source==='owner'&&!master(request,config)&&user!==s.ownerId)throw new DomainError('매장 권한이 필요합니다.',403);
 return addTicket(s,input,master(request,config)||user===s.ownerId&&assigned?.id===s.id);
 });
 const member=input.source==='qr'&&(input.loyaltyJoin===true||typeof input.memberToken==='string'&&input.memberToken!=='')?shop.state.members?.find(m=>m.id===ticket.memberId):undefined;
 return json({...(member?{membership:membershipView(shop,member)}:{}),ticket:{displayName:ticketDisplayName(ticket),nickname:ticket.nickname,hair:ticket.hair,token:ticket.token,number:ticket.number,status:ticket.status,items:ticket.items,total:ticket.total,duration:ticket.duration},summary:queueSummary(shop)},201);
 }
 }
 throw new DomainError('요청한 경로를 찾을 수 없습니다.',404);
 }catch(error){return error instanceof DomainError?json({error:error.message},error.status):json({error:'일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'},500);}
}

function shopName(value:unknown){if(typeof value!=='string'||!value.trim()||value.length>60)throw new DomainError('매장 이름을 확인해 주세요.');return value.trim();}
function shopSubtitle(value:unknown){if(typeof value!=='string'||value.length>160)throw new DomainError('매장 소개를 확인해 주세요.');return value.trim();}
async function assignment(db:D1Database,value:unknown,config:ApiConfig,shopId?:string){
 if(value!==undefined&&(typeof value!=='string'||value.length>200||/[\x00-\x1f]/.test(value)))throw new DomainError('사장님 계정을 확인해 주세요.');
 const ownerId=typeof value==='string'?value.trim():'';
 if(!ownerId)return 'unassigned-'+crypto.randomUUID();
 const assigned=(await allShops(db)).find(s=>s.ownerId===ownerId&&s.id!==shopId);
 if(assigned&&!config.masterUserIds.includes(ownerId))throw new DomainError('이미 다른 매장을 담당하는 계정입니다.',409);
 return ownerId;
}
