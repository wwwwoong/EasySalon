import {schedulerState,schedulerCommand,validateProfile,assertExistingFits} from './scheduler.ts';
import {analyzeInterview,type SchedulerAI} from './scheduler-ai.ts';
import {addReservation,availability,bookingSettings,manageReservation,reservationReceipt,cancelOwnReservation,ownerReservations} from './reservations.ts';
import {addTicket,DomainError,ownerCommand,publicShop,queueSummary,stats,ticketView,makeShop,revenueReport,ownerView,membershipView,memberCardCode,ticketDisplayName,loyaltySettings,type Shop} from './domain.ts';
import {findByToken,findShop,initialize,mutate,ownedShops,allShops,insertShop,platformSettings,validatePlatform,savePlatform,findMemberByToken,findReservationByToken} from './repository.ts';
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers});}
function identity(request:Request){const id=request.headers.get('oai-authenticated-user-id');if(!id)throw new DomainError('로그인이 필요합니다.',401);return id;}
type ApiConfig={masterUserIds:string[];schedulerAI?:SchedulerAI};
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
 const schedulerPath=path.match(/^\/api\/salons\/([^/]+)\/scheduler$/);
 if(schedulerPath){
 const id=decodeURIComponent(schedulerPath[1]),shop=await findShop(db,id);await owner(request,shop,db,config);
 if(method==='GET')return json({scheduler:schedulerState(shop),aiAvailable:!!config.schedulerAI?.key&&!!config.schedulerAI?.model});
 const input=await body(request),user=identity(request);
 if(method==='PATCH'){
 const result=await mutate(db,id,s=>{if(!master(request,config)&&s.ownerId!==user)throw new DomainError('매장 권한이 없습니다.',403);schedulerCommand(s,input);});
 return json({scheduler:schedulerState(result.shop)});
 }
 if(method==='POST'){
 if(input.action==='preview'){
 const profile=validateProfile(input.profile,shop);assertExistingFits(shop,profile);
 const candidate=structuredClone(shop),state=schedulerState(candidate);state.active=profile;candidate.state.scheduler=state;
 return json({before:availability(shop,input.date,input.serviceIds),after:availability(candidate,input.date,input.serviceIds)});
 }
 if(input.action!=='interview')throw new DomainError('인터뷰 작업을 확인해 주세요.');
 if(!config.schedulerAI?.key||!config.schedulerAI.model)throw new DomainError('AI 연결 준비 중입니다. 마스터가 서버에 AI 키와 모델을 설정해야 합니다. 인터뷰와 운영표 직접 입력은 사용할 수 있습니다.',503);
 if(typeof input.interview!=='string'||!input.interview.trim()||input.interview.length>6000)throw new DomainError('인터뷰 답변을 6000자 이내로 입력해 주세요.');
 const reserved=await mutate(db,id,s=>{if(!master(request,config)&&s.ownerId!==user)throw new DomainError('매장 권한이 없습니다.',403);const state=schedulerState(s);if(Date.now()-(state.aiRequestedAt??0)<60000)throw new DomainError('AI 분석은 1분 간격으로 요청해 주세요.',429);state.aiRequestedAt=Date.now();s.state.scheduler=state;});
 const analysis=await analyzeInterview(reserved.shop,input.interview,config.schedulerAI);
 const result=await mutate(db,id,s=>{if(s.revision!==reserved.shop.revision)throw new DomainError('분석 중 매장 정보가 변경되었습니다. 최신 정보를 확인하고 다시 분석해 주세요.',409);if(!master(request,config)&&s.ownerId!==user)throw new DomainError('매장 권한이 없습니다.',403);const state=schedulerState(s);state.draft=analysis.profile;state.interview=input.interview as string;state.questions=analysis.questions;s.state.scheduler=state;});
 return json({scheduler:schedulerState(result.shop),summary:analysis.summary});
 }
 }
 const bookingToken=path.match(/^\/api\/reservations\/([^/]+)$/);
 if(bookingToken&&(method==='GET'||method==='PATCH')){
 const token=decodeURIComponent(bookingToken[1]);const found=await findReservationByToken(db,token);
 if(method==='GET')return json({reservation:reservationReceipt(found.shop,found.reservation)});
 const input=await body(request);if(input.action!=='cancel')throw new DomainError('예약 작업을 확인해 주세요.');
 const {shop,result}=await mutate(db,found.shop.id,s=>cancelOwnReservation(s,token));
 return json({reservation:reservationReceipt(shop,result)});
 }
 const bookingPath=path.match(/^\/api\/salons\/([^/]+)\/reservations$/);
 if(bookingPath){
 const id=decodeURIComponent(bookingPath[1]);
 if(method==='GET'){
 const shop=await findShop(db,id);
 if(url.searchParams.get('manage')==='1'){await owner(request,shop,db,config);return json({settings:bookingSettings(shop),reservations:ownerReservations(shop)});}
 if(!url.searchParams.has('date'))return json({settings:bookingSettings(shop)});
 return json(availability(shop,url.searchParams.get('date'),url.searchParams.getAll('serviceId')));
 }
 if(method==='POST'){
 const input=await body(request),platform=await platformSettings(db);
 const {shop,result}=await mutate(db,id,s=>{if(platform.maintenance&&!s.state.reservations?.some(r=>r.requestId===input.requestId))throw new DomainError('시스템 점검 중입니다. 잠시 후 예약해 주세요.',503);return addReservation(s,input);});
 return json({reservation:reservationReceipt(shop,result)},201);
 }
 if(method==='PATCH'){
 const user=identity(request),input=await body(request);await owner(request,await findShop(db,id),db,config);
 const {shop}=await mutate(db,id,s=>{if(!master(request,config)&&s.ownerId!==user)throw new DomainError('매장 권한이 없습니다.',403);manageReservation(s,input);});
 return json({settings:bookingSettings(shop),reservations:ownerReservations(shop)});
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
