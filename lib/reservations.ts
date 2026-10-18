import {addTicket,DomainError,parseReportRange,validCapability,type Shop,type Ticket} from './domain.ts';
export type BookingSettings={enabled:boolean;weekdays:number[];startTime:string;endTime:string;interval:number;noticeMinutes:number};
export type Reservation={id:string;token:string;requestId:string;signature:string;realName:string;phone:string;startsAt:number;endsAt:number;createdAt:number;status:'booked'|'cancelled'|'checkedIn'|'noShow';ticketId?:string;items:Ticket['items'];total:number;duration:number;hair?:Ticket['hair'];consult:boolean};
export const defaultBookingSettings:BookingSettings={enabled:false,weekdays:[1,2,3,4,5],startTime:'10:00',endTime:'19:00',interval:30,noticeMinutes:60};
export const bookingSettings=(shop:Shop):BookingSettings=>structuredClone(shop.settings.reservations??defaultBookingSettings);
export const koreaDay=(time:number)=>new Date(time+9*3600000).toISOString().slice(0,10);
function minutes(value:unknown){if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw new DomainError('예약 시간을 확인해 주세요.');return Number(value.slice(0,2))*60+Number(value.slice(3));}
export function validateBookingSettings(input:Record<string,unknown>):BookingSettings{
 if(typeof input.enabled!=='boolean'||!Array.isArray(input.weekdays)||input.weekdays.some(n=>!Number.isInteger(n)||n<0||n>6)||new Set(input.weekdays).size!==input.weekdays.length||input.enabled&&!input.weekdays.length||![10,15,20,30,60].includes(Number(input.interval))||typeof input.interval!=='number'||typeof input.noticeMinutes!=='number'||!Number.isInteger(input.noticeMinutes)||input.noticeMinutes<0||input.noticeMinutes>1440)throw new DomainError('예약 요일과 시간 설정을 확인해 주세요.');
 if(minutes(input.startTime)>=minutes(input.endTime))throw new DomainError('예약 종료 시간은 시작 시간보다 늦어야 합니다.');
 return {enabled:input.enabled,weekdays:[...input.weekdays].sort(),startTime:input.startTime as string,endTime:input.endTime as string,interval:input.interval,noticeMinutes:input.noticeMinutes};
}
function menuSnapshot(shop:Shop,input:Record<string,unknown>,now:number){
 const scratch=structuredClone(shop);scratch.settings.phase='open';scratch.state={tickets:[],nextNumber:1};
 return addTicket(scratch,{requestId:crypto.randomUUID(),source:'owner',serviceIds:input.serviceIds,options:input.options??{},hair:input.hair,consult:true},true,now);
}
export function availability(shop:Shop,date:unknown,serviceIds:unknown,now=Date.now()){
 const settings=bookingSettings(shop);const range=parseReportRange(date,date);const day=String(date);
 const diff=(range.start-Date.parse(koreaDay(now)+'T00:00:00+09:00'))/86400000;
 if(diff<0||diff>60)throw new DomainError('예약 날짜는 오늘부터 60일 이내로 선택해 주세요.');
 const duration=menuSnapshot(shop,{serviceIds},now).duration;
 const weekday=new Date(range.start+9*3600000).getUTCDay();
 const reason=!settings.enabled?'이 매장은 현재 예약을 받지 않아요.':!settings.weekdays.includes(weekday)?'이 요일은 예약 없이 방문 접수로 운영해요.':'';
 const slots:number[]=[];
 if(!reason)for(let minute=minutes(settings.startTime);minute+duration<=minutes(settings.endTime);minute+=settings.interval){
 const start=range.start+minute*60000,end=start+duration*60000;
 if(start<now+settings.noticeMinutes*60000||start<=now)continue;
 if((shop.state.reservations??[]).some(r=>['booked','checkedIn'].includes(r.status)&&r.startsAt<end&&r.endsAt>start))continue;
 slots.push(start);
 }
 return {settings,date:day,duration,slots,reason};
}
export function addReservation(shop:Shop,input:Record<string,unknown>,now=Date.now()):Reservation{
 if(typeof input.requestId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId))throw new DomainError('예약 요청을 다시 시도해 주세요.');
 if(typeof input.realName!=='string'||!input.realName.trim()||[...input.realName.trim()].length>40||/[\x00-\x1f\x7f]/.test(input.realName))throw new DomainError('예약자 실명을 40자 이내로 입력해 주세요.');
 if(typeof input.phone!=='string'||!/^[0-9 -]+$/.test(input.phone))throw new DomainError('연락 가능한 전화번호를 입력해 주세요.');
 const phone=input.phone.replace(/[ -]/g,'');if(!/^0\d{8,10}$/.test(phone))throw new DomainError('전화번호를 확인해 주세요.');
 if(input.privacyConsent!==true)throw new DomainError('예약 관리와 연락을 위한 이름·전화번호 수집에 동의해 주세요.');
 if(typeof input.startsAt!=='number'||!Number.isSafeInteger(input.startsAt)||input.startsAt<0||input.startsAt>8640000000000000)throw new DomainError('예약 시간을 선택해 주세요.');
 const signature=JSON.stringify({realName:input.realName.trim(),phone,startsAt:input.startsAt,serviceIds:Array.isArray(input.serviceIds)?[...input.serviceIds].sort():input.serviceIds,options:input.options??{},hair:input.hair??null});
 const prior=shop.state.reservations?.find(r=>r.requestId===input.requestId);
 if(prior){if(prior.signature!==signature)throw new DomainError('같은 예약 요청의 내용이 다릅니다.',409);return prior;}
 if((shop.state.reservations?.length??0)>=2000)throw new DomainError('예약 기록 한도에 도달했습니다. 매장에 문의해 주세요.',409);
 const day=koreaDay(input.startsAt),open=availability(shop,day,input.serviceIds,now);
 if(!open.slots.includes(input.startsAt))throw new DomainError(open.reason||'이미 예약되었거나 선택할 수 없는 시간입니다. 다른 시간을 골라 주세요.',409);
 const snapshot=menuSnapshot(shop,input,now);
 const reservation:Reservation={id:crypto.randomUUID(),token:crypto.randomUUID()+crypto.randomUUID(),requestId:input.requestId,signature,realName:input.realName.trim(),phone,startsAt:input.startsAt,endsAt:input.startsAt+snapshot.duration*60000,createdAt:now,status:'booked',items:snapshot.items,total:snapshot.total,duration:snapshot.duration,hair:snapshot.hair,consult:true};
 (shop.state.reservations??=[]).push(reservation);return reservation;
}
export function reservationReceipt(shop:Shop,r:Reservation){const ticket=shop.state.tickets.find(t=>t.id===r.ticketId);return {token:r.token,realName:r.realName,phoneMasked:r.phone.slice(0,3)+'-****-'+r.phone.slice(-4),startsAt:r.startsAt,endsAt:r.endsAt,status:r.status,items:r.items,total:r.total,duration:r.duration,shop:{id:shop.id,name:shop.name},...(ticket?{ticketToken:ticket.token,ticketStatus:ticket.status}:{} )};}
export function manageReservation(shop:Shop,input:Record<string,unknown>,now=Date.now()){
 if(input.action==='settings'){shop.settings.reservations=validateBookingSettings(input);return;}
 const r=shop.state.reservations?.find(r=>r.id===input.reservationId);if(!r)throw new DomainError('예약을 찾을 수 없습니다.',404);
 if(input.action==='cancel'||input.action==='noShow'){
 const target=input.action==='cancel'?'cancelled':'noShow';if(r.status===target)return;
 if(r.status!=='booked')throw new DomainError('대기표로 전환했거나 종료된 예약입니다.',409);
 if(target==='noShow'&&now<r.startsAt)throw new DomainError('예약 시간이 지난 후 미방문 처리할 수 있습니다.',409);
 r.status=target;return;
 }
 if(input.action==='checkIn'){
 if(r.status==='checkedIn')return;
 if(r.status!=='booked')throw new DomainError('취소·미방문 예약은 방문 처리할 수 없습니다.',409);
 if(koreaDay(now)!==koreaDay(r.startsAt)||now<r.startsAt-30*60000)throw new DomainError('예약 당일, 예약 시간 30분 전부터 방문 처리할 수 있습니다.',409);
 if(shop.state.tickets.length>=2000)throw new DomainError('접수 기록 한도에 도달했습니다.',409);
 const ticket:Ticket={id:crypto.randomUUID(),token:crypto.randomUUID()+crypto.randomUUID(),requestId:r.id,requestSignature:'reservation:'+r.id,number:shop.state.nextNumber++,displayName:r.realName,status:'waiting',queueOrder:Math.max(0,...shop.state.tickets.map(t=>t.queueOrder??0))+1,items:structuredClone(r.items),total:r.total,duration:r.duration,hair:r.hair,consult:r.consult,createdAt:now,audit:[{at:now,action:'reservation-check-in'}]};
 shop.state.tickets.push(ticket);r.ticketId=ticket.id;r.status='checkedIn';return;
 }
 throw new DomainError('예약 작업을 확인해 주세요.');
}
export function cancelOwnReservation(shop:Shop,token:string,now=Date.now()){
 if(!validCapability(token))throw new DomainError('예약을 찾을 수 없습니다.',404);
 const r=shop.state.reservations?.find(r=>r.token===token);if(!r)throw new DomainError('예약을 찾을 수 없습니다.',404);
 if(r.status==='cancelled')return r;
 if(r.status!=='booked'||now>=r.startsAt)throw new DomainError('예약 시간이 지났거나 방문 처리되었습니다. 취소는 매장에 문의해 주세요.',409);
 r.status='cancelled';return r;
}
export function ownerReservations(shop:Shop){return (shop.state.reservations??[]).map(({token,signature,requestId,...r})=>({...r,ticketStatus:shop.state.tickets.find(t=>t.id===r.ticketId)?.status})).sort((a,b)=>a.startsAt-b.startsAt);}
