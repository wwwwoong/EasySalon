export type Option = {id:string;name:string;values:{id:string;name:string;color?:string}[]};
export type HairSelection = {gender:'female'|'male'|'consult';length:'short'|'medium'|'long'|'consult'};
export type Service = {audience?:'all'|'female'|'male';hairLengthEnabled?:boolean;id:string;name:string;description:string;price:number;duration:number;category:string;icon:string;options:Option[]};
export type Status = 'pending'|'waiting'|'called'|'serving'|'held'|'completed'|'cancelled';
export type LoyaltySettings={enabled:boolean;target:number;benefit:string};
export type Member={id:string;token:string;nickname:string;stamps:number;lifetimeVisits:number;ledger:{id:string;kind:'earn'|'redeem';delta:number;ticketId?:string;at:number;requestId?:string}[]};
export type Ticket = {nickname?:string;displayName?:string;memberId?:string;loyaltyEligible?:boolean;loyaltyEarned?:boolean;hair?:HairSelection;id:string;token:string;requestId:string;requestSignature:string;queueOrder?:number;priceConfirmed?:boolean;number:number;status:Status;items:{name:string;price:number;duration:number;options:string[]}[];total:number;duration:number;createdAt:number;startedAt?:number;completedAt?:number;calledAt?:number;remainingAt?:number;remainingMinutes?:number;consult:boolean;previousStatus?:Status;audit:{at:number;action:string;before?:number;after?:number}[]};
export type Shop = {id:string;ownerId:string;name:string;subtitle:string;menu:Service[];settings:{loyalty?:LoyaltySettings;phase:'open'|'paused'|'closed';thresholds:{busy:number;veryBusy:number};comboDiscount:number};state:{members?:Member[];tickets:Ticket[];nextNumber:number};revision:number;updatedAt:number};
export class DomainError extends Error {status:number;constructor(message:string,status=400){super(message);this.status=status;}}
export const defaultMenu:Service[] = [
{id:'mens-cut',name:'남성 커트',description:'깔끔하게 다듬는 나만의 스타일',price:18000,duration:20,category:'커트',icon:'scissors',options:[{id:'style',name:'스타일',values:[{id:'natural',name:'내추럴'},{id:'dandy',name:'댄디'},{id:'crop',name:'크롭'}]}]},
{id:'womens-cut',name:'여성 커트',description:'길이와 분위기에 맞는 디자인',price:25000,duration:30,category:'커트',icon:'scissors',options:[{id:'style',name:'스타일',values:[{id:'layered',name:'레이어드'},{id:'bob',name:'단발'},{id:'natural',name:'내추럴'}]}]},
{id:'color',name:'염색',description:'원하는 색으로 기분 전환',price:65000,duration:80,category:'컬러',icon:'palette',options:[{id:'color',name:'색상',values:[{id:'brown',name:'내추럴 브라운',color:'#725044'},{id:'ash',name:'애쉬 브라운',color:'#8b8479'},{id:'black',name:'블랙',color:'#292524'},{id:'wine',name:'와인',color:'#773b49'}]}]},
{id:'perm',name:'디자인 펌',description:'자연스럽게 살아나는 볼륨',price:80000,duration:100,category:'펌',icon:'waves',options:[{id:'style',name:'스타일',values:[{id:'natural',name:'내추럴'},{id:'volume',name:'볼륨'},{id:'wave',name:'웨이브'}]}]},
{id:'care',name:'두피 · 모발 케어',description:'건강한 머릿결을 위한 휴식',price:35000,duration:30,category:'케어',icon:'sparkles',options:[]},
];
export function makeShop(ownerId:string,name='오브헤어',subtitle='오늘의 나에게, 새로운 분위기'):Shop{return {id:crypto.randomUUID(),ownerId,name,subtitle,menu:defaultMenu.map(s=>({...structuredClone(s),audience:s.id==='mens-cut'?'male':s.id==='womens-cut'?'female':'all',hairLengthEnabled:true})),settings:{phase:'open',thresholds:{busy:40,veryBusy:90},comboDiscount:5000},state:{tickets:[],nextNumber:1},revision:0,updatedAt:Date.now()};}
const liveStatuses:Status[]=['waiting','called','serving'];
const terminals:Status[]=['completed','cancelled'];
export function remaining(t:Ticket,now:number):number|null {
 if(t.status==='called') return now-(t.calledAt??t.createdAt)>10*60000?null:t.duration;
 if(t.status!=='serving')return t.duration;
 const at=t.remainingAt??t.startedAt??now;
 const duration=t.remainingMinutes??t.duration;
 const elapsed=(now-at)/60000;
 return elapsed>=duration?null:Math.max(0,Math.ceil(duration-elapsed));
}
export function queueSummary(shop:Shop,now=Date.now()){
 const active=shop.state.tickets.filter(t=>liveStatuses.includes(t.status));
 const values=active.map(t=>remaining(t,now));
 const known=values.every(v=>v!==null);
 const total=known?values.reduce<number>((sum,v)=>sum+(v??0),0):null;
 const unavailable=shop.settings.phase!=='open';
 return {waiting:active.filter(t=>t.status==='waiting'||t.status==='called').length,serving:active.filter(t=>t.status==='serving').length,waitMin:unavailable?null:total,waitMax:unavailable||total===null?null:Math.ceil(total*1.2+5),congestion:shop.settings.phase==='closed'?'마감':shop.settings.phase==='paused'?'접수 중지':total===null?'확인 중':total>=shop.settings.thresholds.veryBusy?'매우혼잡':total>=shop.settings.thresholds.busy?'혼잡':'여유',updatedAt:shop.updatedAt};
}
export function publicShop(shop:Shop){return {id:shop.id,name:shop.name,subtitle:shop.subtitle,menu:shop.menu.map(s=>({...s,audience:s.audience??'all',hairLengthEnabled:s.hairLengthEnabled??true})),settings:{phase:shop.settings.phase,thresholds:shop.settings.thresholds,comboDiscount:shop.settings.comboDiscount,loyalty:loyaltySettings(shop)},summary:queueSummary(shop)};}
export function addTicket(shop:Shop,input:Record<string,unknown>,owner:boolean,now=Date.now()):Ticket {
 if(typeof input.requestId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId))throw new DomainError('접수 요청을 다시 시도해 주세요.');
 const nickname=validateNickname(input.nickname);
 if(input.loyaltyJoin!==undefined&&typeof input.loyaltyJoin!=='boolean')throw new DomainError('적립 선택을 확인해 주세요.');
 const member=resolveMember(shop,input.memberToken);
 if(input.loyaltyJoin===true&&input.source!=='qr')throw new DomainError('적립 가입은 고객 화면에서 진행해 주세요.');
 const hair=validateHair(input.hair);
 const signature=JSON.stringify({nickname,loyaltyJoin:input.loyaltyJoin===true,memberId:member?.id??null,...(hair?{hair}:{}),serviceIds:Array.isArray(input.serviceIds)?[...input.serviceIds].sort():input.serviceIds,options:input.options&&typeof input.options==='object'?Object.entries(input.options).sort(([a],[b])=>a.localeCompare(b)):input.options,consult:input.consult===true,source:input.source});
 if(shop.state.members?.some(m=>m.ledger.some(e=>e.requestId===input.requestId)))throw new DomainError('같은 요청의 내용이 다릅니다.',409);
 const existing=shop.state.tickets.find(t=>t.requestId===input.requestId);if(existing){if(existing.requestSignature!==signature)throw new DomainError('같은 접수 요청의 내용이 다릅니다.',409);if(input.source==='owner'&&!owner)throw new DomainError('매장 권한이 필요합니다.',403);return existing;}
 if(shop.settings.phase!=='open')throw new DomainError('현재 접수를 받지 않고 있습니다.',409);
 if(input.source!=='qr'&&input.source!=='owner')throw new DomainError('접수 경로가 올바르지 않습니다.');
 if(input.source==='owner'&&!owner)throw new DomainError('매장 권한이 필요합니다.',403);
 if(!Array.isArray(input.serviceIds)||input.serviceIds.length===0||input.serviceIds.length>5||new Set(input.serviceIds).size!==input.serviceIds.length)throw new DomainError('메뉴를 선택해 주세요.');
 const opts=input.options&&typeof input.options==='object'&&!Array.isArray(input.options)?input.options as Record<string,unknown>:{};
 const used=new Set<string>();
 const items=input.serviceIds.map(id=>{
 const s=shop.menu.find(m=>m.id===id);if(!s)throw new DomainError('제공하지 않는 메뉴입니다.');
 const options=s.options.flatMap(o=>{const key=`${s.id}:${o.id}`;used.add(key);const chosen=opts[key];if(chosen===undefined||chosen==='')return [];const value=o.values.find(v=>v.id===chosen);if(!value)throw new DomainError('선택 옵션을 확인해 주세요.');return [`${o.name}: ${value.name}`];});
 if(hair&&s.hairLengthEnabled!==false){options.push(hairLabel(hair));}
 return {name:s.name,price:s.price,duration:s.duration,options};
 });
 if(Object.keys(opts).some(k=>!used.has(k)))throw new DomainError('선택 옵션을 확인해 주세요.');
 const combo=input.serviceIds.includes('color')&&(input.serviceIds.includes('mens-cut')||input.serviceIds.includes('womens-cut'));
 let linked=member;
 if(input.loyaltyJoin===true&&!linked){
 if(!loyaltySettings(shop).enabled)throw new DomainError('현재 매장에서 적립 가입을 받지 않습니다.',409);
 if(!nickname)throw new DomainError('적립에 사용할 닉네임을 입력해 주세요.');
 if((shop.state.members?.length??0)>=500)throw new DomainError('적립 고객 한도에 도달했습니다.',409);
 let memberId=crypto.randomUUID();while(shop.state.members?.some(m=>memberCardCode(m.id)===memberCardCode(memberId)))memberId=crypto.randomUUID();
 linked={id:memberId,token:crypto.randomUUID()+crypto.randomUUID(),nickname,stamps:0,lifetimeVisits:0,ledger:[]};
 (shop.state.members??=[]).push(linked);
 }
 if(linked&&nickname)linked.nickname=nickname;
 const ticket:Ticket={nickname:nickname||undefined,displayName:nickname||`손님${shop.state.nextNumber}`,memberId:linked?.id,loyaltyEligible:!!linked&&loyaltySettings(shop).enabled,loyaltyEarned:false,...(hair?{hair}:{}),id:crypto.randomUUID(),token:crypto.randomUUID()+crypto.randomUUID(),requestId:input.requestId,requestSignature:signature,queueOrder:input.source==='owner'?Math.max(0,...shop.state.tickets.map(t=>t.queueOrder??0))+1:undefined,number:shop.state.nextNumber++,status:input.source==='owner'?'waiting':'pending',items,total:Math.max(0,items.reduce((s,i)=>s+i.price,0)-(combo?shop.settings.comboDiscount:0)),duration:items.reduce((s,i)=>s+i.duration,0),createdAt:now,consult:input.consult===true,audit:[]};
 shop.state.tickets.push(ticket);return ticket;
}
const transitions:Partial<Record<string,Partial<Record<Status,Status>>>>={approve:{pending:'waiting'},call:{waiting:'called'},start:{waiting:'serving',called:'serving'},complete:{serving:'completed'},hold:{waiting:'held',called:'held'},resume:{held:'waiting'},cancel:{pending:'cancelled',waiting:'cancelled',called:'cancelled',held:'cancelled'}};
export function ownerCommand(shop:Shop,input:Record<string,unknown>,now=Date.now()){
 const action=String(input.action);
 if(action==='profile'){const name=profileText(input.name,60,false),subtitle=profileText(input.subtitle,160,true);shop.name=name;shop.subtitle=subtitle;return;}
 if(action==='loyalty'){shop.settings.loyalty=validateLoyalty(input);return;}
 if(action==='redeem'){redeem(shop,input,now);return;}
 if(action==='settings'){if(!['open','paused','closed'].includes(String(input.phase)))throw new DomainError('영업 상태를 확인해 주세요.');shop.settings.phase=input.phase as Shop['settings']['phase'];return;}
 if(action==='menu'){shop.menu=validateMenu(input.menu);return;}
 const ticket=shop.state.tickets.find(t=>t.id===input.ticketId);if(!ticket)throw new DomainError('접수를 찾을 수 없습니다.',404);
 if(action==='price'){
 if(ticket.status==='cancelled')throw new DomainError('취소한 접수는 변경할 수 없습니다.',409);
 if(typeof input.price!=='number'||!Number.isInteger(input.price)||input.price<0||input.price>10000000)throw new DomainError('금액을 확인해 주세요.');
 ticket.audit.push({at:now,action,before:ticket.total,after:input.price});ticket.total=input.price;ticket.priceConfirmed=true;return;
 }
 if(ticket.status==='completed'&&action==='complete')earnStamp(shop,ticket,now);
 if((ticket.status==='completed'&&action==='complete'&&(input.price===undefined||input.price===ticket.total))||(ticket.status==='cancelled'&&action==='cancel'))return;
 if(terminals.includes(ticket.status))throw new DomainError('종료된 접수는 상태를 변경할 수 없습니다.',409);
 if(action==='remaining'){
 if(ticket.status!=='serving'||typeof input.minutes!=='number'||!Number.isInteger(input.minutes)||input.minutes<0||input.minutes>600)throw new DomainError('남은 시간을 확인해 주세요.');
 ticket.remainingAt=now;ticket.remainingMinutes=input.minutes;ticket.audit.push({at:now,action,after:input.minutes});return;
 }
 const target=transitions[action]?.[ticket.status];if(!target)throw new DomainError('현재 상태에서 할 수 없는 작업입니다.',409);
 if((target==='called'||target==='serving')&&shop.state.tickets.some(t=>t.id!==ticket.id&&(t.status==='called'||t.status==='serving')))throw new DomainError('진행 중인 고객을 먼저 완료해 주세요.',409);
 if(target==='completed'&&ticket.consult&&!ticket.priceConfirmed&&input.price===undefined)throw new DomainError('상담 고객의 최종 금액을 먼저 확인해 주세요.',409);
 if(target==='completed'&&input.price!==undefined){if(typeof input.price!=='number'||!Number.isInteger(input.price)||input.price<0||input.price>10000000)throw new DomainError('금액을 확인해 주세요.');ticket.audit.push({at:now,action:'price',before:ticket.total,after:input.price});ticket.total=input.price;ticket.priceConfirmed=true;}
 ticket.audit.push({at:now,action});ticket.status=target;
 if(target==='waiting')ticket.queueOrder=Math.max(0,...shop.state.tickets.map(t=>t.queueOrder??0))+1;
 if(target==='called')ticket.calledAt=now;
 if(target==='serving')ticket.startedAt=now;
 if(target==='completed'||target==='cancelled')ticket.completedAt=now;
 if(target==='completed')earnStamp(shop,ticket,now);
}
export function validateMenu(value:unknown):Service[]{
 if(!Array.isArray(value)||value.length>30)throw new DomainError('메뉴는 최대 30개까지 등록할 수 있습니다.');
 const seen=new Set<string>();return value.map(v=>{
 if(!v||typeof v!=='object')throw new DomainError('메뉴 형식이 올바르지 않습니다.');
 const s=v as Service;
 if(typeof s.id!=='string'||!s.id||s.id.length>80||seen.has(s.id)||typeof s.name!=='string'||!s.name.trim()||s.name.length>60||!Number.isInteger(s.price)||s.price<0||s.price>10000000||!Number.isInteger(s.duration)||s.duration<1||s.duration>600||typeof s.description!=='string'||s.description.length>300||typeof s.category!=='string'||s.category.length>60||typeof s.icon!=='string'||s.icon.length>60||!Array.isArray(s.options)||s.options.length>6)throw new DomainError('메뉴 이름, 가격, 시간을 확인해 주세요.');seen.add(s.id);
 const ids=new Set<string>();for(const o of s.options){if(!o||typeof o.id!=='string'||!o.id||o.id.length>80||ids.has(o.id)||typeof o.name!=='string'||o.name.length>60||!Array.isArray(o.values)||o.values.length>20)throw new DomainError('옵션을 확인해 주세요.');ids.add(o.id);const vids=new Set<string>();for(const v of o.values){if(!v||typeof v.id!=='string'||!v.id||v.id.length>80||vids.has(v.id)||typeof v.name!=='string'||v.name.length>60||(v.color!==undefined&&!/^#[0-9a-f]{6}$/i.test(v.color)))throw new DomainError('옵션 값을 확인해 주세요.');vids.add(v.id);}}
 if(s.audience!==undefined&&!['all','female','male'].includes(s.audience))throw new DomainError('메뉴 대상을 확인해 주세요.');
 if(s.hairLengthEnabled!==undefined&&typeof s.hairLengthEnabled!=='boolean')throw new DomainError('머리 길이 설정을 확인해 주세요.');
 return {audience:s.audience??'all',hairLengthEnabled:s.hairLengthEnabled??true,id:s.id,name:s.name.trim(),description:s.description,price:s.price,duration:s.duration,category:s.category,icon:s.icon,options:structuredClone(s.options)};
 });
}
export function stats(shop:Shop,now=Date.now()){
 const day=(v:number)=>new Date(v+9*3600000).toISOString().slice(0,10);
 const today=shop.state.tickets.filter(t=>t.status==='completed'&&t.completedAt&&day(t.completedAt)===day(now));
 const intervals=shop.state.tickets.filter(t=>t.startedAt&&(t.status==='completed'||t.status==='serving'||t.status==='cancelled')).map(t=>[Math.max(t.startedAt!,Date.parse(day(now)+'T00:00:00+09:00')),Math.min(t.completedAt??now,now)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);
 let end=0,ms=0;for(const [a,b] of intervals){ms+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}
 const summary=queueSummary(shop,now);
 return {waiting:summary.waiting,serving:summary.serving,completed:today.length,revenue:today.reduce((s,t)=>s+t.total,0),expectedRevenue:shop.state.tickets.filter(t=>['pending','waiting','called','serving'].includes(t.status)).reduce((s,t)=>s+t.total,0),workMinutes:Math.round(ms/60000)};
}
export function ticketView(shop:Shop,ticket:Ticket,now=Date.now()){
 const before=(ticket.status==='called'||ticket.status==='serving'?[]:shop.state.tickets).filter(t=>liveStatuses.includes(t.status)&&t.id!==ticket.id&&(t.status==='serving'||t.status==='called'||(t.queueOrder??t.number)<(ticket.queueOrder??ticket.number)));
 const waits=before.map(t=>remaining(t,now));
 const wait=['pending','held','cancelled','completed'].includes(ticket.status)||shop.settings.phase!=='open'||waits.some(v=>v===null)?null:waits.reduce<number>((s,v)=>s+(v??0),0);
 return {ticket:{displayName:ticketDisplayName(ticket),nickname:ticket.nickname,hair:ticket.hair,token:ticket.token,number:ticket.number,status:ticket.status,items:ticket.items,total:ticket.total,duration:ticket.duration,createdAt:ticket.createdAt},ahead:before.length,waitMin:wait,waitMax:wait===null?null:Math.ceil(wait*1.2+5),shop:{id:shop.id,name:shop.name},notifications:ticket.status==='called'?[{id:ticket.id+'-called',message:'순서가 되었습니다. 매장 직원에게 말씀해 주세요.',channel:'in-app',createdAt:ticket.calledAt}]:[]};
}

export function validateHair(value:unknown):HairSelection|undefined {
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError('머리 길이를 확인해 주세요.');
 const {gender,length}=value as HairSelection;
 if(!['female','male','consult'].includes(gender)||!['short','medium','long','consult'].includes(length)||gender==='male'&&length==='long'||gender==='consult'&&length!=='consult')throw new DomainError('머리 길이를 확인해 주세요.');
 return {gender,length};
}
export function hairLabel(hair:HairSelection){
 const gender={female:'여성',male:'남성',consult:'상담 후 결정'}[hair.gender];
 const length={short:'짧은 길이',medium:'중간 길이',long:'긴 길이',consult:'길이 상담'}[hair.length];
 return hair.gender==='consult'?gender:`${gender} · ${length}`;
}
export function parseReportRange(from:unknown,to:unknown){
 function day(value:unknown){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new DomainError('조회 날짜를 확인해 주세요.');
 const utc=Date.parse(value+'T00:00:00Z');
 if(!Number.isFinite(utc)||new Date(utc).toISOString().slice(0,10)!==value)throw new DomainError('조회 날짜를 확인해 주세요.');
 return utc-9*3600000;
 }
 const start=day(from),end=day(to),count=(end-start)/86400000+1;
 if(count<1||count>366)throw new DomainError('조회 기간은 최대 366일입니다.');
 return {from:from as string,to:to as string,start,end:end+86400000,count};
}
export function revenueReport(shop:Shop,from:unknown,to:unknown){
 const range=parseReportRange(from,to);
 const daily=Array.from({length:range.count},(_,i)=>({date:new Date(range.start+9*3600000+i*86400000).toISOString().slice(0,10),revenue:0,completed:0}));
 const items=new Map<string,{name:string;revenue:number;completed:number}>();
 const tickets=shop.state.tickets.filter(t=>t.status==='completed'&&t.completedAt!==undefined&&t.completedAt>=range.start&&t.completedAt<range.end);
 let workMs=0;
 for(const ticket of tickets){
 const row=daily[Math.floor((ticket.completedAt!-range.start)/86400000)];row.revenue+=ticket.total;row.completed++;
 const name=ticket.items.map(i=>i.name).join(' + '),item=items.get(name)??{name,revenue:0,completed:0};item.revenue+=ticket.total;item.completed++;items.set(name,item);
 if(ticket.startedAt!==undefined)workMs+=Math.max(0,ticket.completedAt!-ticket.startedAt);
 }
 return {from:range.from,to:range.to,revenue:tickets.reduce((sum,t)=>sum+t.total,0),completed:tickets.length,workMinutes:Math.round(workMs/60000),daily,items:[...items.values()].sort((a,b)=>b.revenue-a.revenue)};
}

export function ticketDisplayName(ticket:Ticket){return ticket.displayName||ticket.nickname||`손님${ticket.number}`;}
export function loyaltySettings(shop:Shop):LoyaltySettings{return {...{enabled:false,target:10,benefit:'적립 혜택은 매장에 문의해 주세요.'},...shop.settings.loyalty};}
function profileText(value:unknown,max:number,empty:boolean){if(typeof value!=='string')throw new DomainError('매장 이름과 소개를 확인해 주세요.');const text=empty?value.replace(/\r\n?/g,'\n'):value;const controls=empty?/[\x00-\x09\x0b-\x1f\x7f]/:/[\x00-\x1f\x7f]/;if((!empty&&!text.trim())||[...text].length>max||controls.test(text))throw new DomainError('매장 이름과 소개를 확인해 주세요.');return text.trim();}
export function validateNickname(value:unknown):string{if(value===undefined)return '';if(typeof value!=='string'||[...value.trim()].length>20||/[\x00-\x1f\x7f-\x9f]/.test(value))throw new DomainError('닉네임은 20자 이내로 입력해 주세요.');return value.trim();}
export function validateLoyalty(input:Record<string,unknown>):LoyaltySettings{if(typeof input.enabled!=='boolean'||typeof input.target!=='number'||!Number.isInteger(input.target)||input.target<1||input.target>100||typeof input.benefit!=='string'||[...input.benefit].length>160||/[\x00-\x1f\x7f]/.test(input.benefit))throw new DomainError('적립 설정을 확인해 주세요.');return {enabled:input.enabled,target:input.target,benefit:input.benefit.trim()};}
function resolveMember(shop:Shop,token:unknown){if(token===undefined||token==='')return undefined;if(typeof token!=='string'||!validCapability(token))throw new DomainError('적립 정보를 찾을 수 없습니다.',404);const member=shop.state.members?.find(m=>m.token===token);if(!member)throw new DomainError('적립 정보를 찾을 수 없습니다.',404);return member;}
export function validCapability(token:string){return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token);}
function earnStamp(shop:Shop,ticket:Ticket,now:number){if(!ticket.loyaltyEligible||!ticket.memberId)return;const member=shop.state.members?.find(m=>m.id===ticket.memberId);if(!member)return;if(ticket.loyaltyEarned||member.ledger.some(e=>e.kind==='earn'&&e.ticketId===ticket.id)){ticket.loyaltyEarned=true;return;}if(member.ledger.length>=4000)throw new DomainError('적립 기록 한도에 도달했습니다. 관리자에게 문의해 주세요.',409);member.stamps++;member.lifetimeVisits++;member.ledger.push({id:crypto.randomUUID(),kind:'earn',delta:1,ticketId:ticket.id,at:now});ticket.loyaltyEarned=true;}
function redeem(shop:Shop,input:Record<string,unknown>,now:number){if(typeof input.requestId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId))throw new DomainError('혜택 사용 요청을 확인해 주세요.');const prior=shop.state.members?.flatMap(m=>m.ledger.map(e=>({m,e}))).find(({e})=>e.requestId===input.requestId);if(prior){if(prior.m.id!==input.memberId||prior.e.kind!=='redeem')throw new DomainError('같은 요청의 내용이 다릅니다.',409);return;}if(shop.state.tickets.some(t=>t.requestId===input.requestId))throw new DomainError('같은 요청의 내용이 다릅니다.',409);const config=loyaltySettings(shop),member=shop.state.members?.find(m=>m.id===input.memberId);if(!member)throw new DomainError('적립 고객을 찾을 수 없습니다.',404);if(!config.enabled||member.stamps<config.target)throw new DomainError('사용 가능한 적립이 부족하거나 중지되었습니다.',409);if(member.ledger.length>=4000)throw new DomainError('적립 기록 한도에 도달했습니다.',409);member.stamps-=config.target;member.ledger.push({id:crypto.randomUUID(),kind:'redeem',delta:-config.target,at:now,requestId:input.requestId});}
export function memberCardCode(id:string){return id.replace(/-/g,'').slice(0,12).toUpperCase().match(/.{1,4}/g)!.join('-');}
export function membershipView(shop:Shop,member:Member){return {cardCode:memberCardCode(member.id),token:member.token,nickname:member.nickname,stamps:member.stamps,lifetimeVisits:member.lifetimeVisits,target:loyaltySettings(shop).target,benefit:loyaltySettings(shop).benefit};}
export function ownerView(shop:Shop){return {shop:{id:shop.id,name:shop.name,subtitle:shop.subtitle,menu:shop.menu,settings:{...shop.settings,loyalty:loyaltySettings(shop)}},tickets:shop.state.tickets.map(t=>({...t,displayName:ticketDisplayName(t)})),members:(shop.state.members??[]).map(({id,nickname,stamps,lifetimeVisits})=>({id,cardCode:memberCardCode(id),nickname,stamps,lifetimeVisits})),stats:stats(shop),notifications:[]};}
